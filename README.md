# dsh-chinese-thinking

强制模型**思考（内部推理 / reasoning / 思维链）过程始终使用中文**的 DSH Host 插件。
回答语言不受影响，仍跟随用户提问的语言。

## 原理

向 `ctx.systemPrompt` 注册一个系统提示词段落（`dsh-chinese-thinking`，默认排序 `10`，
紧随部署人设前缀之后）。每次组装系统提示词时都会带上该段落，因此对主会话、
子代理与工作流子代理统一生效。

## 文件

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host 插件入口源码（对象形式 `apply(ctx, config)`） |
| `dist/index.min.js` | esbuild 压缩产物，`package.json` 的 `exports` 指向这里 |
| `dist/index.d.ts` | `tsc` 生成的类型声明 |
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

## 配置

在 `cordis.patch.yml` 的 row `config` 中调整（patch 替换整份 config，请保留想留下的字段）：

```yaml
- id: dsh-chinese-thinking
  name: '@devilspiderx/dsh-chinese-thinking'
  config:
    enabled: true    # false 临时关闭
    order: 10        # 系统提示词段落排序
    text: |          # 可选：覆盖默认指令全文
      ...
```

## 安装

```
plugin_manager  action=install_bundle  target=<本目录绝对路径>
```

安装后如未即时生效（`restart-required`），重启 DSH 即可。
卸载：`plugin_manager action=remove_bundle target=@devilspiderx/dsh-chinese-thinking`。
