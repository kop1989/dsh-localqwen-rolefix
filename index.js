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
 * This plugin flips the live pi-ai model descriptor's
 * compat.supportsDeveloperRole to false on every dispatch (pi-ai reads the
 * descriptor at stream time; it is not frozen). Requests then carry role
 * "system" while model.reasoning stays true, so the reasoning-effort menu
 * and the wire parameter `reasoning_effort` keep working. Re-applies per
 * request (self-healing across settings reloads).
 *
 * The descriptor flip is the only mutation performed; the llm/stream
 * options object is treated as read-only. Agent-loop requests are
 * deep-frozen before dispatch anyway, but auxiliary callers (notably
 * dsh-compaction-basic's cache-reusing summarization call) pass plain
 * mutable options whose system prompt and message prefix must stay
 * byte-identical to the last routed request for prefix/KV-cache reuse.
 * Rewriting options.system into a leading user message there would crash
 * the pi-ai adapter (a bare string is not a valid DSH message) and
 * silently disable automatic compaction — so this is never done.
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
      // `purpose` is undefined for agent-loop requests and identifies
      // auxiliary calls ("compaction", "session-title") in the log.
      const probe = { provider: options.provider, model: options.model, purpose: options.purpose };
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
        // options is intentionally left untouched: agent-loop requests are
        // deep-frozen (a rewrite would be a no-op or a throw), and auxiliary
        // callers (compaction summarization, session title) need
        // options.system / messages byte-identical to the replayed session
        // prefix — see header.
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
