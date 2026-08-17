# dsh-localqwen-rolefix

> [简体中文](README.zh.md) | **English**

DSH (DeepSeek Harness) plugin: fix HTTP 400 ("Unexpected message role.") when using reasoning effort (thinking levels) with a local SGLang/vLLM Qwen model.

**Verified on DSH 0.1.0-rc.6 + SGLang + Qwen3.8-27B (qwen3_5 architecture).**

---

## Why

Once you declare reasoning capability for a local Qwen model in `settings.yaml` (`reasoningEfforts` / `compat.supportsReasoningEffort`):

1. pi-ai sends the system prompt with `role: "developer"` instead of `"system"` (source: `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`);
2. SGLang's Qwen3.x chat template only accepts `system / user / assistant / tool` and rejects `developer` with **HTTP 400 `"Unexpected message role."`**;
3. DSH misclassifies the body-less 400 as `CONTEXT_WINDOW_EXCEEDED` and shows `400 status code (no body)`.

> Note: the `reasoning_effort` parameter itself is fine (the server accepts `none/low/medium/xhigh`). Only the role switch breaks.

## How it works

The request object (`GenerateOptions`) is **deep-frozen** before dispatch, so the `llm/stream` waterfall cannot rewrite the request. This plugin instead flips the **pi-ai model descriptor's** `compat.supportsDeveloperRole = false` on every dispatch:

- pi-ai reads the descriptor at stream time (it is not frozen) → the role falls back to `"system"`;
- `model.reasoning` stays `true` → the effort menu and `reasoning_effort` keep working;
- re-applies on every request (self-healing after settings hot-reloads);
- **no DSH sources are modified** — survives upgrades.

---

## Install

### Method A: published package (simple)

Requires pnpm (`corepack enable pnpm` or `npm i -g pnpm`), then one command:

```bash
dsh plugin --profile web add dsh-localqwen-rolefix
```

The package declares `dsh.bundle`, so it joins the profile layer stack automatically, then **restart dsh web**.

To override defaults (provider list / log path), add an id-targeted config override to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-localqwen-rolefix
  config:
    providers: [sglang-local]   # empty = all providers
    logPath: ""                 # optional: runtime log file path
```

### Method B: manual local file (no pnpm)

1. Put `index.js` at `<profile>/plugins/dsh-localqwen-rolefix/index.js` — e.g. `~/.dsh/profiles/web/plugins/dsh-localqwen-rolefix/index.js`.

2. Append to `<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-localqwen-rolefix
      name: ./plugins/dsh-localqwen-rolefix/index.js
      inject: [llm]          # required by cordis
      config:
        providers:
          - sglang-local     # provider route keys; empty = all
        logPath: ""          # optional runtime log
```

3. **Restart dsh web.**

### Configure reasoning effort (settings.yaml)

Qwen3.8-27B official `reasoning_effort` levels are only `none / low / medium / xhigh` — do **not** declare `minimal/high/max`:

```yaml
llm-pi-ai:
  providers:
    sglang-local:
      displayName: Local sglang (Qwen3)
      api: openai-completions
      baseURL: http://localhost:30000/v1
      apiKeyEnv: SGLANG_LOCAL_API_KEY
      reasoning: xhigh        # default level (matches the model's own default);
                              # without it, "Default" is treated as thinking off
      models:
        - id: /path/to/models/Qwen/Qwen3.8-27B-FP8
          name: Qwen3.8-27B-FP8 (local sglang)
          contextWindow: 262144
          maxTokens: 16384
          compat:
            supportsReasoningEffort: true   # send top-level reasoning_effort
          reasoningEfforts:
            off: none        # none = officially disable thinking
            low: low
            medium: medium
            xhigh: xhigh
```

> Do **not** set `compat.thinkingFormat: qwen` — that branch only sends a boolean `enable_thinking` and the `medium/xhigh` levels never reach the server. Keep the default (openai) format so the top-level `reasoning_effort` is sent.

After restart, the model picker shows an effort menu: **Off / Low / Medium / Xhigh** (default Xhigh).

---

## Verify

With `logPath` configured, every request appends a probe line; a healthy one looks like:

```
2026-08-17T08:22:13.212Z stream: {"provider":"sglang-local","model":"/home/...","hasLlm":true,"hasRegistration":true,"hasAdapter":true,"isPiAi":true,"hasModel":true,"compatBefore":{"supportsReasoningEffort":true},"flipped":true,"systemFrozen":true}
```

`flipped: true` means the plugin is active.

---

## Notes

- Relies on pi-ai internals (`ctx.llm.adapters` registry, `adapter.current().models.getModel()`). If a DSH update changes those shapes, the plugin **fails open** (logs the probe, request goes out unchanged) — watch the log after upgrading.
- This is an upstream DSH gap: `compat.supportsDeveloperRole` should be configurable. Consider reporting it to [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- SGLang should be launched with `--reasoning-parser qwen3 --tool-call-parser qwen3_coder` (official Qwen3.8 cookbook), otherwise tool-call parsing fails.

## FAQ

**Q: Why not use the `user` role?**
A: `system` is the model's native instruction channel and is fully supported by SGLang (verified 200); `user` would mix instructions into the conversation history and weaken the instruction hierarchy. `developer` is the only rejected role.

**Q: Still 400 after installing?**
A: Check the log for `flipped: true`; make sure `inject: [llm]` is in the entry; make sure dsh web was restarted (plugin file changes never hot-update a running process).

## License

MIT
