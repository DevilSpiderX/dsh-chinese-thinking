/**
 * dsh-chinese-thinking — Host 插件：让模型的思考（内部推理）过程始终以中文呈现。
 *
 * 双层机制：
 *   1. 提示词层：向 `ctx.systemPrompt` 注册一个高优先级段落，劝导模型原生中文思考
 *      （对主会话、子代理与工作流子代理统一生效；模型听从时可显著减少翻译量）。
 *   2. 流式翻译层（核心）：监听 `llm/stream` waterfall，把每个 reasoning block 的
 *      增量文本按句缓冲，调用模型流式翻译成中文后以 `reasoning-delta` 下发，
 *      并同步改写 `block-end` 的最终文本，使实时展示与落盘内容一致。
 *
 * 为什么挂在 `llm/stream` 上：宿主内所有模型调用（主会话、子代理、工作流、session-title、
 * compaction、retry 重试）都走 `ctx.llm.stream()` 同一个入口，监听器注册在宿主上下文且
 * `global: true`，因此翻译对切会话 / 切模型 / 切窗口 / 切工作区天然全覆盖。
 *
 * 韧性设计：
 *   - 已是中文的片段、纯代码/数字片段直接放行，不为遵守提示词的模型浪费调用；
 *   - 翻译不可用、失败或超时一律回退原文，思考永不中断；
 *   - 翻译路由硬失败（无适配器 / 无凭证 / 鉴权失败）记入黑名单，避免每句重试；
 *   - 翻译后 reasoning 的 provider 签名失效，`finish` chunk 的 replayState 会剥离
 *     签名字段，走适配器官方降级路径（省略签名、保留文本），回放不报错；
 *   - 翻译请求自身带WeakSet 标记，不会递归触发翻译。
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
/** 插件可调配置（cordis.patch.yml 的 row config）。 */
export interface Config {
    /** 是否启用，默认 true。 */
    enabled: boolean;
    /** 系统提示词段落排序，默认部署人设前缀之后 +10。 */
    order?: number;
    /** 覆盖默认指令全文。 */
    text?: string;
    /** 是否保留系统提示词劝导段，默认 true。 */
    promptEnabled: boolean;
    /** 是否启用思考流中文翻译，默认 true。 */
    translate: boolean;
    /** 翻译用 provider，空 = 跟随被翻译的请求。 */
    translationProvider?: string;
    /** 翻译用 model，空 = 跟随被翻译的请求。 */
    translationModel?: string;
    /** 触发一次翻译的最小缓冲字符数，默认 24。 */
    minChars: number;
    /** 单个翻译片段的最大字符数（硬切上限），默认 480。 */
    maxChars: number;
    /** 汉字占比达到该阈值即视为中文、跳过翻译，默认 0.5。 */
    skipChineseRatio: number;
    /** 单次翻译调用的超时毫秒数，默认 20000。 */
    timeoutMs: number;
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