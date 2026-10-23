# dsh-chinese-thinking

让模型的**思考（内部推理 / reasoning / 思维链）过程以中文呈现**的 DSH Host 插件。

默认模式**不发起任何额外模型请求**：用一段放在系统提示词末尾的精简规则，劝导主模型直接用中文思考；一旦检测到它仍用英文思考，下一次请求自动追加强化规则。翻译只作为可选的严格兜底，需要显式开启。

## 设计原则：先让主模型说中文，而不是事后翻译

事后翻译是“用另一个模型把英文思考再写一遍”：每个英文 token 至少产生一份输入 + 一份输出，必要时还会带上翻译模型自己的 reasoning。它天然昂贵，也不可避免地增加延迟。

所以本插件把成本从高到低分成三层，**默认只使用前两层**：

### 1. 提示词层（默认，零额外请求）

向 `ctx.systemPrompt` 注册一个段落，默认排序 `10250` —— 位于 `deployment:persona-suffix`（10200）之后，也就是系统提示词的**末尾**。指令放在末尾利用了 recency，比埋在开头更容易被遵守。

规则约 120 token（约 500 字符），明确写了三件事：

- 从第一个思考 token 起就用简体中文；
- 禁止 `Let me…` / `I need…` / `The user…` / `We should…` 这类英文起句；
- 只约束**思考**语言，最终回答仍跟随用户提问语言；代码、路径、标识符保持原文。

提示词内容稳定，属于可被 provider 前缀缓存的静态前缀；在 DeepSeek 的会话里，实际成本接近缓存命中价。

### 2. 不遵从监测与提示词强化（默认，零额外请求）

监听 `llm/stream`，只读地检查每个 reasoning block 的前约 160 字符：

- 中文思考：直接放行，token 粒度不变，不缓存、不拦截；
- 检测到**确实是英文句子**（至少 5 个自然语言英文词 + 句末标点，且汉字占比很低）：把该路由标记为不遵从，并把进程级 `escalated` 置为 true；
- 下一次组装系统提示词时，在原有规则后追加一段 `Reinforced` 强化规则。

这一步不修改任何 chunk、不发起翻译请求，只多出一次字符串判定。强化规则只在检测到违规后出现，约 60 token/请求；之后保持强化状态，直到 DSH 重启。

### 3. 可选翻译层（`translate: true`，需要显式开启）

只有当你需要“即使模型不听话，展示也必须是中文”的硬保证时才开启。它不是逐句无脑调用，而是：

1. **块级语言探测**：每个 reasoning block 先判定一次。中文块直接按原 token 透传；只有英文块进入翻译模式。
2. **只翻译自然语言**：统计“汉字 vs 英文自然语言单词”，路径、CamelCase 标识符、命令、代码 token 不参与比例。`文件清单：DESIGN.md、UserAuthorityBindingUseCase` 这类内容不会被误判为外语。
3. **合批**：连续外语片段累计到 `batchChars`（默认 400）再发一次请求；块首片仍立即翻译，保证首屏速度。
4. **廉价路由**：优先使用 `translationModel`；未指定时跟随原请求。自动选择该路由可用的最低 reasoning 档（有 `off` 用 `off`），并设置 `temperature: 0` 与输出上限，防止翻译模型偷偷长篇思考。
5. **缓存与回退**：翻译结果进进程内 LRU；失败、超时、元回应、空输出、疑似跑飞一律回退原文，思考不中断。

## Token 成本

| 项目 | 默认（`translate: false`） | 可选（`translate: true`） |
|---|---|---|
| 额外模型请求 | 0 | 仅英文思考块 |
| 提示词 | 约 120 token/请求，静态前缀，通常被 provider 缓存 | 同左 |
| 翻译本身 | 0 | 仅“自然语言英文”的输入 + 中文输出 |
| 不遵从时 | 追加约 60 token 的强化规则 | 同左 |

在本机 **613 个真实 reasoning block、159,110 字符**的会话日志上回放：

