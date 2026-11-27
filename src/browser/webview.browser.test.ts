/**
 * Runs the bundled Webview in real Chrome under the production CSP, with a
 * small mock Host. Complements the fast DOM-less harness in src/test.
 * Uses the installed Chrome (PLAYWRIGHT_CHANNEL overrides, e.g. "chromium").
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { type Browser, type Page, chromium } from "playwright-core";
import { startFixtureServer } from "./fixturePage";

const SAMPLE = JSON.stringify({
  requestId: "req_demo_4096",
  createdAt: 1767225600,
  isoTime: "2026-01-01T00:00:00.000Z",
  theme: { primary: "#3b82f6", accent: "rgb(234, 88, 12)" },
  docs: "https://example.com/docs",
  items: [
    { id: 10, name: "beta" },
    { id: 2, name: "alpha" },
  ],
  payload: JSON.stringify({ order: { id: 42, meta: JSON.stringify({ trace: "abc" }) } }),
});

function expectedLocalTimestampPrefix(ms: number): string {
  const date = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const tz = offset === 0
    ? "UTC"
    : `UTC${offset > 0 ? "+" : "-"}${Math.floor(Math.abs(offset) / 60)}${Math.abs(offset) % 60 === 0 ? "" : ":" + pad2(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${tz}`;
}

let server: Server;
let origin: string;
let browser: Browser;

before(async () => {
  ({ origin, server } = await startFixtureServer({
    en: { sample: SAMPLE },
    zh: { sample: SAMPLE, language: "zh" },
  }));
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

/** Opens the page and fails the test on any console error, page error, or CSP violation. */
async function open(language: "en" | "zh" = "en"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?scene=${language}`);
  await page.waitForSelector(".row .key");
  return { page, errors };
}

const row = (page: Page, key: string) => page.locator(".row", { has: page.locator(".key", { hasText: new RegExp(`^${key}$`) }) }).first();

test("the bundle renders under the production CSP without errors", async () => {
  const { page, errors } = await open();
  assert.equal(await page.locator(".row").first().locator(".key").textContent(), "$");
  assert.equal(await page.locator("#source-bar").isVisible(), true);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert.match(csp ?? "", /script-src 'nonce-fixtureNonce'/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("encoded strings expand inline, two levels deep, and search reaches inside", async () => {
  const { page, errors } = await open();
  await row(page, "payload").click();
  await row(page, "order").waitFor();
  assert.equal(await page.locator(".decoded-key").count(), 1);
  await row(page, "order").click();
  await row(page, "meta").click();
  await row(page, "trace").waitFor();
  assert.equal(await page.locator(".decoded-key").count(), 2);

  await page.fill("#search-input", "trace");
  await page.waitForFunction(() => /\d+ \/ \d+/.test(document.getElementById("search-count")?.textContent ?? ""));
  assert.equal(await row(page, "trace").isVisible(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("keyboard navigation, the actions menu, and focus restoration work in a real DOM", async () => {
  const { page, errors } = await open();
  await page.locator('[role="treeitem"]').first().focus();
  await page.keyboard.press("ArrowDown");
  assert.match(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""), /^requestId: /);
  await page.keyboard.press("Shift+F10");
  await page.locator("#menu:not(.hidden)").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Reveal in source");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#menu").isHidden(), true);
  assert.match(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""), /^requestId: /);
  await page.keyboard.press("End");
  assert.match(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""), /^payload: /);
  assert.deepEqual(errors, []);
  await page.close();
});

test("value hints render with real styles", async () => {
  const { page, errors } = await open();
  const expectedPrefix = expectedLocalTimestampPrefix(1767225600000);
  const createdHint = await row(page, "createdAt").locator(".value-hint").textContent();
  assert.ok(createdHint?.startsWith(expectedPrefix), `expected ${createdHint} to start with ${expectedPrefix}`);
  const isoHint = await row(page, "isoTime").locator(".value-hint").textContent();
  assert.ok(isoHint?.startsWith(expectedPrefix), `expected ${isoHint} to start with ${expectedPrefix}`);
  const swatches = await page.locator(".color-swatch").evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).backgroundColor));
  assert.deepEqual(swatches, ["rgb(59, 130, 246)", "rgb(234, 88, 12)"]);
  assert.equal(await row(page, "docs").locator(".value.link").count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("breadcrumb bar, depth selector, sort keys, inline preview, and table view work under CSP", async () => {
  const { page, errors } = await open();
  await row(page, "primary").click();
  const segments = await page.locator(".breadcrumb-segment").allTextContents();
  assert.deepEqual(segments, ["$", "theme", "primary"]);

  await page.selectOption("#expand-depth", "1");
  await row(page, "theme").locator(".inline-preview").waitFor();

  await page.click("#sort-keys");
  const topKeys = await page.locator('[role="treeitem"][aria-level="2"] .key').allTextContents();
  assert.deepEqual(topKeys, ["createdAt", "docs", "isoTime", "items", "payload", "requestId", "theme"]);

  await row(page, "items").click({ button: "right" });
  await page.locator(".menu-item", { hasText: "View as table" }).click();
  await page.locator("#table-view:not(.hidden)").waitFor();
  await page.locator("#data-table thead th", { hasText: "id" }).click();
  const firstId = await page.locator("#data-table tbody tr").first().locator("td").nth(1).textContent();
  assert.equal(firstId, "2");

  await page.locator("#data-table tbody tr").first().click();
  await page.locator("#table-view").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  await page.close();
});

test("the Simplified Chinese bundle localizes markup and runtime strings", async () => {
  const { page, errors } = await open("zh");
  assert.equal(await page.getAttribute("#search-input", "placeholder"), "搜索键和值…");
  assert.equal(await page.textContent("#collapse-all"), "全部收起");
  await row(page, "docs").click({ button: "right" });
  assert.equal(await page.locator(".menu-item").first().textContent(), "在源文件中定位");
  assert.deepEqual(errors, []);
  await page.close();
});

test("Value Inspector, Pinned fields, Search toggles, Diff view, and virtualized Table work under strict CSP", async () => {
  const { page, errors } = await open();

  // Pin a field and verify chip renders and jumps on click.
  await row(page, "requestId").click({ button: "right" });
  await page.locator(".menu-item", { hasText: "Pin field" }).click();
  await page.locator("#pinned-bar:not(.hidden)").waitFor();
  assert.match((await page.locator(".pinned-chip").first().textContent()) ?? "", /requestId:\s*req_demo_4096/);

  // Toggle Value Inspector drawer and verify focus tracking + wrap toggle.
  await page.click("#toggle-inspector");
  await page.locator("#inspector-drawer:not(.hidden)").waitFor();
  await row(page, "docs").click();
  assert.equal(await page.textContent("#inspector-path"), "$.docs");
  assert.equal(await page.textContent("#inspector-content"), "https://example.com/docs");
  await page.click("#inspector-wrap");
  assert.equal(await page.getAttribute("#inspector-wrap", "aria-pressed"), "false");

  // Search regex invalid indicator does not throw or violate CSP.
  await page.click("#search-regex");
  await page.fill("#search-input", "[unclosed");
  await page.waitForFunction(() => document.getElementById("search-count")?.textContent === "Invalid regex");
  await page.click("#clear-search");

  // Virtualized table (>100 rows) + BigInt sort under strict CSP (CSSOM spacer heights).
  await page.evaluate(() => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      rowLabel: `[${i}]`,
      cells: [i === 0 ? "9007199254740993" : i === 1 ? "9007199254740992" : String(i)],
    }));
    window.postMessage({
      type: "tableData",
      table: {
        title: "big-table",
        columns: ["snowflake"],
        rows,
        truncated: false,
        truncatedColumns: true,
        sourceKind: "array",
      },
    }, "*");
  });
  await page.locator("#table-view:not(.hidden)").waitFor();
  const mountedTrCount = await page.locator("#data-table tbody tr").count();
  assert.ok(mountedTrCount < 100, `expected virtualized table rows, got ${mountedTrCount}`);
  await page.click("#table-close");

  // Diff render view under strict CSP.
  await page.evaluate(() => {
    window.postMessage({
      type: "render",
      renderKey: 77,
      title: "Diff",
      pathLabel: "$",
      truncatedFieldCount: 0,
      autoExpand: true,
      canExpandAll: true,
      expandAllLimit: 100000,
      root: {
        id: 0,
        type: "object",
        children: [
          { key: "same", rawKey: '"same"', value: { id: 1, type: "number", raw: "1" } },
          { key: "latency", rawKey: '"latency"', value: { id: 2, type: "number", raw: "450" } },
        ],
      },
      diff: {
        summary: { added: 0, removed: 0, changed: 1, unchanged: 1 },
        annotations: { 2: { status: "changed", oldRaw: "120" } },
      },
    }, "*");
  });
  await page.locator("#diff-bar:not(.hidden)").waitFor();
  assert.equal(await page.textContent("#diff-changed-count"), "~1");
  assert.equal(await row(page, "latency").locator(".diff-old-value").textContent(), "120 → ");
  await page.check("#diff-changes-only");
  assert.equal(await row(page, "same").count(), 0);
  assert.equal(await row(page, "latency").count(), 1);

  assert.deepEqual(errors, []);
  await page.close();
});
