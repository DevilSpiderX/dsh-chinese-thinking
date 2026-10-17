/**
 * dsh-chinese-thinking — Host 插件：强制模型思考（内部推理）使用中文。
 *
 * 机制：向 `ctx.systemPrompt` 注册一个高优先级提示词段落。
 * 每次组装系统提示词（含子代理、工作流子代理）时都会带上该段落，
 * 从而约束模型的 reasoning / 思维链语言。
 *
 * 可调配置（写在组合包或 profile 的 cordis.patch.yml 的 row config 中）：
 *   - enabled: boolean        是否启用（默认 true）
 *   - order: number           段落排序（默认 10，紧随部署人设前缀之后）
 *   - text: string            覆盖默认指令全文
 */

const name = "dsh-chinese-thinking";
const inject = ["systemPrompt"];

const DEFAULT_ORDER_OFFSET = 10;

const DEFAULT_TEXT = `## 思考语言（强制规则）

你的全部内部思考、推理与思维链——包括任何 hidden reasoning、计划、反思、自我提问——**必须始终使用简体中文**书写。这条规则没有例外：

- 无论用户用什么语言提问、引用的文档或代码是什么语言，思考过程都必须是中文。围绕代码、命令、报错的推理句子本身必须是中文；标识符、代码片段、命令、文件路径、API 名称、专有名词保持原文即可。
- 不得在思考中用英文（或其他语言）造完整句子，包括“先用英文想再翻译”的做法；从一开始就要用中文思考。
- 这条规则只约束**思考**语言。最终回答请使用用户提问所用的语言（用户用中文则用中文）。
- 在所有会话、所有工具调用间隙、所有子代理任务中都遵守本规则；若发现自己正在用英文思考，立即切换回中文继续。`;


export default {
    name,
    inject,
    /** 注册一个系统提示词段落；返回其销毁函数。 */
    apply(ctx, config = {}) {
        if (config.enabled === false) return;

        console.log(`[${name}] plugin loaded!`);

        const systemPrompt = ctx.systemPrompt;
        const text = typeof config.text === "string" && config.text.trim() !== "" ? config.text : DEFAULT_TEXT;
        const order = Number.isFinite(config.order)
            ? config.order
            : systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX") + DEFAULT_ORDER_OFFSET;

        return systemPrompt.section({
            name,
            order,
            text,
        });
    }
}