| 判定方式 | 触发翻译的字符 | 翻译调用数 |
|---|---|---|
| 旧：汉字 / 所有拉丁字母 | 134,330（84.4%） | 384 |
| 新：汉字 / 英文自然语言单词 | 3,873（2.4%） | 11 |

旧判定把 `src/index.ts`、`UserAuthorityBindingUseCase`、`/system/api/v1/...` 里的每个字母都算成“外语”，所以几乎整段思考都会被送去做一次多余的翻译；新判定只对真正的英文句子出手。即使开启翻译，绝大多数会话也不会产生额外请求。

## 为什么没有内置“端侧 / 本地翻译”

完全不经过任何模型的通用翻译在质量上做不到；端侧方案目前也都有明显限制：

- **Chrome 内置 Translator API**：Chrome 138+ 可用（[文档](https://developer.chrome.com/docs/ai/translator-api)），但本机 DSH 是 Electron 44（Chromium 152），Electron 官方 [issue #48567](https://github.com/electron/electron/issues/48567) 明确记录这些 API 在 Electron 中“存在但不可用”（模型不可用 / 调用挂起，涉及法律原因）。因此宿主的渲染进程无法使用。
- **macOS Translation framework**：macOS 15+ 的端侧翻译质量不错，但需要额外的原生 Swift helper，且仅限 macOS；Windows 没有等价的通用端侧翻译 API。
- **本地 NMT（[Transformers.js](https://github.com/huggingface/transformers.js) / [opus-mt-en-zh](https://huggingface.co/Xenova/opus-mt-en-zh) 等）**：可完全离线，但要下载约 100MB 级模型、占用 CPU/内存，首次加载慢，对“代码 + 技术术语 + 中英混排”的推理文本质量不稳定。适合作为可选的后续扩展，不适合作为默认能力。
- **公共翻译接口**：属于第三方网络服务，存在隐私、限流、可用性和条款问题，不能作为“完美”的默认方案。

因此默认选择**让主模型直接用中文思考**：这是唯一同时满足零额外请求、跨平台、质量可控的方案。翻译兜底保留为显式开关，供需要硬保证的场景使用。

## 覆盖范围

宿主内所有模型调用——主会话、子代理、工作流、session-title、compaction、retry 重试——都走 `ctx.llm.stream()` 同一个入口。监听器注册在宿主上下文且 `global: true`，因此与具体会话、模型、窗口、工作区无关。

系统提示词段落同样对主会话、子代理与工作流子代理统一生效。

## 韧性设计

| 场景 | 行为 |
|---|---|
| 中文思考（含路径、类名、代码） | 直接透传，零翻译调用 |
| 默认模式检测到英文思考 | 不修改当前输出；下一次请求追加强化规则 |
| 片段已是中文（`skipChineseRatio`） | 直接放行，不发起翻译 |
| 翻译失败、超时（`timeoutMs`）、流异常 | 回退展示原文，思考不中断 |
| 翻译模型元回应（索要内容 / 拒绝翻译） | 识别后回退原文 |
| 翻译路由硬失败（无适配器 / 无凭证 / 鉴权失败） | 记入黑名单，不再对该路由重试 |
| 翻译流自身携带 reasoning | WeakSet 标记，不会递归翻译 |
| 翻译后 provider 签名失效 | `finish` chunk 的 replayState 剥离签名字段，走适配器官方降级路径（省略签名、保留文本） |

切分策略：缓冲至句读边界（中文标点或后随空白的 `.!?;`）且长度 ≥ `minChars` 时处理；超过 `maxChars` 强制切分（优先退到空白处）。小数（`3.14`）、缩写（`e.g.`）、文件名（`parser.ts`）不会造成误切。

## 文件

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host 插件入口源码（对象形式 `apply(ctx, config)`） |
| `dist/index.min.js` | esbuild 压缩产物，`package.json` 的 `exports` 指向这里 |
| `dist/index.d.ts` | `tsc` 生成的类型声明 |
| `icon.svg` | 插件图标（原创） |
| `locale/{en,zh}.json` | Plugin Manager 展示的标题与描述 |
| `tsconfig.json` | TypeScript 编译配置（`src` → `dist`，strict 模式） |
| `cordis.patch.yml` | 把插件行 `dsh-chinese-thinking` 插入 profile 配置树 |
| `package.json` | 组合包清单（`dsh.bundle.patch`） |

## 开发

本项目为 TypeScript 工程，源码在 `src/`，编译输出到 `dist/`：

```
pnpm install        # 安装 typescript、esbuild 等开发依赖
pnpm run build      # tsc 出类型声明 + esbuild 压缩出 dist/index.min.js（安装 bundle 前必须先执行）
pnpm run typecheck  # 只做类型检查，不输出
pnpm run watch      # 监听类型声明，改动后自动重新生成
```

修改 `src/index.ts` 后请重新执行 `pnpm run build`，bundle 运行时加载的是 `dist/index.min.js`。
`@deepseek-ai/dsh-llm` 仅为类型依赖（`import type`，构建时擦除），运行时不需要。

调试翻译时可设置 `CT_DEBUG=1`，日志会输出每次翻译的字符数、输入/输出 token、缓存命中与回退原因。

## 配置

在 `cordis.patch.yml` 的 row `config` 中调整（patch 替换整份 config，请保留想留下的字段）：

```yaml
- id: dsh-chinese-thinking
  name: '@devilspiderx/dsh-chinese-thinking'
  config:
    enabled: true           # false 临时关闭整个插件
    promptEnabled: true     # 保留系统提示词劝导段
    translate: false        # 默认 false：零额外模型请求
    # order: 10250          # 默认排在系统提示词末尾
    # text: |               # 可选：覆盖默认指令全文（覆盖后不自动追加强化段）
    #   ...
    # translationProvider: '' # 开启翻译时使用，空 = 跟随请求
    # translationModel: ''    # 建议指定廉价非思考模型
    # minChars: 24
    # maxChars: 480
    # batchChars: 400
    # skipChineseRatio: 0.5
    # timeoutMs: 20000
    # cacheSize: 256
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭整个插件 |
| `order` | `10250` | 段落排序，默认在 `deployment:persona-suffix` 之后 |
| `text` | 内置 | 覆盖默认思考语言规则；覆盖后不再自动追加强化段 |
| `promptEnabled` | `true` | 是否注册提示词段 |
| `translate` | `false` | 是否开启额外模型翻译 |
| `translationProvider` | 跟随请求 | 翻译路由 |
| `translationModel` | 跟随请求 | 建议指定廉价非思考模型 |
| `minChars` | `24` | 首个片段的最小缓冲字符数 |
| `maxChars` | `480` | 单片段硬切上限 |
| `batchChars` | `400` | 连续外语片段合批阈值；`0` = 逐片翻译 |
| `skipChineseRatio` | `0.5` | 汉字在“汉字 + 2×英文自然语言单词”中的占比阈值 |
| `timeoutMs` | `20000` | 单次翻译超时 |
| `cacheSize` | `256` | 翻译 LRU 缓存条数；`0` = 关闭 |

默认建议保持 `translate: false`；只有需要“展示必须是中文”的硬保证时再开启翻译。

## 安装

```
plugin_manager  action=install_bundle  target=<本目录绝对路径>
```

安装后如未即时生效（`restart-required`），重启 DSH 即可。
卸载：`plugin_manager action=remove_bundle target=@devilspiderx/dsh-chinese-thinking`。

## 已知边界

- 默认的纯提示词模式不是 100% 硬保证：当前回合如果模型仍用英文思考，内容不会被改写；强化规则从下一次请求起生效。
- 强化状态是进程级的：任一模型触发后，直到 DSH 重启前所有请求都会带上强化规则（约多 60 token/请求）。
- `translate: true` 的翻译调用会计入 provider 用量（与主请求分开计量），不计入会话的 usage 统计。
- 开启翻译后，会话日志中保存的是**译文**（中文思考），原文不保留；这是“始终展示中文”的必然结果。
- 翻译路由黑名单与翻译缓存都是进程级记忆；修改翻译路由配置后需重启 DSH 生效。
