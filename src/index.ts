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

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, ReasoningEffortId, ReplayEnvelope, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import Schema from '@deepseek-ai/schemastery'

const NAME = 'dsh-chinese-thinking';

/** 默认排在系统提示词末尾：内置段最后是 deployment:persona-suffix (10200)。 */
const END_ORDER_OFFSET = 50;

const DEFAULT_TEXT = `## Thinking Language (Mandatory)

Think in Simplified Chinese from the very first token — in every step, every gap between tool calls, and every subagent. Never open or frame a thought in English ("Let me…", "I need…", "The user…", "We should…"). Code, identifiers, paths, commands, and proper nouns stay exactly as written. This rule constrains only thinking; answer in the language of the user's question.`;

/** 检测到模型仍用外语思考后追加的强化规则；只增加一次提示词成本，不发起翻译请求。 */
const ESCALATED_TEXT = `## Thinking Language (Reinforced)

Earlier responses reasoned in English, which violates the mandatory rule above. From the very next token, think only in Simplified Chinese. Do not use English sentences or openers such as "Let me…", "I need…", "The user…", "We should…". Keep code, identifiers, paths, and commands unchanged.`;

/** 翻译指令：尽量短，只保留约束翻译行为所必需的规则。 */
const TRANSLATION_SYSTEM = `Translate the user's text into Simplified Chinese. Output only the translation, with no commentary. Keep code, identifiers, paths, commands, and proper nouns unchanged.`;

/** 元回应特征：翻译模型把任务当成对话、索要内容或拒绝时的输出。 */
const META_RESPONSE_PATTERN = /请[提供发送]|希望翻译|please (provide|send)|无法满足|抱歉/;

/** 语言探测窗口：超过这个长度即使没有句读也先判定一次。 */
const PROBE_MAX_CHARS = 160;

/** 至少要有这么多“自然语言英文单词”才值得翻译。 */
const MIN_PROSE_WORDS = 3;

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
export const Config: Schema<Config> = Schema.object({
    enabled: Schema.boolean().default(true),
    order: Schema.number(),
    text: Schema.string(),
    promptEnabled: Schema.boolean().default(true),
    translate: Schema.boolean().default(false),
    translationProvider: Schema.string(),
    translationModel: Schema.string(),
    minChars: Schema.number().default(24),
    maxChars: Schema.number().default(480),
    batchChars: Schema.number().default(400),
    skipChineseRatio: Schema.number().default(0.5),
    timeoutMs: Schema.number().default(20000),
    cacheSize: Schema.number().default(256),
});

// #region 流式翻译核心

/** 关闭思考的 effort 标识（适配器普遍接受的值）。 */
const OFF_EFFORT = 'off' as ReasoningEffortId;

/** 插件自发起的翻译请求：命中即放行，避免递归翻译。 */
const translationRequests = new WeakSet<object>();

/** 翻译路由硬失败记忆（无适配器 / 无凭证 / 鉴权失败等配置类错误）。 */
const unavailableRoutes = new Set<string>();

/** 不接受所选 effort 的路由记忆：这些路由重试时省略该字段。 */
const effortRejectedRoutes = new Set<string>();

/** 每个路由可用的最低 reasoning 档（Promise 缓存，失败时回退为 off）。 */
const effortRoutes = new Map<string, Promise<ReasoningEffortId | undefined>>();

/** 进程内翻译缓存：routeKey + 原文 -> 译文。 */
const translationCache = new Map<string, string>();

/** 提示词强化状态：一旦发现外语思考，后续系统提示词追加强化规则。 */
const compliance = { escalated: false };

/** 已判定为不遵从的路由，避免重复触发强化日志。 */
const escalatedRoutes = new Set<string>();

/** 视为硬失败的稳定错误码：缓存后不再对该路由发起翻译。 */
const HARD_FAILURE_CODES = new Set(['NO_ADAPTER', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'AUTH']);

/** 句读边界：中文标点 + 英文 . ! ? ; 与换行。 */
const BOUNDARY_PATTERN = /[。！？；.!?;\n]/g;
/** 英文边界字符：仅当后随空白或结尾时才算安全切点（避开小数与缩写）。 */
const ASCII_BOUNDARIES = new Set(['.', '!', '?', ';']);

