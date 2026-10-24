// Renders README screenshots of the real Webview bundle in Chrome, themed with
// VS Code's Dark Modern colors. Run `npm run screenshots` after `npm run compile`.
"use strict";
/* global document -- page.evaluate callbacks run in the browser. */
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { DARK_MODERN, startFixtureServer } = require("../out/browser/fixturePage.js");

const root = path.resolve(__dirname, "..");
const logLines = readFileSync(path.join(root, "examples/demo.log"), "utf8").split("\n");
const sample = logLines[1];

/** Crops below the last visible row (or the open menu), with a small margin. */
async function capture(page, file) {
  await page.waitForTimeout(150);
  const size = await page.evaluate(() => {
    const bottoms = [...document.querySelectorAll(".row, #menu:not(.hidden)")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.height > 0)
      .map((rect) => rect.bottom);
    return { width: document.documentElement.clientWidth, height: Math.ceil(Math.max(...bottoms)) + 14 };
  });
  await page.screenshot({
    path: path.join(root, "assets/screenshots", file),
    clip: { x: 0, y: 0, width: size.width, height: size.height },
  });
  console.log(`wrote assets/screenshots/${file}`);
}

async function main() {
  const scene = { sample, title: "JSON Tree · demo.log:2", theme: DARK_MODERN };
  const { origin, server } = await startFixtureServer({
    en: scene,
    zh: { ...scene, title: "JSON 树 · demo.log:2", language: "zh" },
  });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
  try {
    for (const language of ["en", "zh"]) {
      const page = await browser.newPage({ viewport: { width: 760, height: 640 }, deviceScaleFactor: 2 });
      await page.goto(`${origin}/?scene=${language}`);
      const row = (key) => page.locator(".row", { has: page.locator(".key", { hasText: new RegExp(`^${key}$`) }) }).first();
      await row("body").click();
      await row("items").click();
      await row("0").click();
      await row("trace").click();
      await row("tags").waitFor();
      // Clicking rows focuses them; screenshots show the resting state.
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(0, 0);
      if (language === "en") {
        await capture(page, "inline-decoding.png");
      } else {
        await row("span").click({ button: "right", position: { x: 60, y: 8 } });
        await capture(page, "zh-cn.png");
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
