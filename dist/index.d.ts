/**
 * dsh-chinese-thinking — Host 插件：强制模型思考（内部推理）使用中文。
 *
 * 机制：向 `ctx.systemPrompt` 注册一个高优先级提示词段落。
 * 每次组装系统提示词（含子代理、工作流子代理）时都会带上该段落，
 * 从而约束模型的 reasoning / 思维链语言。
 *
 * 可调配置（写在组合包或 profile 的 cordis.patch.yml 的 row config 中）：
 *   - enabled: boolean        是否启用（默认 true）
 *   - order: number           段落排序（默认紧随部署人设前缀之后）
 *   - text: string            覆盖默认指令全文
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
}
/** Schemastery schema：校验配置并在缺省时填充默认值。 */
export declare const Config: Schema<Config>;
/** 插件入口（对象形式）。 */
declare const _default: {
    name: string;
    inject: string[];
    Config: Schema<Config>;
    /** 注册一个系统提示词段落；插件卸载时由框架自动清理。 */
    apply(ctx: Context, config: Config): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map