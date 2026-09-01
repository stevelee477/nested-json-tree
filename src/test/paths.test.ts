import assert from "node:assert/strict";
import test from "node:test";
import {
  JsonTreeOutputTooLargeError,
} from "../jsonTree";
import {
  MAX_DISPLAY_PATH_CHARACTERS,
  formatJqPath,
  formatJqPathForTransfer,
  formatJsonPath,
  formatJsonPathForDisplay,
  formatJsonPathForTransfer,
} from "../paths";

test("formats the root as a jq identity filter", () => {
  assert.equal(formatJqPath([]), ".");
});

test("formats ordinary object keys and array indexes", () => {
  assert.equal(formatJqPath(["users", 0, "name"]), ".users[0].name");
});

test("prefixes root array indexes with the jq identity selector", () => {
  assert.equal(formatJqPath([0]), ".[0]");
  assert.equal(formatJqPath([0, "name"]), ".[0].name");
});

test("quotes keys that are not simple jq identifiers", () => {
  assert.equal(formatJqPath(["display-name"]), '.["display-name"]');
  assert.equal(
    formatJqPath(["users", 0, "display-name", "space key"]),
    '.users[0]["display-name"]["space key"]',
  );
});

test("escapes quotes and control characters in jq key strings", () => {
  assert.equal(formatJqPath(['a"b', "line\nbreak"]), '.["a\\"b"]["line\\nbreak"]');
});

test("measures jq paths exactly before creating transfer output", () => {
  assert.equal(formatJqPathForTransfer([], 1), ".");
  assert.equal(formatJqPathForTransfer([0], 4), ".[0]");
  assert.equal(formatJqPathForTransfer(["name"], 5), ".name");
  assert.equal(formatJqPathForTransfer(["x-y"], 8), '.["x-y"]');
  assert.throws(() => formatJqPathForTransfer([0], 3), JsonTreeOutputTooLargeError);
  assert.throws(() => formatJqPathForTransfer(["name"], 4), JsonTreeOutputTooLargeError);
  assert.throws(() => formatJqPathForTransfer(["x-y"], 7), JsonTreeOutputTooLargeError);
});

test("formats complete JSONPath values for Host-side copy", () => {
  assert.equal(formatJsonPath([]), "$");
  assert.equal(
    formatJsonPath(["users", 0, "display-name", 'a"b']),
    '$.users[0]["display-name"]["a\\"b"]',
  );
});

test("rejects escaped transfer paths before allocating oversized output", () => {
  assert.equal(formatJsonPathForTransfer(["name"], 6), "$.name");
  assert.throws(
    () => formatJsonPathForTransfer(["\u0000".repeat(1_000_000)], 100),
    JsonTreeOutputTooLargeError,
  );
});

test("keeps ordinary display paths exact", () => {
  const path = ["users", 0, "display-name"] as Array<string | number>;
  assert.equal(formatJsonPathForDisplay(path), formatJsonPath(path));
});

test("bounds one huge key before formatting it for UI display", () => {
  const key = `HEAD-${"x".repeat(MAX_DISPLAY_PATH_CHARACTERS * 2)}-TAIL`;
  const display = formatJsonPathForDisplay([key]);
  assert.ok(display.length <= MAX_DISPLAY_PATH_CHARACTERS);
  assert.match(display, /HEAD-/);
  assert.match(display, /-TAIL/);
  assert.match(display, /key shortened/);
});

test("bounds long multi-segment display paths with an explicit omission marker", () => {
  const display = formatJsonPathForDisplay(
    ["a".repeat(400), "m".repeat(400), "z".repeat(400)],
    1_000,
  );
  assert.ok(display.length <= 1_000);
  assert.ok(display.startsWith("$.aaaa"));
  assert.ok(display.endsWith("zzzzzz"));
  assert.match(display, /path shortened/);
});
