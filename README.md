# dsh-chinese-thinking

让模型的**思考（内部推理 / reasoning / 思维链）过程始终以中文呈现**的 DSH Host 插件。
回答语言不受影响，仍跟随用户提问的语言。

适配任意模型：不依赖模型是否听从指令——提示词负责劝导，流式翻译负责兜底，
**只要思考过程可见，展示的就是中文**。对主会话、子代理、工作流子代理、
切会话 / 切模型 / 切窗口 / 切工作区全部生效。

## 原理（双层机制）

### 1. 提示词层（劝导）

向 `ctx.systemPrompt` 注册一个系统提示词段落（`dsh-chinese-thinking`，默认排序 `10`，
紧随部署人设前缀之后）。每次组装系统提示词时都会带上该段落，因此对主会话、
子代理与工作流子代理统一生效。模型听从时原生中文思考，零翻译开销。

### 2. 流式翻译层（兜底，核心）

监听 `llm/stream` waterfall（`{ global: true }` 注册在宿主上下文）：

```
模型流 ──▶ llm/stream waterfall ──▶ 适配器流
                │
                └─ 本插件：reasoning block 的增量按句缓冲
                          ↓
                   调用模型翻译成中文（默认同一 provider/model）
                          ↓
                   以 reasoning-delta 下发译文，并改写 block-end 最终文本
```

- 实时展示（`agent/assistant-stream` 帧）与落盘（`assistant/message` 内容块）
  拿到的都是中文思考，两者保持一致；
- 翻译请求默认复用被翻译请求的 provider/model（用户现有凭证即用），
  也可用 `translationProvider` / `translationModel` 指定专用路由；
- 翻译请求带 `reasoningEffort: 'off'`（适配器不接受时自动省略并记住该路由），
  低延迟低开销。

### 为什么能全覆盖

宿主内所有模型调用——主会话、子代理、工作流、session-title、compaction、
retry 重试——都走 `ctx.llm.stream()` 同一个入口，dispatch 经过 `llm/stream`
waterfall。监听器挂在宿主上下文且 `global: true`，因此与具体会话、模型、
窗口、工作区无关，天然全覆盖。

## 韧性设计

| 场景 | 行为 |
|---|---|
| 片段已是中文（CJK 占比 ≥ `skipChineseRatio`） | 直接放行，不发起翻译 |
| 纯代码 / 数字片段（字母占比过低） | 直接放行 |
| 翻译失败、超时（`timeoutMs`）、流异常 | 回退展示原文，思考不中断 |
| 翻译模型元回应（索要内容/拒绝翻译） | 识别后回退原文 |
| 翻译路由硬失败（无适配器 / 无凭证 / 鉴权失败） | 记入黑名单，不再对该路由重试 |
| 翻译流自身携带 reasoning | WeakSet 标记，不会递归翻译 |
| 翻译后 provider 签名失效 | `finish` chunk 的 replayState 剥离签名字段，走适配器官方降级路径（省略签名、保留文本），回放不报错 |

切分策略：缓冲至句读边界（中文标点或后随空白的 `.!?;`）且长度 ≥ `minChars` 时送译；
超过 `maxChars` 强制切分（优先退到空白处）。小数（`3.14`）、缩写（`e.g.`）、
文件名（`parser.ts`）不会造成误切。

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

## 配置

在 `cordis.patch.yml` 的 row `config` 中调整（patch 替换整份 config，请保留想留下的字段）：

```yaml
- id: dsh-chinese-thinking
  name: '@devilspiderx/dsh-chinese-thinking'
  config:
    enabled: true           # false 临时关闭整个插件
    order: 10               # 系统提示词段落排序
    promptEnabled: true     # 保留提示词劝导段
    translate: true         # 启用思考流中文翻译（核心）
    translationProvider: '' # 翻译 provider，空 = 跟随请求
    translationModel: ''    # 翻译 model，空 = 跟随请求
    minChars: 24            # 触发翻译的最小缓冲字符数
    maxChars: 480           # 单片段最大字符数（硬切上限）
    skipChineseRatio: 0.5   # 汉字占比阈值，达到即跳过翻译
    timeoutMs: 20000        # 单次翻译超时
    text: |                 # 可选：覆盖默认指令全文
      ...
```

## 安装

```
plugin_manager  action=install_bundle  target=<本目录绝对路径>
```

安装后如未即时生效（`restart-required`），重启 DSH 即可。
卸载：`plugin_manager action=remove_bundle target=@devilspiderx/dsh-chinese-thinking`。

## 已知边界

- 会话日志中保存的是**译文**（中文思考），原文不保留；这是「始终展示中文」的必然结果。
- 翻译调用会计入 provider 用量（与主请求分开计量），不计入会话的 usage 统计。
- 不可用路由黑名单是进程级记忆；修好翻译路由配置后需重启 DSH 生效。
