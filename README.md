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
| `index.js` | Host 插件入口（`apply(ctx, config)`） |
| `cordis.patch.yml` | 把插件行 `dsh-chinese-thinking` 插入 profile 配置树 |
| `package.json` | 组合包清单（`dsh.bundle.patch`） |

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
