import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../..");
const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>;
const placeholders = (text: string): string => (text.match(/\{\d+\}/g) ?? []).sort().join(",");

test("the Simplified Chinese bundle translates every runtime string exactly once", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { collectL10nKeys } = require(path.join(root, "scripts/l10n-keys.cjs")) as {
    collectL10nKeys(root: string): string[];
  };
  const keys = collectL10nKeys(root);
  const zh = readJson("l10n/bundle.l10n.zh-cn.json") as Record<string, string>;
  assert.deepEqual(keys.filter((key) => !(key in zh)), [], "missing translations");
  assert.deepEqual(Object.keys(zh).filter((key) => !keys.includes(key)), [], "stale translations");
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(placeholders(value), placeholders(key), `placeholders differ for: ${key}`);
    assert.ok(value.trim().length > 0, `empty translation for: ${key}`);
  }
});

test("manifest strings resolve in both English and Simplified Chinese", () => {
  const manifest = readFileSync(path.join(root, "package.json"), "utf8");
  const referenced = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]).sort();
  const en = readJson("package.nls.json");
  const zh = readJson("package.nls.zh-cn.json");
  assert.ok(referenced.length >= 7);
  assert.deepEqual(Object.keys(en).sort(), referenced);
  assert.deepEqual(Object.keys(zh).sort(), referenced);
  assert.equal(readJson("package.json").l10n, "./l10n");
});
