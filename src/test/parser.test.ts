import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { stringifyJsonTree } from "../jsonTree";
import {
  InputTooLargeError,
  JsonCandidateLimitError,
  JsonContainerScanLimitError,
  JsonNestingTooDeepError,
  JsonValueNodeLimitError,
  MAX_CONTAINER_SPANS,
  MAX_INPUT_BYTES,
  MAX_JSON_CANDIDATES,
  MAX_JSON_NESTING,
  MAX_JSON_VALUE_NODES,
  assertInputSize,
  encodeJsonStringLiteral,
  parseJsonCandidates,
  parseNestedJsonCandidates,
} from "../parser";

test("parses a complete JSON document", () => {
  const candidates = parseJsonCandidates('  {"name":"Ada","items":[1,2]}\n');
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { name: "Ada", items: [1, 2] });
  assert.equal(candidates[0].tree.type, "object");
});

test("extracts JSON surrounded by unrelated text", () => {
  const candidates = parseJsonCandidates('INFO response => {"ok":true,"text":"a } b"} elapsed=2ms');
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { ok: true, text: "a } b" });
});

test("recovers from unmatched quotes in unrelated prefix text", () => {
  const candidates = parseJsonCandidates('WARN unmatched " prefix {"ok":true} suffix');
  assert.deepEqual(candidates.map((candidate) => candidate.value), [{ ok: true }]);
});

test("ignores brackets inside balanced quoted prefix text", () => {
  assert.deepEqual(
    parseJsonCandidates('prefix "noise { bracket" {"ok":true} suffix').map(
      (candidate) => candidate.value,
    ),
    [{ ok: true }],
  );
  assert.deepEqual(
    parseJsonCandidates('prefix "noise [ bracket" [{"ok":true}] suffix').map(
      (candidate) => candidate.value,
    ),
    [[{ ok: true }]],
  );
});

test("does not surface JSON-looking values inside balanced prefix comments", () => {
  assert.deepEqual(
    parseJsonCandidates('prefix /* {"fake":1} */ {"real":2}').map((candidate) => candidate.value),
    [{ real: 2 }],
  );
  assert.deepEqual(
    parseJsonCandidates('prefix // {"fake":1}\n {"real":2}').map((candidate) => candidate.value),
    [{ real: 2 }],
  );
  assert.deepEqual(parseJsonCandidates('// {"fake":1}\n'), []);
  assert.deepEqual(parseJsonCandidates('prefix // {"fake":1}\n no json'), []);
});

test("recovers from URL-like prefix syntax without weakening malformed inner syntax", () => {
  assert.deepEqual(parseJsonCandidates('prefix http://host {"ok":1}').map((item) => item.value), [
    { ok: 1 },
  ]);
  assert.deepEqual(parseJsonCandidates('prefix { bad http://host {"ok":1}'), []);
});

test("recovery replaces strict inner fragments with a valid multiline outer candidate", () => {
  const expected = [[{ a: 1 }, { b: 2 }]];
  assert.deepEqual(
    parseJsonCandidates('INFO http://host [\n {"a":1},\n {"b":2}\n]').map(
      (candidate) => candidate.value,
    ),
    expected,
  );
  assert.deepEqual(
    parseJsonCandidates('INFO // payload [\n {"a":1},\n {"b":2}\n]').map(
      (candidate) => candidate.value,
    ),
    expected,
  );
});

test("balanced quoted prefix delimiters cannot trigger the recovery nesting limit", () => {
  const input = `"${"{".repeat(MAX_JSON_NESTING + 1)}" {"ok":1}`;
  assert.deepEqual(parseJsonCandidates(input).map((candidate) => candidate.value), [{ ok: 1 }]);
});

test("parses JSONC comments and trailing commas", () => {
  const candidates = parseJsonCandidates(`
    // user settings
    {
      "name": "Ada",
      "items": [1, 2,],
    }
  `);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { name: "Ada", items: [1, 2] });
  assert.equal(candidates[0].tree.children?.[1].value.type, "array");
});

test("keeps large numbers and original string escapes in the lossless tree", () => {
  const [candidate] = parseJsonCandidates('{"big":9007199254740993,"letter":"\\u0061","slash":"\\/"}');
  assert.equal(candidate.tree.children?.[0].value.raw, "9007199254740993");
  assert.equal(candidate.tree.children?.[1].value.raw, '"\\u0061"');
  assert.equal(candidate.tree.children?.[1].value.value, "a");
  assert.equal(candidate.tree.children?.[2].value.raw, '"\\/"');
});

