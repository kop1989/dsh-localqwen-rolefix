# dsh-localqwen-rolefix

> [English](README.md) | **简体中文**

DSH（DeepSeek Harness）插件：修复本地 SGLang/vLLM Qwen 模型配置思考等级（reasoning effort）后所有请求 400 的问题。

**实测通过环境：DSH 0.1.0-rc.6 + SGLang + Qwen3.8-27B（qwen3_5 架构）。**

---

## 问题背景

在 `settings.yaml` 中给本地 Qwen 模型声明推理能力后：

1. pi-ai 会把系统提示从 `role: "system"` 切换为 `role: "developer"`（源码：`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`）；
2. SGLang 的 Qwen3.x 模板只认 `system / user / assistant / tool`，收到 `developer` 直接 **HTTP 400 `"Unexpected message role."`**；
3. DSH 把空 body 的 400 误判为 `CONTEXT_WINDOW_EXCEEDED`，界面报 `400 status code (no body)`。

> 注意：`reasoning_effort` 参数本身没问题（服务器接受 `none/low/medium/xhigh`），问题只出在角色切换。

## 原理

插件每次派发前翻转 **pi-ai 模型描述符**的 `compat.supportsDeveloperRole = false`——描述符翻转是它唯一的改动：

- 角色回到 `system`，SGLang 正常接受；
- `model.reasoning` 保持 `true`，思考等级菜单与 `reasoning_effort` 参数不受影响；
- 每个请求重新应用，settings 热加载后自愈；
- **从不改写** `llm/stream` 的 options 对象：agent loop 请求本就被深度冻结；自动压缩摘要、会话标题等辅助调用传入的是可变 options，且要求 `system` 提示词与消息保持会话前缀的逐字回放（provider 前缀/KV 缓存复用的前提）。改写它们会让 pi-ai 适配器崩溃并静默禁用自动压缩；
- **不改任何 DSH 安装源码**，升级后依然有效。

---

## 安装

### 方式 A：npm 包安装（简单）

需要 pnpm（`corepack enable pnpm` 或 `npm i -g pnpm`），然后一行命令：

```bash
dsh plugin --profile web add dsh-localqwen-rolefix
```

包声明了 `dsh.bundle`，会自动挂载到 profile，然后**重启 dsh web**。

覆盖默认配置（provider 列表 / 日志路径），在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- id: dsh-localqwen-rolefix
  config:
    providers: [sglang-local]   # 留空 = 所有 provider
    logPath: ""                 # 可选：运行时日志文件路径
```

### 方式 B：本地文件安装（无需 pnpm）

1. 把 `index.js` 放到 `<profile>/plugins/dsh-localqwen-rolefix/index.js`（例如 `~/.dsh/profiles/web/plugins/dsh-localqwen-rolefix/index.js`）。

2. 在 `<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-localqwen-rolefix
      name: ./plugins/dsh-localqwen-rolefix/index.js
      inject: [llm]          # cordis 依赖注入声明，必须
      config:
        providers:
          - sglang-local     # provider 路由名，留空 = 所有
        logPath: ""          # 可选运行时日志
```

3. **重启 dsh web。**

### 配置思考等级（settings.yaml）

Qwen3.8-27B 官方 `reasoning_effort` 仅支持 `none / low / medium / xhigh` 四档，**不要**声明 `minimal/high/max`：

```yaml
llm-pi-ai:
  providers:
    sglang-local:
      displayName: Local sglang (Qwen3)
      api: openai-completions
      baseURL: http://localhost:30000/v1
      apiKeyEnv: SGLANG_LOCAL_API_KEY
      reasoning: xhigh        # 默认档位（模型官方默认），不设会导致"Default"被当成关思考
      models:
        - id: /path/to/models/Qwen/Qwen3.8-27B-FP8
          name: Qwen3.8-27B-FP8 (local sglang)
          contextWindow: 262144
          maxTokens: 16384
          compat:
            supportsReasoningEffort: true   # 让 pi-ai 发送顶层 reasoning_effort
          reasoningEfforts:
            off: none        # none = 官方关闭思考
            low: low
            medium: medium
            xhigh: xhigh
```

> 不要写 `compat.thinkingFormat: qwen`：那只会发布尔 `enable_thinking`，`medium/xhigh` 传不出去。保持默认（openai）格式走顶层 `reasoning_effort`。

重启后模型选择器出现「推理等级」菜单：**Off / Low / Medium / Xhigh**（默认 Xhigh）。

---

## 验证

配置了 `logPath` 时，每次请求追加一行探测日志，正常形如：

```
2026-08-17T08:22:13.212Z stream: {"provider":"sglang-local","model":"/home/...","hasLlm":true,"hasRegistration":true,"hasAdapter":true,"isPiAi":true,"hasModel":true,"compatBefore":{"supportsReasoningEffort":true},"flipped":true}
```

`flipped: true` 即插件已生效。辅助调用会带 `purpose` 字段（`"compaction"`、`"session-title"`），确认这些行同样 `flipped: true` 且无 `error` 键。

---

## 注意事项

- 修复必须保持"只翻转描述符"：不要加入请求体改写（例如把 `options.system` 挪进首条 user 消息）。压缩摘要调用传入可变 options 且要求系统提示词原样保留——裸字符串消息会让 pi-ai 适配器崩溃，改写还会破坏摘要器依赖的前缀回放/KV 缓存复用（自动压缩会静默失效）。
- 依赖 pi-ai 内部结构（`ctx.llm.adapters` 注册表、`adapter.current().models.getModel()`）；DSH 升级后若结构变化，插件会 **fail-open**（记录日志、请求原样发出），升级后请留意日志。
- 这是 DSH 上游缺陷（推理模型默认发 `developer` 角色），建议向 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 反馈。
- SGLang 启动建议带 `--reasoning-parser qwen3 --tool-call-parser qwen3_coder`（Qwen3.8 官方 cookbook），否则工具调用解析会失败。

## 常见问题

**Q：为什么不用 user 角色？**
A：`system` 是模型原生指令通道，SGLang 明确支持（实测 200）；`user` 会把系统指令混入对话历史、弱化指令层级。唯一被拒的角色是 `developer`。

**Q：装完还是 400？**
A：看插件日志确认 `flipped: true`；确认条目里有 `inject: [llm]`；确认重启过 dsh web（插件文件改动不会热更新到已运行进程）。

## License

MIT
