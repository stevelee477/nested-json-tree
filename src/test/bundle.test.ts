import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("extension bundle contains no unresolved jsonc-parser implementation requires", () => {
  const bundlePath = path.resolve(__dirname, "../extension.js");
  const bundle = readFileSync(bundlePath, "utf8");
  assert.match(bundle, /function parseTree/);
  assert.doesNotMatch(bundle, /require\(["']\.\/impl\//);
  assert.doesNotMatch(bundle, /require\(["']jsonc-parser["']\)/);
});
