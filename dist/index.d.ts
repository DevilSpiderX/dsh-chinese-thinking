/**
 * dsh-chinese-thinking — Host 插件：让模型的思考（内部推理）过程始终以中文呈现。
 *
 * 三层机制（默认只使用前两层，零额外模型请求）：
 *   1. 提示词层：在系统提示词末尾注入一段精简规则，劝导模型原生中文思考。
 *      末尾位置利用 recency；模型听从时零翻译开销。
 *   2. 不遵从监测：只读检查 reasoning block 开头，发现真正的英文句子就把进程级
 *      `escalated` 置位，下一次系统提示词追加强化规则。不修改输出、不发模型请求。
 *   3. 可选翻译层（translate: true）：监听 `llm/stream` waterfall。每个 reasoning block
 *      先做一次语言探测：中文思考按原 token 粒度透传；只有“自然语言英文”才按批翻译。
 *      路径、类名、代码、命令不参与语言比例统计，避免把“中文夹代码”误判为外语。
 *
 * 为什么挂在 `llm/stream` 上：宿主内所有模型调用（主会话、子代理、工作流、session-title、
 * compaction、retry 重试）都走 `ctx.llm.stream()` 同一个入口；监听器注册在宿主上下文且
 * `global: true`，因此与具体会话、模型、窗口、工作区无关。
 *
 * 韧性设计：
 *   - 已是中文的 block 直接透传，不发起任何翻译调用；
 *   - 翻译只针对真正的外语散文，连续片段按 batchChars 合并；失败/超时一律回退原文；
 *   - 翻译路由硬失败（无适配器 / 无凭证 / 鉴权失败）记入黑名单，避免每句重试；
 *   - 翻译请求选择该路由可用的最低 reasoning 档并限制输出长度，防止翻译模型偷偷思考；
 *   - 翻译结果有进程内 LRU 缓存；翻译后 reasoning 的签名失效，`finish` chunk 的
 *     replayState 会剥离签名字段，走适配器官方降级路径；
 *   - 翻译请求自身带 WeakSet 标记，不会递归触发翻译。
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
/** 插件可调配置（cordis.patch.yml 的 row config）。 */
export interface Config {
    /** 是否启用，默认 true。 */
    enabled: boolean;
    /** 系统提示词段落排序；默认放在 deployment:persona-suffix 之后。 */
    order?: number;
    /** 覆盖默认指令全文。 */
    text?: string;
    /** 是否保留系统提示词劝导段，默认 true。 */
    promptEnabled: boolean;
    /** 是否启用额外模型调用做中文翻译；默认 false（零额外请求，靠提示词与自动强化）。 */
    translate: boolean;
    /** 翻译用 provider，空 = 跟随被翻译的请求。 */
    translationProvider?: string;
    /** 翻译用 model，空 = 跟随被翻译的请求；建议指定廉价非思考模型。 */
    translationModel?: string;
    /** 触发一次翻译的最小缓冲字符数，默认 24。 */
    minChars: number;
    /** 单个片段的最大字符数（硬切上限），默认 480。 */
    maxChars: number;
    /** 连续外语片段累计到该长度再合批翻译；默认 400，0 = 逐片翻译。 */
    batchChars: number;
    /** 汉字在“汉字 + 2×英文自然语言单词”中的占比达到该阈值即视为中文，默认 0.5。 */
    skipChineseRatio: number;
    /** 单次翻译调用的超时毫秒数，默认 20000。 */
    timeoutMs: number;
    /** 翻译结果 LRU 缓存条数，默认 256；0 = 关闭缓存。 */
    cacheSize: number;
}
/** Schemastery schema：校验配置并在缺省时填充默认值。 */
export declare const Config: Schema<Config>;
/** 插件入口（对象形式）。 */
declare const _default: {
    name: string;
    inject: string[];
    Config: Schema<Config>;
    /** 注册系统提示词段落与思考流翻译；插件卸载时由框架自动清理。 */
    apply(ctx: Context, config: Config): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map