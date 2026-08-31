import assert from "node:assert/strict";
import test from "node:test";
import {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  assertInputSize,
  encodeJsonStringLiteral,
  parseJsonCandidates,
  parseNestedJsonCandidates,
} from "../parser";

test("parses a complete JSON document", () => {
  const candidates = parseJsonCandidates('  {"name":"Ada","items":[1,2]}\n');
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { name: "Ada", items: [1, 2] });
});

test("extracts JSON surrounded by unrelated text", () => {
  const candidates = parseJsonCandidates('INFO response => {"ok":true,"text":"a } b"} elapsed=2ms');
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { ok: true, text: "a } b" });
});

test("returns multiple top-level JSON candidates", () => {
  const candidates = parseJsonCandidates('left {"a":1} middle [2,3] right');
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.value), [{ a: 1 }, [2, 3]]);
});

test("filters empty object and array candidates", () => {
  const candidates = parseJsonCandidates('before {} then [] then {"kept":true} after');
  assert.deepEqual(candidates.map((candidate) => candidate.value), [{ kept: true }]);
});

test("does not treat falsy primitive JSON values as empty", () => {
  assert.deepEqual(parseJsonCandidates("null")[0].value, null);
  assert.deepEqual(parseJsonCandidates("false")[0].value, false);
  assert.deepEqual(parseJsonCandidates("0")[0].value, 0);
  assert.deepEqual(parseJsonCandidates('""')[0].value, "");
});

test("returns no candidates when every JSON container is empty", () => {
  assert.deepEqual(parseJsonCandidates('prefix {} middle [] suffix'), []);
});

test("ignores invalid outer text while finding a valid nested candidate", () => {
  const candidates = parseJsonCandidates('broken { nope: [1,2] } end');
  assert.deepEqual(candidates.map((candidate) => candidate.value), [[1, 2]]);
});

test("does not accept structurally damaged JSON", () => {
  assert.deepEqual(parseJsonCandidates('prefix {"a": 1 suffix'), []);
});

test("unwraps an escaped nested JSON string", () => {
  const parent = JSON.parse('{"payload":"{\\"user\\":{\\"id\\":7}}"}') as { payload: string };
  const candidates = parseNestedJsonCandidates(parent.payload);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { user: { id: 7 } });
});

test("unwraps a JSON string encoded twice", () => {
  const twiceEncoded = JSON.stringify(JSON.stringify({ ok: true }));
  const candidates = parseNestedJsonCandidates(twiceEncoded);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { ok: true });
  assert.equal(candidates[0].unwrapDepth, 1);
});

test("extracts JSON from a nested string with surrounding text", () => {
  const candidates = parseNestedJsonCandidates('server said: {"status":"ok"}; done');
  assert.deepEqual(candidates[0].value, { status: "ok" });
});

test("encodes a decoded string as a complete escaped JSON literal", () => {
  const decoded = 'line 1\nline "2" \\ end\t';
  assert.equal(encodeJsonStringLiteral(decoded), '"line 1\\nline \\"2\\" \\\\ end\\t"');
});

test("enforces the 100 MB UTF-8 size limit", () => {
  assert.doesNotThrow(() => assertInputSize("a".repeat(MAX_INPUT_BYTES)));
  assert.throws(() => assertInputSize("界".repeat(Math.floor(MAX_INPUT_BYTES / 3) + 1)), InputTooLargeError);
});
