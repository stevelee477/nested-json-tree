import assert from "node:assert/strict";
import test from "node:test";
import { searchJson } from "../search";

const sample = {
  users: [
    { id: 7, displayName: "Ada Lovelace", active: true },
    { id: 8, displayName: "Grace Hopper", active: false },
  ],
  note: null,
};

test("searches keys case-insensitively in tree order", () => {
  assert.deepEqual(searchJson(sample, "DISPLAY").paths, [
    ["users", 0, "displayName"],
    ["users", 1, "displayName"],
  ]);
});

test("searches string, number, boolean, and null values", () => {
  assert.deepEqual(searchJson(sample, "hopper").paths, [["users", 1, "displayName"]]);
  assert.deepEqual(searchJson(sample, "8").paths, [["users", 1, "id"]]);
  assert.deepEqual(searchJson(sample, "false").paths, [["users", 1, "active"]]);
  assert.deepEqual(searchJson(sample, "null").paths, [["note"]]);
});

test("empty and whitespace-only searches return no matches", () => {
  assert.deepEqual(searchJson(sample, "  ").paths, []);
});

test("caps large result sets and reports truncation", () => {
  const result = searchJson(["match", "match", "match"], "match", 2);
  assert.equal(result.paths.length, 2);
  assert.equal(result.truncated, true);
});
