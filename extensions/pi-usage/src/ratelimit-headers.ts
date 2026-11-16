import { formatAnthropicStatusWindows, progressBarUsed } from "./format.js";
import { formatIsoReset } from "./normalize-anthropic.js";
import type { AnthropicStatusWindow, AnthropicUsageReport } from "./types.js";
import { clampPercent } from "./utils.js";

/**
 * Anthropic subscription limits from the `anthropic-ratelimit-unified-*` response
 * headers. Providers that reach Claude through a proxy (e.g. CLIProxyAPI with
 * `passthrough-headers: true`) have no OAuth token for the usage endpoint, but
 * every response carries the same 5h / 7d windows in its headers.
 */

const PREFIX = "anthropic-ratelimit-unified-";
const WINDOW_ORDER = ["5h", "7d"];

/** Headers as pi passes them to `after_provider_response`: lower-case names. */
export type ResponseHeaders = Record<string, string | undefined>;

type HeaderWindow = { key: string; usedPercent: number; resetsAt?: string; status?: string };

/** Builds a report from the unified rate-limit headers, or `undefined` when they carry no window. */
export function parseAnthropicRatelimitHeaders(
  headers: ResponseHeaders,
  capturedAt: number,
): AnthropicUsageReport | undefined {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(PREFIX) && typeof value === "string") values.set(lower.slice(PREFIX.length), value.trim());
  }

  const windows: HeaderWindow[] = [];
  for (const [name, value] of values) {
    const match = name.match(/^([a-z0-9_]+)-utilization$/);
    if (!match) continue;
    const fraction = Number(value);
    if (value === "" || !Number.isFinite(fraction)) continue;
    const key = match[1];
    windows.push({
      key,
      // The header holds a fraction of the window: 0.02 is 2%.
      usedPercent: clampPercent(fraction * 100),
      resetsAt: epochSecondsToIso(values.get(`${key}-reset`)),
      status: values.get(`${key}-status`),
    });
  }
  if (windows.length === 0) return undefined;
  windows.sort((left, right) => windowRank(left.key) - windowRank(right.key) || left.key.localeCompare(right.key));

  const statusWindows: AnthropicStatusWindow[] = windows.map((window) => ({
    text: `${window.key} ${window.usedPercent.toFixed(0)}%${isLimited(window.status) ? " limited" : ""}`,
    resetsAt: window.resetsAt,
  }));

  const lines = ["  >_ Anthropic Usage (response headers)", "", "  Subscription usage:"];
  for (const window of windows) {
    const reset = window.resetsAt ? ` (resets ${formatIsoReset(window.resetsAt, window.key !== "5h")})` : "";
    const status = isLimited(window.status) ? ` [${window.status}]` : "";
    lines.push(
      `  ${window.key}: ${progressBarUsed(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used${reset}${status}`,
    );
  }
  const overall = values.get("status");
  if (overall) lines.push("", `  Status: ${overall}`);

  return {
    provider: "anthropic",
    source: "anthropic-headers",
    capturedAt,
    summaryLines: lines,
    statusline: `claude ${formatAnthropicStatusWindows(statusWindows)}`,
    statusWindows,
  };
}

function windowRank(key: string): number {
  const index = WINDOW_ORDER.indexOf(key);
  return index === -1 ? WINDOW_ORDER.length : index;
}

function isLimited(status: string | undefined): boolean {
  return status !== undefined && status !== "" && status !== "allowed" && status !== "allowed_warning";
}

function epochSecondsToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Last header report per pi provider. Module level on purpose: Pi Web runs many
 * sessions in one process, and a new session can show the last known limits of
 * its provider before its first response.
 */
const headerReports = new Map<string, AnthropicUsageReport>();

export function rememberHeaderReport(provider: string, report: AnthropicUsageReport): void {
  headerReports.set(provider, report);
}

export function headerReportFor(provider: string | undefined): AnthropicUsageReport | undefined {
  return provider ? headerReports.get(provider) : undefined;
}
