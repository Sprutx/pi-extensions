import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Pin the zone so wall-clock reset times are deterministic.
process.env.TZ = "UTC";

async function load(entry) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@earendil-works/*"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}

const { parseAnthropicRatelimitHeaders } = await load("ratelimit-headers.ts");
const { createUsageStatusline } = await load("statusline.ts");

const NOW = Date.parse("2026-11-16T18:10:00Z");
const epoch = (iso) => String(Date.parse(iso) / 1000);

// As CLIProxyAPI forwards them; pi passes lower-case names to after_provider_response.
const HEADERS = {
  "content-type": "application/json",
  "anthropic-ratelimit-unified-5h-reset": epoch("2026-11-16T20:30:00Z"),
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.02",
  "anthropic-ratelimit-unified-7d-reset": epoch("2026-11-22T04:00:00Z"),
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.06",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": epoch("2026-11-16T20:30:00Z"),
  "anthropic-ratelimit-unified-status": "allowed",
};

beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW }));
afterEach(() => mock.timers.reset());

test("utilization is a fraction; windows come in 5h, 7d order with resets", () => {
  const report = parseAnthropicRatelimitHeaders(HEADERS, NOW);
  assert.equal(report.provider, "anthropic");
  assert.equal(report.source, "anthropic-headers");
  assert.deepEqual(report.statusWindows, [
    { text: "5h 2%", resetsAt: "2026-11-16T20:30:00.000Z" },
    { text: "7d 6%", resetsAt: "2026-11-22T04:00:00.000Z" },
  ]);
  assert.equal(report.statusline, "claude 5h 2% ↻2h20m / 7d 6% ↻5d9h");
  assert.ok(report.summaryLines.some((line) => line.startsWith("  5h: [") && line.includes("2% used (resets 20:30)")));
});

test("the 7d_oi window is shown as Fable, like the OAuth path", () => {
  const report = parseAnthropicRatelimitHeaders(
    {
      ...HEADERS,
      "anthropic-ratelimit-unified-7d_oi-reset": epoch("2026-11-22T04:00:00Z"),
      "anthropic-ratelimit-unified-7d_oi-status": "allowed",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.02",
    },
    NOW,
  );
  assert.equal(report.statusline, "claude 5h 2% ↻2h20m / 7d 6% fable 2% ↻5d9h");
  assert.ok(report.summaryLines.some((line) => line.startsWith("  Fable 7d: [") && line.includes("2% used")));
});

test("overage headers are not windows", () => {
  const report = parseAnthropicRatelimitHeaders(HEADERS, NOW);
  assert.equal(report.statusWindows.length, 2);
});

test("a rejected window is marked", () => {
  const report = parseAnthropicRatelimitHeaders(
    {
      ...HEADERS,
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
    },
    NOW,
  );
  assert.equal(report.statusWindows[0].text, "5h 100% limited");
});

test("no unified headers, no report", () => {
  assert.equal(parseAnthropicRatelimitHeaders({ "content-type": "application/json" }, NOW), undefined);
  assert.equal(parseAnthropicRatelimitHeaders({ "anthropic-ratelimit-unified-status": "allowed" }, NOW), undefined);
});

test("statusline shows a header report, counts down and ages without a refresh", () => {
  const statuses = [];
  const ctx = { model: { provider: "or1-cpa", id: "claude-opus-5-5" }, ui: { setStatus: (_k, t) => statuses.push(t) } };
  const statusline = createUsageStatusline();
  statusline.setSessionActive(true);
  statusline.showHeaderReport(ctx, parseAnthropicRatelimitHeaders(HEADERS, NOW));
  assert.deepEqual(statuses, ["claude 5h 2% ↻2h20m / 7d 6% ↻5d9h"]);

  mock.timers.tick(60_100);
  assert.equal(statuses.at(-1), "claude 5h 2% ↻2h18m / 7d 6% ↻5d9h");

  mock.timers.tick(3 * 60_000);
  assert.equal(statuses.at(-1), "claude 5h 2% ↻2h15m / 7d 6% ↻5d9h (4m old)");
  assert.ok(statuses.every((text) => text !== undefined && text !== "checking"));

  statusline.setSessionActive(false);
  statusline.clearUsageStatusline(ctx);
});