test("extracts a JSONC candidate while ignoring braces inside comments", () => {
  const input = `INFO http://localhost => {
    // a comment with a misleading }
    "ok": true,
    /* and another { misleading bracket */
  } elapsed=2ms`;
  const candidates = parseJsonCandidates(input);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].value, { ok: true });
  assert.equal(candidates[0].raw.startsWith("{"), true);
  assert.equal(candidates[0].raw.endsWith("}"), true);
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

test("filters an empty complete JSONC document without scanning its comments", () => {
  assert.deepEqual(parseJsonCandidates('/* {"fake":1} */ {}'), []);
  assert.deepEqual(parseJsonCandidates('// {"fake":1}\n []'), []);
});

test("ignores invalid outer text while finding a valid nested candidate", () => {
  const candidates = parseJsonCandidates('broken { nope: [1,2] } end');
  assert.deepEqual(candidates.map((candidate) => candidate.value), [[1, 2]]);
});

test("strict extraction can reject structurally damaged JSON", () => {
  assert.deepEqual(parseJsonCandidates('prefix {"a": 1 suffix', { allowPartial: false }), []);
});

test("rejects excessive unmatched nesting without scanning the full input", { timeout: 5_000 }, () => {
  const input = "{".repeat(2_000_000);
  const started = performance.now();
  assert.throws(() => parseJsonCandidates(input), JsonNestingTooDeepError);
  assert.ok(performance.now() - started < 1_500, "malformed input scan should remain linear");
});

test("rejects deeply nested malformed containers instead of repeatedly parsing them", { timeout: 5_000 }, () => {
  const input = "{".repeat(20_000) + "}".repeat(20_000);
  const started = performance.now();
  assert.throws(() => parseJsonCandidates(input), JsonNestingTooDeepError);
  assert.ok(performance.now() - started < 1_500, "nested malformed input should have bounded work");
});

test("accepts the maximum supported JSON nesting depth", () => {
  const input = "[".repeat(MAX_JSON_NESTING) + "0" + "]".repeat(MAX_JSON_NESTING);
  const [candidate] = parseJsonCandidates(input);
  assert.equal(candidate.start, 0);
  assert.equal(candidate.end, input.length);
});

test("does not silently replace an excessively deep complete value with an inner candidate", () => {
  const input = "[".repeat(MAX_JSON_NESTING + 1) + "0" + "]".repeat(MAX_JSON_NESTING + 1);
  assert.throws(() => parseJsonCandidates(input), JsonNestingTooDeepError);
});

test("limits value nodes before building a large syntax tree", { timeout: 5_000 }, () => {
  const accepted = `[${"0,".repeat(MAX_JSON_VALUE_NODES - 2)}0]`;
  assert.equal(parseJsonCandidates(accepted)[0].tree.children?.length, MAX_JSON_VALUE_NODES - 1);

  const rejected = `[${"0,".repeat(MAX_JSON_VALUE_NODES - 1)}0]`;
  assert.throws(() => parseJsonCandidates(rejected), JsonValueNodeLimitError);
});

test("applies the value-node limit across all returned candidates", { timeout: 5_000 }, () => {
  const fiftyThousandNodes = `[${"0,".repeat(49_998)}0]`;
  assert.equal(
    parseJsonCandidates(`${fiftyThousandNodes} ${fiftyThousandNodes}`).reduce(
      (total, candidate) => total + candidate.nodeCount,
      0,
    ),
    MAX_JSON_VALUE_NODES,
  );

  const fiftyThousandAndOneNodes = `[${"0,".repeat(49_999)}0]`;
  assert.throws(
    () => parseJsonCandidates(`${fiftyThousandNodes} ${fiftyThousandAndOneNodes}`),
    JsonValueNodeLimitError,
  );
});

test("limits potential container spans in surrounding text", { timeout: 5_000 }, () => {
  const input = "{} ".repeat(MAX_CONTAINER_SPANS + 1);
  assert.throws(() => parseJsonCandidates(input), JsonContainerScanLimitError);
});

