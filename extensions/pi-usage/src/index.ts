/**
 * Pi Usage Extension
 *
 * Reports provider usage and rate-limit budgets for OpenAI Codex and Anthropic
 * OAuth subscriptions via /usage, with a live statusline widget and custom
 * footer that right-aligns usage status.
 *
 * File layout:
 *   index.ts              extension entry point (this file) — commands + lifecycle events
 *   constants.ts          command name, URLs, timeouts, cache paths, UI constants
 *   types.ts              shared TypeScript types (public types exported)
 *   args.ts               /usage argument completions and parsing
 *   utils.ts              small helpers (asString, parseJsonObject, delay, etc.)
 *   errors.ts             UsageEndpointError, stale-context detection, rate-limit backoff
 *   http.ts               fetchWithTimeout
 *   models.ts             provider/model matching and auth candidate enumeration
 *   shared-cache.ts       on-disk shared usage cache read/write across pi sessions
 *   codex-auth.ts         resolve Pi Codex auth headers (+ WHAM + account id)
 *   codex-reset-credits.ts fetch/consume/expiry helpers for Codex banked resets
 *   codex-app-server.ts   CodexAppServerClient + queryViaCodexAppServer fallback
 *   normalize-codex.ts    normalize backend + app-server Codex rate-limit payloads
 *   normalize-anthropic.ts normalize Anthropic OAuth usage payloads
 *   codex-query.ts        queryViaPiAuth + queryCodexUsageWithFallback
 *   anthropic-auth.ts     resolve Pi Anthropic OAuth auth headers
 *   anthropic-query.ts    queryAnthropicUsage + fetchRawUsagePayloads (--raw)
 *   ratelimit-headers.ts  Anthropic limits from response headers (Claude via a proxy provider)
 *   query.ts              queryUsage, queryAllUsage, queryUsageWithRetries
 *   format.ts             usage report/statusline formatting and display notifications
 *   footer.ts             custom footer with right-aligned usage status
 *   statusline.ts         statusline state, timers, and background refresh
 *   command.ts            /usage command handler
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerUsageCommand } from "./command.js";
import { installUsageFooter } from "./footer.js";
import { isUsageSupportedModel } from "./models.js";
import { headerReportFor, parseAnthropicRatelimitHeaders, rememberHeaderReport } from "./ratelimit-headers.js";
import { createUsageStatusline } from "./statusline.js";

export { completeCodexStatusArguments, parseArgs } from "./args.js";
export { isStaleExtensionContextError } from "./errors.js";
export { formatCodexUsageReport, formatCodexUsageStatusline } from "./format.js";
export { normalizeAppServerResponse, normalizeBackendPayload } from "./normalize-codex.js";
export type {
  AnthropicUsageReport,
  CodexUsageReport,
  NormalizedCredits,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
  ProviderUsageModel,
} from "./types.js";

export default function usageExtension(pi: ExtensionAPI) {
  // pi calls this factory once per session but may reuse the imported module
  // for sessions with the same cwd (Pi Web runs many in one process), so all
  // per-session state lives here and not at module level.
  const statusline = createUsageStatusline();
  const {
    clearUsageStatusline,
    handleStaleContextError,
    refreshCurrentUsageStatusline,
    rethrowUnlessStaleContextError,
    setSessionActive,
    showHeaderReport,
  } = statusline;
  // The TUI drops extension footers when it replaces the session (/new, /resume),
  // so the flag belongs to this session's instance.
  let footerRegistered = false;

  registerUsageCommand(pi, statusline);

  const ensureUsageFooter = (ctx: ExtensionContext) => {
    if (footerRegistered || !ctx.hasUI) return;
    try {
      installUsageFooter(pi, ctx);
      footerRegistered = true;
    } catch (error) {
      if (!handleStaleContextError(ctx, error)) throw error;
    }
  };

  const showUsageForModel = (ctx: ExtensionContext, model: ExtensionContext["model"]) => {
    if (isUsageSupportedModel(model)) {
      void refreshCurrentUsageStatusline(ctx, model).catch(rethrowUnlessStaleContextError(ctx));
      return;
    }
    // Other providers: the last limits seen in their response headers, if any.
    const report = headerReportFor(model?.provider);
    if (report) showHeaderReport(ctx, report);
    else clearUsageStatusline(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    setSessionActive(true);
    ensureUsageFooter(ctx);
    showUsageForModel(ctx, ctx.model);
  });

  pi.on("session_tree", (_event, ctx) => {
    showUsageForModel(ctx, ctx.model);
  });

  pi.on("model_select", (event, ctx) => {
    showUsageForModel(ctx, event.model);
  });

  // Claude through a proxy provider (e.g. CLIProxyAPI with passthrough-headers):
  // no OAuth token for the usage endpoint, but each response carries the limits.
  // The native anthropic / openai-codex providers keep their OAuth query.
  pi.on("after_provider_response", (event, ctx) => {
    const model = ctx.model;
    if (!model || isUsageSupportedModel(model)) return;
    const report = parseAnthropicRatelimitHeaders(event.headers, Date.now());
    if (!report) return;
    rememberHeaderReport(model.provider, report);
    showHeaderReport(ctx, report);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    setSessionActive(false);
    clearUsageStatusline(ctx);
  });
}
