import assert from "node:assert/strict";
import test from "node:test";
import { formatJqPath } from "../paths";

test("formats the root as a jq identity filter", () => {
  assert.equal(formatJqPath([]), ".");
});

test("formats ordinary object keys and array indexes", () => {
  assert.equal(formatJqPath(["users", 0, "name"]), ".users[0].name");
});

test("quotes keys that are not simple jq identifiers", () => {
  assert.equal(
    formatJqPath(["users", 0, "display-name", "space key"]),
    '.users[0]["display-name"]["space key"]',
  );
});

test("escapes quotes and control characters in jq key strings", () => {
  assert.equal(formatJqPath(['a"b', "line\nbreak"]), '["a\\"b"]["line\\nbreak"]');
});