test("limits extracted candidates before building an oversized picker", { timeout: 5_000 }, () => {
  assert.equal(parseJsonCandidates('{"ok":1} '.repeat(MAX_JSON_CANDIDATES)).length, MAX_JSON_CANDIDATES);
  assert.throws(
    () => parseJsonCandidates('{"ok":1} '.repeat(MAX_JSON_CANDIDATES + 1)),
    JsonCandidateLimitError,
  );
});

test("recovers a valid nested candidate after the malformed-parse budget is reached", () => {
  const input = "{".repeat(100) + "[1,2]" + "}".repeat(100);
  assert.deepEqual(parseJsonCandidates(input).map((candidate) => candidate.value), [[1, 2]]);
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

test("unwraps JSONC from a nested string", () => {
  const candidates = parseNestedJsonCandidates('{ /* nested */ "ok": true, }');
  assert.deepEqual(candidates[0].value, { ok: true });
});

test("encodes a decoded string as a complete escaped JSON literal", () => {
  const decoded = 'line 1\nline "2" \\ end\t';
  assert.equal(encodeJsonStringLiteral(decoded), '"line 1\\nline \\"2\\" \\\\ end\\t"');
});

test("enforces the 100 MB UTF-8 size limit", () => {
  assert.doesNotThrow(() => assertInputSize("a".repeat(MAX_INPUT_BYTES)));
  assert.throws(() => assertInputSize("界".repeat(Math.floor(MAX_INPUT_BYTES / 3) + 1)), InputTooLargeError);
});

test("recovers valid fields before and after an invalid value without guessing it", () => {
  const input = 'INFO {"before":1,"broken":undefined,"after":false} elapsed=2';
  const [candidate] = parseJsonCandidates(input);
  assert.deepEqual(candidate.value, { before: 1, after: false });
  assert.ok(candidate.recovery);
  assert.equal(candidate.raw, input.slice(candidate.start, candidate.end));
  assert.ok(candidate.recovery.issues.some((issue) => issue.code === "InvalidSymbol"));
  assert.equal(parseJsonCandidates(input, { allowPartial: false }).length, 0);
});

test("recovers missing separators and retains lossless tokens and duplicate keys", () => {
  const input = '{"n":9007199254740993 "s":"\\u0061","n":2}';
  const [candidate] = parseJsonCandidates(input);
  assert.ok(candidate.recovery);
  assert.deepEqual(candidate.tree.children?.map((child) => child.key), ["n", "s", "n"]);
  assert.equal(candidate.tree.children?.[0].value.raw, "9007199254740993");
  assert.equal(candidate.tree.children?.[1].value.raw, '"\\u0061"');
});

test("recovers truncated containers and omits incomplete properties and string tokens", () => {
  for (const input of ['{"ok":1,"missing":', '{"ok":1,"missing":"unfinished']) {
    const [candidate] = parseJsonCandidates(input);
    assert.deepEqual(candidate.value, { ok: 1 });
    assert.ok(candidate.recovery);
    assert.equal(candidate.raw, input);
  }
  const [nested] = parseJsonCandidates('{"ok":1,"nested":{"flag":true}');
  assert.deepEqual(nested.value, { ok: 1, nested: { flag: true } });
  assert.ok(nested.recovery);
});

test("does not turn malformed primitive tokens or keys into invented values", () => {
  for (const bad of ['01', '-01', '12abc', '1.2.3', '1e+2x', '1e', '12中文', '12@x', '12/xx', '12%', '12\u00a0x', 'truex', 'nullx', '"\\q"', '"\\u12"']) {
    const [candidate] = parseJsonCandidates(`{"bad":${bad},"ok":2}`);
    assert.deepEqual(candidate.value, { ok: 2 });
    assert.ok(candidate.recovery);
  }
  const [candidate] = parseJsonCandidates('{"bad\\q":1,"ok":2}');
  assert.deepEqual(candidate.value, { ok: 2 });
  assert.deepEqual(parseJsonCandidates('{"bad":oops}'), []);
  assert.deepEqual(parseJsonCandidates("{'bad':1}"), []);
});

test("retains useful outer fields instead of exposing only a valid inner fragment", () => {
  const input = '{"id":7,"nested":{"ok":true},"bad":oops}';
  const [candidate] = parseJsonCandidates(input);
  assert.equal(candidate.raw, input);
  assert.deepEqual(candidate.value, { id: 7, nested: { ok: true } });
  assert.ok(candidate.recovery);
});

test("a broken key/value gap does not attach an unrelated later container", () => {
  const candidates = parseJsonCandidates('{"id":1,"broken":oops {"next":2}}');
  assert.deepEqual(candidates.map((candidate) => candidate.value), [{ id: 1 }, { next: 2 }]);
  assert.ok(candidates[0].recovery);
  assert.equal(candidates[1].recovery, undefined);
  assert.ok(candidates[0].end <= candidates[1].start);
});

test("a truncated record does not swallow the next valid log record", () => {
  const candidates = parseJsonCandidates('{"id":1\nINFO {"next":2}');
  assert.deepEqual(candidates.map((candidate) => candidate.value), [{ id: 1 }, { next: 2 }]);
  assert.ok(candidates[0].recovery);
  assert.equal(candidates[1].recovery, undefined);
});

test("extracts adjacent and mixed complete/recovered JSON values from one line", () => {
  const input = 'prefix {"first":1}{"bad":oops,"second":2} [3,4] tail {"last":5}';
  const candidates = parseJsonCandidates(input);
  assert.deepEqual(candidates.map((candidate) => candidate.value), [
    { first: 1 }, { second: 2 }, [3, 4], { last: 5 },
  ]);
  assert.deepEqual(candidates.map((candidate) => Boolean(candidate.recovery)), [false, true, false, false]);
  for (const candidate of candidates) assert.equal(candidate.raw, input.slice(candidate.start, candidate.end));
});

test("recovery does not extract damaged JSON from balanced prefix strings or comments", () => {
  for (const prefix of ['/* {"fake":1,"bad":oops} */', '// {"fake":1,"bad":oops}\n']) {
    assert.deepEqual(parseJsonCandidates(`${prefix}{"real":2}`).map((candidate) => candidate.value), [{ real: 2 }]);
  }
});

test("nested decoded JSON also supports marked partial recovery", () => {
  const [candidate] = parseNestedJsonCandidates(JSON.stringify('{"id":7,"bad":oops}'));
  assert.deepEqual(candidate.value, { id: 7 });
  assert.equal(candidate.unwrapDepth, 1);
  assert.ok(candidate.recovery);
});

test("recovery diagnostics are bounded for many damaged fields", { timeout: 5_000 }, () => {
  const input = '{"ok":true,' + Array.from({ length: 3_000 }, (_, index) => `"bad${index}":oops`).join(',') + '}';
  const [candidate] = parseJsonCandidates(input);
  assert.deepEqual(candidate.value, { ok: true });
  assert.equal(candidate.nodeCount, 2);
  assert.ok(candidate.recovery && candidate.recovery.errorCount > 3_000);
  assert.equal(candidate.recovery.issues.length, 20);
});

test("does not reinterpret adjacent invalid numeric tokens as separate array values", () => {
  const [candidate] = parseJsonCandidates('[01,2,1.2.3,4]');
  assert.deepEqual(candidate.value, [2, 4]);
  assert.ok(candidate.recovery);
  assert.deepEqual(parseJsonCandidates('[01]'), []);
});

test("partial numeric recovery retains JSONC comments and whitespace-separated values", () => {
  const [candidate] = parseJsonCandidates('[/* first */1/* second */,2 3,"bad":oops]');
  assert.deepEqual(candidate.value, [1, 2, 3, "bad"]);
  assert.ok(candidate.recovery);
});

test("damaged inputs always retain source ranges and serialize to valid JSON", () => {
  const original = '{"id":7,"name":"hello\\nworld","items":[1,true,null,{"ok":false}],"last":3}';
  const mutations = ["", "oops", '"', "\\q", "01", "12中文", ":", ",", "{", "]"];
  for (let offset = 0; offset < original.length; offset += 1) {
    const inputs = [original.slice(0, offset)];
    for (const replacement of mutations) {
      inputs.push(original.slice(0, offset) + replacement + original.slice(offset + 1));
    }
    for (const input of inputs) {
      const candidates = parseJsonCandidates(input);
      let previousEnd = 0;
      for (const candidate of candidates) {
        assert.ok(candidate.start >= previousEnd, input);
        assert.equal(candidate.raw, input.slice(candidate.start, candidate.end), input);
        assert.doesNotThrow(() => JSON.parse(stringifyJsonTree(candidate.tree)), input);
        previousEnd = candidate.end;
      }
    }
  }
});
