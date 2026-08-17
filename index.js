/**
 * qwen-system-role — DSH (DeepSeek Harness) profile plugin for local
 * SGLang/vLLM Qwen servers.
 *
 * Problem
 * -------
 * DSH's pi-ai adapter sends the system prompt with role "developer" whenever
 * a model is declared reasoning-capable (compat.supportsReasoningEffort /
 * reasoningEfforts present). SGLang's Qwen3.x chat templates only accept
 * system/user/assistant/tool and reject "developer" with HTTP 400
 * ("Unexpected message role."), which DSH surfaces as
 * "400 status code (no body)" and misclassifies as CONTEXT_WINDOW_EXCEEDED.
 *
 * Fix
 * ---
 * The GenerateOptions object is deep-frozen before dispatch, so the
 * llm/stream waterfall cannot rewrite the request. Instead, this plugin
 * flips the live pi-ai model descriptor's compat.supportsDeveloperRole to
 * false on every dispatch (pi-ai reads the descriptor at stream time; it is
 * not frozen). Requests then carry role "system" while model.reasoning
 * stays true, so the reasoning-effort menu and the wire parameter
 * `reasoning_effort` keep working. Re-applies per request (self-healing
 * across settings reloads).
 *
 * No DSH installation sources are modified; this survives upgrades.
 *
 * Install (pick one; see README for details)
 * ------------------------------------------
 * A. Published package (needs pnpm):  dsh plugin --profile web add dsh-localqwen-rolefix
 * B. Manual: put this file at <profile>/plugins/dsh-localqwen-rolefix/index.js
 *    and insert the plugin row into <profile>/cordis.patch.yml:
 *
 *      - insert:
 *          - id: dsh-localqwen-rolefix
 *            name: ./plugins/dsh-localqwen-rolefix/index.js
 *            inject: [llm]
 *            config:
 *              providers: [sglang-local]   # empty = all providers
 *              logPath: ""                 # optional runtime log file
 *
 * Then restart dsh web. No node_modules changes required.
 *
 * Notes
 * -----
 * - `inject: [llm]` is required by cordis to access the llm service.
 * - `providers` empty/absent normalizes every provider route; explicit
 *   entries restrict it (id-targeted config overrides can be added in your
 *   own cordis.patch.yml).
 * - Depends on pi-ai internals (ctx.llm.adapters / Models.getModel). If a
 *   DSH update changes those shapes the plugin logs and fails open.
 */
import fs from "node:fs";

export const name = "dsh-localqwen-rolefix";

function makeLogger(logPath) {
  if (!logPath) return () => {};
  return (line) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* logging must never break the request path */
    }
  };
}

export function apply(ctx, config = {}) {
  const log = makeLogger(config.logPath);
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? new Set(config.providers)
    : null; // null = normalize all providers
  log(`apply: providers=${JSON.stringify(config.providers ?? [])}`);
  ctx.on(
    "llm/stream",
    (options, next) => {
      if (providers && !providers.has(options.provider)) return next();
      const probe = { provider: options.provider, model: options.model };
      try {
        // cordis gates ctx.<service> access behind declared injection; the
        // registry locator ctx.get() works from any context.
        let llm = null;
        try {
          llm = ctx.get?.("llm") ?? null;
        } catch {
          llm = null;
        }
        if (!llm) {
          try {
            llm = ctx.llm;
          } catch {
            llm = null;
          }
        }
        probe.hasLlm = llm != null;
        const registration = llm?.adapters?.get(options.provider);
        probe.hasRegistration = registration != null;
        const adapter = registration?.adapter;
        probe.hasAdapter = adapter != null;
        probe.isPiAi = adapter != null && typeof adapter.current === "function";
        if (probe.isPiAi) {
          const model = adapter.current().models.getModel(options.provider, options.model);
          probe.hasModel = model != null;
          if (model && model.compat) {
            probe.compatBefore = { ...model.compat };
            model.compat.supportsDeveloperRole = false;
            probe.flipped = true;
          }
        }
        // Belt-and-suspenders: only when the request object is actually
        // mutable (auxiliary requests such as title generation), also
        // rewrite the system slot into a leading user message.
        if (typeof options.system === "string" && options.system.length > 0) {
          const messagesExtensible = Array.isArray(options.messages) && Object.isExtensible(options.messages);
          const optionsWritable = Object.isExtensible(options) ||
            (Object.getOwnPropertyDescriptor(options, "messages")?.writable !== false);
          if (messagesExtensible && optionsWritable) {
            options.messages.unshift({ role: "user", content: options.system });
            try {
              delete options.system;
            } catch {
              options.system = undefined;
            }
            probe.rewroteToUser = true;
          } else {
            probe.systemFrozen = true;
          }
        }
      } catch (error) {
        probe.error = String(error?.stack ?? error);
      }
      log("stream: " + JSON.stringify(probe));
      return next();
    },
    { global: true, prepend: true },
  );
}

export default apply;
