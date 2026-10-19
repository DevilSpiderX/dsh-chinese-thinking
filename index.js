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

const DEFAULT_TEXT = `## Thinking Language (Mandatory Rule)

All of your internal thinking, reasoning, and chain of thought — including any hidden reasoning, planning, reflection, and self-questioning — **must always be written in Simplified Chinese**. There are no exceptions to this rule:

- No matter what language the user asks in, or what language the referenced documentation or code is in, the thinking process must always be in Chinese. The reasoning sentences around code, commands, and error messages must themselves be in Chinese; identifiers, code snippets, commands, file paths, API names, and proper nouns may stay in their original form.
- Do not form complete sentences in English (or any other language) while thinking, including the practice of "thinking in English first and translating later"; think in Chinese from the very beginning.
- This rule constrains only the language of **thinking**. Write the final answer in the language of the user's question (Chinese question → Chinese answer).
- Follow this rule in every session, in every gap between tool calls, and in every subagent task; if you catch yourself thinking in English, switch back to Chinese immediately and continue.`;


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