/** 汉字字符。 */
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** 单次汉字测试（非全局，避免 lastIndex 状态影响结果）。 */
const HAN_TEST_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 任意 Unicode 字母。 */
const LETTER_PATTERN = /\p{L}/gu;
/** 连续的拉丁 token：把路径、标识符、函数调用识别为一个整体。 */
const LATIN_TOKEN_PATTERN = /[A-Za-z0-9_@./\\:'’+-]+/g;
/** 代码标记：用于降低“代码/命令”片段被翻译的概率。 */
const CODE_MARK_PATTERN = /[{}()[\]`|\\]/g;
/** 英文句末标点（后随空白或结尾）。 */
const SENTENCE_PUNCT_PATTERN = /[.!?](?=\s|$)/;

/** 单个 reasoning block 的缓冲、判定与输出状态。 */
interface ReasoningBlockState {
    /** probe：等待语言判定；pass：中文透传；translate：翻译模式。 */
    mode: 'probe' | 'pass' | 'translate';
    /** 尚未处理的原文缓冲。 */
    buffer: string;
    /** 已累计输出（译文或回退原文）。 */
    emitted: string;
    /** 等待合批翻译的外语片段。 */
    pendingForeign: string;
    /** 是否已经输出过内容（用于首片立即翻译）。 */
    shown: boolean;
    /** 是否收到过 reasoning-delta（兼容只给 block-end 的适配器）。 */
    received: boolean;
    /** block 是否仍处于打开状态。 */
    open: boolean;
}

/** 单个片段的翻译结果。 */
interface PieceResult {
    /** 最终下发的文本（译文，或失败时的原文）。 */
    text: string;
    /** 是否真的经过了翻译（false 表示放行或回退）。 */
    translated: boolean;
}

/** 一次语言判定的结局。 */
type ProbeDecision = 'wait' | 'pass' | 'translate';

/** 一次翻译调用的结局。 */
type CollectOutcome =
    | { kind: 'ok'; text: string; usage?: TokenUsage }
    | { kind: 'failed'; code: string };

/** 一次片段处理产生的待下发文本。 */
interface PieceOutput {
    texts: string[];
    translated: boolean;
}

/** 语言统计：只看自然语言英文，不把路径/标识符算成外语。 */
interface TextStats {
    han: number;
    letters: number;
    nonSpace: number;
    prose: number;
    codeMarks: number;
    sentencePunct: boolean;
}

/**
 * 把一段模型思考流包装成中文思考流。
 *
 * 协议约束（与 `@deepseek-ai/dsh-llm` 的 invariant 一致）：reasoning-delta 必须跟随
 * 打开的 reasoning block；block-end 的 block.type 必须与 block-start 一致；usage 先于
 * finish；finish 之后不得再有 chunk。包装器只改写 reasoning 相关 chunk 的文本，
 * 其余原样透传，且输出保持可 JSON 快照（不出现 undefined 字段）。
 */
async function* toChineseReasoning(
    ctx: Context,
    config: Config,
    options: GenerateOptions,
    source: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
    const states = new Map<number, ReasoningBlockState>();
    let translatedAny = false;

    for await (const chunk of source) {
        if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
            states.set(chunk.index, {
                mode: 'probe',
                buffer: '',
                emitted: '',
                pendingForeign: '',
                shown: false,
                received: false,
                open: true,
            });
            yield chunk;
            continue;
        }
        if (chunk.type === 'reasoning-delta') {
            const state = states.get(chunk.index);
            if (state === undefined || !state.open) {
                yield chunk;
                continue;
            }
            state.received = true;
            if (state.mode === 'pass') {
                yield chunk;
                continue;
            }
            state.buffer += chunk.text;

            if (state.mode === 'probe') {
                const decision = probeLanguage(state.buffer, config);
                if (decision === 'wait') continue;
                const probe = state.buffer;
                state.buffer = '';
                if (decision === 'pass') {
                    state.mode = 'pass';
                    state.emitted += probe;
                    if (probe.length > 0) {
                        yield { type: 'reasoning-delta', index: chunk.index, text: probe };
                    }
                } else {
                    state.mode = 'translate';
                    if (isForeignReasoning(probe, config)) markNonCompliant(options.provider, options.model);
                    const out = await handlePiece(ctx, config, options, state, probe);
                    if (out.translated) translatedAny = true;
                    for (const text of out.texts) {
                        if (text.length > 0) yield { type: 'reasoning-delta', index: chunk.index, text };
                    }
                }
                continue;
            }

            for (;;) {
                const cut = findCutPoint(state.buffer, config);
                if (cut <= 0) break;
                const piece = state.buffer.slice(0, cut);
                state.buffer = state.buffer.slice(cut);
                const out = await handlePiece(ctx, config, options, state, piece);
                if (out.translated) translatedAny = true;
                for (const text of out.texts) {
                    if (text.length > 0) yield { type: 'reasoning-delta', index: chunk.index, text };
                }
            }
            continue;
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') {
            const state = states.get(chunk.index);
            if (state === undefined || !state.open) {
                yield chunk;
                continue;
            }
            state.open = false;
            states.delete(chunk.index);

            if (state.mode === 'pass') {
                yield chunk;
                continue;
            }
            if (!state.received && chunk.block.text.length > 0) {
                state.buffer += chunk.block.text;
            }

            if (state.mode === 'probe') {
                const decision = probeLanguage(state.buffer, config, true);
                if (decision === 'pass') {
                    state.mode = 'pass';
                    if (state.buffer.length > 0) {
                        state.emitted += state.buffer;
                        yield { type: 'reasoning-delta', index: chunk.index, text: state.buffer };
                        state.buffer = '';
                    }
                    yield chunk;
                    continue;
                }
                state.mode = 'translate';
                if (isForeignReasoning(state.buffer, config)) markNonCompliant(options.provider, options.model);
            }

            if (state.buffer.length > 0) {
                const out = await handlePiece(ctx, config, options, state, state.buffer);
                state.buffer = '';
                if (out.translated) translatedAny = true;
                for (const text of out.texts) {
                    if (text.length > 0) yield { type: 'reasoning-delta', index: chunk.index, text };
                }
            }
            const flushed = await flushPending(ctx, config, options, state);
            if (flushed.translated) translatedAny = true;
            for (const text of flushed.texts) {
                if (text.length > 0) yield { type: 'reasoning-delta', index: chunk.index, text };
            }
            yield { type: 'block-end', index: chunk.index, block: { type: 'reasoning', text: state.emitted } };
            continue;
        }
        if (chunk.type === 'finish' && translatedAny && chunk.replayState !== undefined) {
            yield { ...chunk, replayState: stripReplaySignatures(chunk.replayState) };
            continue;
        }
        yield chunk;
    }
}

/** 只监听不翻译：发现外语思考就标记，让后续系统提示词追加强化规则。 */
async function* monitorReasoning(
    config: Config,
    options: GenerateOptions,
    source: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
    const probes = new Map<number, string>();
    for await (const chunk of source) {
        if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
            probes.set(chunk.index, '');
        } else if (chunk.type === 'reasoning-delta') {
            const current = probes.get(chunk.index);
            if (current !== undefined) {
                const next = current + chunk.text;
                if (shouldProbe(next, config)) {
                    probes.delete(chunk.index);
                    if (isForeignReasoning(next, config)) markNonCompliant(options.provider, options.model);
                } else {
                    probes.set(chunk.index, next);
                }
            }
        } else if (chunk.type === 'block-end') {
            const pending = probes.get(chunk.index);
            if (pending !== undefined && pending.length > 0 && chunk.block.type === 'reasoning') {
                if (isForeignReasoning(pending, config)) markNonCompliant(options.provider, options.model);
            }
            probes.delete(chunk.index);
        }
        yield chunk;
    }
}

/** 探测窗口已足够判定语言。 */
function shouldProbe(text: string, config: Config): boolean {
    return text.length >= PROBE_MAX_CHARS || findCutPoint(text, config) > 0;
}

/**
 * 是否“确实在用外语思考”。比翻译判定更保守：必须有完整英文句子、足够的散文词，
 * 且汉字占比很低；避免把文件清单/接口列表误判成不遵从并触发提示词强化。
 */
function isForeignReasoning(text: string, config: Config): boolean {
    const stats = measureText(text);
    if (stats.letters === 0 || stats.nonSpace === 0) return false;
    if (stats.prose < MIN_PROSE_WORDS + 2) return false;
    if (!stats.sentencePunct) return false;
    if (stats.letters / stats.nonSpace < 0.15) return false;
    if (stats.codeMarks > 2 && stats.codeMarks > stats.prose * 2) return false;
    const threshold = Math.min(0.3, config.skipChineseRatio);
    return stats.han / (stats.han + 2 * stats.prose) < threshold;
}

/** 记录一次不遵从；只改变后续系统提示词，不发起任何模型请求。 */
function markNonCompliant(provider: string, model: string): void {
    const route = `${provider}::${model}`;
    if (escalatedRoutes.has(route)) return;
    escalatedRoutes.add(route);
    if (compliance.escalated) return;
    compliance.escalated = true;
    console.log(`[${NAME}] non-Chinese reasoning detected on ${route}; prompt reinforced for future turns`);
}

/** 处理一个片段：中文直接放行，外语先入批、达到阈值再翻译。 */
async function handlePiece(
    ctx: Context,
    config: Config,
    options: GenerateOptions,
    state: ReasoningBlockState,
    piece: string,
): Promise<PieceOutput> {
    if (!needsTranslation(piece, config.skipChineseRatio)) {
        const flushed = await flushPending(ctx, config, options, state);
        state.emitted += piece;
        state.shown = true;
        return { texts: [...flushed.texts, piece], translated: flushed.translated };
    }
    if (isForeignReasoning(piece, config)) markNonCompliant(options.provider, options.model);
    state.pendingForeign += piece;
    if (!state.shown || config.batchChars <= 0 || state.pendingForeign.length >= config.batchChars) {
        return flushPending(ctx, config, options, state);
    }
    return { texts: [], translated: false };
}

/** 把待翻译的外语片段合并成一次调用；失败时回退原文。 */
async function flushPending(
    ctx: Context,
    config: Config,
    options: GenerateOptions,
    state: ReasoningBlockState,
): Promise<PieceOutput> {
    const text = state.pendingForeign;
    if (text.length === 0) return { texts: [], translated: false };
    state.pendingForeign = '';
    const result = await translatePiece(ctx, config, options, text);
    state.emitted += result.text;
    state.shown = true;
    return { texts: result.text.length > 0 ? [result.text] : [], translated: result.translated };
}

/**
 * 翻译一个原文片段；任何失败都回退原文，保证思考展示不中断。
 */
async function translatePiece(
    ctx: Context,
    config: Config,
    options: GenerateOptions,
    piece: string,
): Promise<PieceResult> {
    if (!needsTranslation(piece, config.skipChineseRatio)) return { text: piece, translated: false };
    const llm = ctx.get('llm');
    if (llm === undefined) return { text: piece, translated: false };

    const provider = firstNonEmpty(config.translationProvider, options.provider);
    const model = firstNonEmpty(config.translationModel, options.model);
    const routeKey = `${provider}::${model}`;
    if (unavailableRoutes.has(routeKey)) return { text: piece, translated: false };

    const cached = readCache(config.cacheSize, routeKey, piece);
    if (cached !== undefined) {
        if (process.env.CT_DEBUG) console.log(`[${NAME}] cache hit chars=${piece.length} route=${routeKey}`);
        return { text: cached, translated: true };
    }

    const effort = await resolveTranslationEffort(llm, provider, model);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.max(1, config.timeoutMs));
    const signals: AbortSignal[] = [timeout.signal];
    if (options.signal !== undefined) signals.push(options.signal);
    let signal: AbortSignal;
    try {
        signal = AbortSignal.any(signals);
    } catch {
        signal = timeout.signal;
    }

    const buildRequest = (reasoningEffort: ReasoningEffortId | undefined): GenerateOptions => {
        const request: GenerateOptions = {
            provider,
            model,
            system: TRANSLATION_SYSTEM,
            messages: [{ role: 'user', content: [{ type: 'text', text: `Translate:\n\n${piece}` }] }],
            signal,
            temperature: 0,
            maxTokens: translationMaxTokens(piece),
            ...reasoningEffort === undefined ? {} : { reasoningEffort },
        };
        translationRequests.add(request);
        return request;
    };

    try {
        let request = effortRejectedRoutes.has(routeKey) ? buildRequest(undefined) : buildRequest(effort);
        let outcome = await collectTranslation(llm, request);
        if (outcome.kind === 'failed' && outcome.code === 'UNSUPPORTED_REASONING_EFFORT' && effort !== undefined && !effortRejectedRoutes.has(routeKey)) {
            effortRejectedRoutes.add(routeKey);
            request = buildRequest(undefined);
            outcome = await collectTranslation(llm, request);
        }
        if (outcome.kind === 'ok' && isUsableTranslation(outcome.text, piece)) {
            if (process.env.CT_DEBUG) {
                const usage = outcome.usage;
                const usageText = usage === undefined ? '' : ` in=${usage.inputTokens} out=${usage.outputTokens} cache=${usage.cacheReadTokens ?? 0}`;
                console.log(`[${NAME}] translated chars=${piece.length}${usageText} route=${routeKey}`);
            }
            writeCache(config.cacheSize, routeKey, piece, outcome.text);
            return { text: outcome.text, translated: true };
        }
        if (outcome.kind === 'failed' && HARD_FAILURE_CODES.has(outcome.code)) {
            unavailableRoutes.add(routeKey);
        }
        if (process.env.CT_DEBUG) console.log(`[${NAME}] piece(${piece.length}) FALLBACK (${outcome.kind === 'failed' ? outcome.code : 'meta-empty-or-runaway'}): ${JSON.stringify(piece.slice(0, 80))}`);
        return { text: piece, translated: false };
    } catch (error) {
        if (process.env.CT_DEBUG) console.log(`[${NAME}] piece THREW: ${String(error)}`);
        return { text: piece, translated: false };
    } finally {
        clearTimeout(timer);
    }
}

/** 消费翻译流：只收 text-delta，把终止 chunk 归类为结局。 */
async function collectTranslation(
    llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> },
    request: GenerateOptions,
): Promise<CollectOutcome> {
    const parts: string[] = [];
    let usage: TokenUsage | undefined;
    try {
        for await (const chunk of llm.stream(request)) {
            if (chunk.type === 'text-delta') {
                parts.push(chunk.text);
            } else if (chunk.type === 'usage') {
                usage = chunk.usage;
            } else if (chunk.type === 'finish') {
                if (chunk.reason.kind === 'error') return { kind: 'failed', code: chunk.reason.failure.code };
                if (chunk.reason.kind === 'aborted') return { kind: 'failed', code: 'ABORTED' };
                return { kind: 'ok', text: parts.join(''), usage };
            }
        }
        return { kind: 'failed', code: 'STREAM_CLOSED' };
    } catch (error) {
        return { kind: 'failed', code: errorCode(error) };
    }
}

/** 从任意抛出值中提取错误码（无码时用错误名）。 */
function errorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.length > 0) return code;
    }
    if (error instanceof Error && error.name.length > 0) return error.name;
    return 'UNKNOWN';
}

/** 翻译输出是否可用：非空、不是元回应、确实含中文、长度没有失控。 */
function isUsableTranslation(text: string, source: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    if (META_RESPONSE_PATTERN.test(trimmed)) return false;
    if (!HAN_TEST_PATTERN.test(trimmed)) return false;
    return trimmed.length <= source.length * 3 + 200;
}

/** 翻译输出上限：防止翻译模型借机长篇推理；中文译文通常不超过原文长度的 2.5 倍。 */
function translationMaxTokens(piece: string): number {
    return Math.min(16384, Math.max(64, Math.ceil(piece.length * 2.5) + 64));
}

/**
 * 判断一个 block 的思考语言。
 *
 * 只有“自然语言英文单词”参与统计：路径、CamelCase 标识符、命令参数、代码片段不算外语。
 * 这样“中文夹代码”的思考不会被误判为需要翻译。
 */
function probeLanguage(buffer: string, config: Config, force = false): ProbeDecision {
    if (!force && buffer.length < config.minChars) return 'wait';
    if (!force && buffer.length < PROBE_MAX_CHARS && findCutPoint(buffer, config) <= 0) return 'wait';
    const stats = measureText(buffer);
    if (stats.letters === 0 || stats.nonSpace === 0) return 'pass';
    if (stats.prose < MIN_PROSE_WORDS) {
        if (stats.han > 0) return 'pass';
        return force || buffer.length >= PROBE_MAX_CHARS ? 'pass' : 'wait';
    }
    return stats.han / (stats.han + 2 * stats.prose) >= config.skipChineseRatio ? 'pass' : 'translate';
}

/**
 * 判断片段是否需要翻译：无字母内容（纯数字/标点）放行；代码/命令为主放行；
 * 没有足够的自然语言英文放行；汉字占比达到阈值放行；其余送译。
 */
function needsTranslation(piece: string, skipChineseRatio: number): boolean {
    if (piece.trim().length === 0) return false;
    const stats = measureText(piece);
    if (stats.letters === 0 || stats.nonSpace === 0) return false;
    if (stats.letters / stats.nonSpace < 0.15) return false;
    if (stats.prose < MIN_PROSE_WORDS) return false;
    if (!stats.sentencePunct && stats.prose < MIN_PROSE_WORDS + 5) return false;
    if (stats.codeMarks > 2 && stats.codeMarks > stats.prose * 2) return false;
    return stats.han / (stats.han + 2 * stats.prose) < skipChineseRatio;
}

/** 统计一段文本的中文/英文自然语言占比，忽略路径、标识符与代码 token。 */
function measureText(text: string): TextStats {
    const han = text.match(HAN_PATTERN)?.length ?? 0;
    const letters = text.match(LETTER_PATTERN)?.length ?? 0;
    const nonSpace = text.replace(/\s+/g, '').length;
    let prose = 0;
    for (const token of text.match(LATIN_TOKEN_PATTERN) ?? []) {
        if (isProseWord(token)) prose++;
    }
    const codeMarks = text.match(CODE_MARK_PATTERN)?.length ?? 0;
    return {
        han,
        letters,
        nonSpace,
        prose,
        codeMarks,
        sentencePunct: SENTENCE_PUNCT_PATTERN.test(text),
    };
}

/** 自然语言英文单词：纯字母、可带一个撇号，且不是 CamelCase / 全大写缩写。 */
function isProseWord(token: string): boolean {
    const word = token.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (word.length === 0 || word.length > 18) return false;
    if (!/^[A-Za-z]+(?:['’][A-Za-z]+)?$/.test(word)) return false;
    if (/[A-Z]/.test(word.slice(1))) return false;
    return true;
}

/**
 * 在缓冲区内寻找安全切点（返回切出长度，0 表示继续缓冲）。
 *
 * 优先在最后一个句读边界处切分（英文边界要求后随空白，避开小数/缩写/文件名）；
 * 缓冲超过 maxChars 时优先退到最后一个空白，否则硬切。
 */
function findCutPoint(buffer: string, config: Config): number {
    if (buffer.length >= config.maxChars) {
        const head = buffer.slice(0, config.maxChars);
        const at = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'));
        return at >= config.minChars ? at + 1 : config.maxChars;
    }
    if (buffer.length < config.minChars) return 0;
    let cut = 0;
    BOUNDARY_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BOUNDARY_PATTERN.exec(buffer)) !== null) {
        const char = match[0];
        if (ASCII_BOUNDARIES.has(char)) {
            const next = buffer[match.index + 1];
            if (next !== undefined && !/\s/.test(next)) continue;
        }
        cut = match.index + 1;
    }
    return cut >= config.minChars ? cut : 0;
}

/** 查询翻译路由可用的最低 reasoning 档；缓存 Promise，避免每片都解析。 */
async function resolveTranslationEffort(
    llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> },
    provider: string,
    model: string,
): Promise<ReasoningEffortId | undefined> {
    const key = `${provider}::${model}`;
    let pending = effortRoutes.get(key);
    if (pending === undefined) {
        pending = (async () => {
            try {
                const info = await llm.resolveModelInfo(provider, model);
                const efforts = info.reasoning?.efforts ?? [];
                if (efforts.length === 0) return undefined;
                return efforts.find((entry) => entry.id === OFF_EFFORT)?.id ?? efforts[0]?.id;
            } catch {
                return OFF_EFFORT;
            }
        })();
        effortRoutes.set(key, pending);
    }
    return pending;
}

function cacheKey(routeKey: string, text: string): string {
    return `${routeKey}\u0000${text}`;
}

function readCache(size: number, routeKey: string, text: string): string | undefined {
    if (size <= 0) return undefined;
    const key = cacheKey(routeKey, text);
    const value = translationCache.get(key);
    if (value === undefined) return undefined;
    translationCache.delete(key);
    translationCache.set(key, value);
    return value;
}

function writeCache(size: number, routeKey: string, text: string, value: string): void {
    if (size <= 0) return;
    const key = cacheKey(routeKey, text);
    translationCache.delete(key);
    translationCache.set(key, value);
    while (translationCache.size > size) {
        const oldest = translationCache.keys().next().value;
        if (oldest === undefined) break;
        translationCache.delete(oldest);
    }
}

/** replayState 中与内容绑定的签名字段：翻译后一律失效，需剥离。 */
const REPLAY_SIGNATURE_KEYS = new Set(['signature', 'thinkingSignature', 'textSignature', 'thoughtSignature']);

/**
 * 剥离 replayState 各 block 条目的签名字段。
 *
 * 翻译改变了 reasoning 文本，provider 签名不再匹配；两个官方适配器都支持
 * 「省略签名、保留文本」的降级路径（deepseek README 明确记录），剥离后回放不报错。
 */
function stripReplaySignatures(envelope: ReplayEnvelope): ReplayEnvelope {
    if (envelope.blocks === undefined) return envelope;
    const blocks = envelope.blocks.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
        const record = entry as Record<string, unknown>;
        let changed = false;
        const cleaned: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            if (REPLAY_SIGNATURE_KEYS.has(key)) {
                changed = true;
                continue;
            }
            cleaned[key] = value;
        }
        return changed ? cleaned : entry;
    });
    return { ...envelope, blocks };
}

function firstNonEmpty(...values: (string | undefined)[]): string {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return '';
}

// #endregion

/** 插件入口（对象形式）。 */
export default {
    name: NAME,
    inject: ['systemPrompt'],
    Config,

    /** 注册系统提示词段落与思考流翻译；插件卸载时由框架自动清理。 */
    apply(ctx: Context, config: Config): void {
        if (!config.enabled) return;

        console.log(`[${NAME}] plugin loaded!`);

        if (config.promptEnabled) {
            const customText = typeof config.text === "string" && config.text.trim() !== "" ? config.text : undefined;
            const text = customText ?? (() => compliance.escalated ? `${DEFAULT_TEXT}\n\n${ESCALATED_TEXT}` : DEFAULT_TEXT);
            const order = typeof config.order === "number" && Number.isFinite(config.order)
                ? config.order
                : ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") + END_ORDER_OFFSET;

            const section: PromptSection = {
                name: NAME,
                order,
                text,
            };

            ctx.effect(() => ctx.systemPrompt.section(section));
        }

        if (config.translate) {
            ctx.on('llm/stream', (options, next) => {
                if (translationRequests.has(options)) return next();
                return toChineseReasoning(ctx, config, options, next());
            }, { global: true });
        } else if (config.promptEnabled) {
            ctx.on('llm/stream', (options, next) => {
                if (translationRequests.has(options)) return next();
                return monitorReasoning(config, options, next());
            }, { global: true });
        }
    },
};
