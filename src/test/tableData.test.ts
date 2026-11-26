import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonCandidates } from "../parser";
import {
  buildTableFromArrayNode,
  buildTableFromJsonlRecords,
  formatTableAsCsv,
  formatTableAsMarkdown,
  isTabularArrayNode,
} from "../tableData";

test("isTabularArrayNode and buildTableFromArrayNode extract union columns and lossless cells", () => {
  const [candidate] = parseJsonCandidates(
    '[{"id":9007199254740993,"name":"Ada","meta":{"role":"admin"}},{"id":2,"name":"Grace","active":true}]',
  );
  assert.equal(isTabularArrayNode(candidate.tree), true);
  const table = buildTableFromArrayNode(candidate.tree, "$");
  assert.ok(table);
  assert.equal(table.flattened, false);
  assert.deepEqual(table.columns, ["id", "name", "meta", "active"]);
  assert.deepEqual(table.rows.map((row) => row.cells), [
    ["9007199254740993", "Ada", '{"role":"admin"}', ""],
    ["2", "Grace", "", "true"],
  ]);
  assert.equal(table.rows[0].rowLabel, "[0]");
  assert.equal(table.truncated, false);
});

test("buildTableFromJsonlRecords and formatTableAsCsv format RFC 4180 CSV and TSV safely", () => {
  const records = [
    { lineNumber: 0, tree: parseJsonCandidates('{"msg":"hello, \\"world\\"","count":1}')[0].tree },
    { lineNumber: 4, tree: parseJsonCandidates('{"msg":"line1\\nline2","extra":false}')[0].tree },
  ];
  const table = buildTableFromJsonlRecords(records, "demo.jsonl");
  assert.equal(table.sourceKind, "jsonl");
  assert.deepEqual(table.columns, ["msg", "count", "extra"]);
  assert.deepEqual(table.rows.map((row) => row.rowLabel), ["1", "5"]);

  const csv = formatTableAsCsv(
    table.columns,
    table.rows.map((row) => row.cells),
  );
  assert.equal(
    csv,
    'msg,count,extra\n"hello, ""world""",1,\n"line1\nline2",,false',
  );

  const tsv = formatTableAsCsv(
    ["col", "tab\tcol"],
    [["plain", "has\ttab"]],
    "\t",
  );
  assert.equal(tsv, 'col\t"tab\tcol"\nplain\t"has\ttab"');
});

test("buildTableFromArrayNode respects maxRows and maxColumns truncation", () => {
  const [candidate] = parseJsonCandidates('[{"a":1,"b":2,"c":3},{"a":4,"b":5,"c":6},{"a":7}]');
  const table = buildTableFromArrayNode(candidate.tree, "$", 2, 2);
  assert.ok(table);
  assert.equal(table.truncated, true);
  assert.equal(table.truncatedColumns, true);
  assert.deepEqual(table.columns, ["a", "b"]);
  assert.equal(table.rows.length, 2);
});

test("flatten option expands nested objects up to maxFlattenDepth while keeping arrays and deeper objects compact", () => {
  const [candidate] = parseJsonCandidates(
    JSON.stringify([
      {
        id: 1,
        user: {
          id: 42,
          profile: {
            name: "Ada",
            deep: { level4: { secret: "stay-compact" } },
          },
          tags: ["admin", "founder"],
        },
        emptyObj: {},
      },
      {
        id: 2,
        user: {
          id: 99,
          profile: {
            name: "Grace",
          },
        },
      },
    ]),
  );

  const flattened = buildTableFromArrayNode(candidate.tree, "$", { flatten: true });
  assert.ok(flattened);
  assert.equal(flattened.flattened, true);
  assert.equal(flattened.truncatedColumns, false);
  assert.deepEqual(flattened.columns, [
    "id",
    "user.id",
    "user.profile.name",
    "user.profile.deep.level4",
    "user.tags",
    "emptyObj",
  ]);
  assert.deepEqual(flattened.rows.map((r) => r.cells), [
    ["1", "42", "Ada", '{"secret":"stay-compact"}', '["admin","founder"]', "{}"],
    ["2", "99", "Grace", "", "", ""],
  ]);

  const depth1 = buildTableFromArrayNode(candidate.tree, "$", {
    flatten: true,
    maxFlattenDepth: 1,
  });
  assert.ok(depth1);
  assert.deepEqual(depth1.columns, ["id", "user.id", "user.profile", "user.tags", "emptyObj"]);

  const capped = buildTableFromArrayNode(candidate.tree, "$", {
    flatten: true,
    maxColumns: 3,
    maxRows: 1,
  });
  assert.ok(capped);
  assert.equal(capped.truncated, true);
  assert.equal(capped.truncatedColumns, true);
  assert.deepEqual(capped.columns, ["id", "user.id", "user.profile.name"]);
});

test("buildTableFromJsonlRecords supports options object with flatten and maxColumns", () => {
  const records = [
    { lineNumber: 0, tree: parseJsonCandidates('{"req":{"method":"GET","status":200}}')[0].tree },
    { lineNumber: 1, tree: parseJsonCandidates('{"req":{"method":"POST","status":500,"err":"boom"}}')[0].tree },
  ];

  const table = buildTableFromJsonlRecords(records, "requests.jsonl", false, {
    flatten: true,
    maxColumns: 2,
  });
  assert.equal(table.flattened, true);
  assert.equal(table.truncatedColumns, true);
  assert.deepEqual(table.columns, ["req.method", "req.status"]);
  assert.deepEqual(table.rows.map((r) => r.cells), [
    ["GET", "200"],
    ["POST", "500"],
  ]);
});

test("formatTableAsMarkdown escapes pipes and normalizes newlines into clean GFM tables", () => {
  const md = formatTableAsMarkdown(
    ["name", "expr | note", "multiline"],
    [
      ["Ada", "a|b", "line1\nline2"],
      ["Grace", "x || y", "win1\r\nwin2"],
    ],
  );
  assert.equal(
    md,
    [
      "| name | expr \\| note | multiline |",
      "| --- | --- | --- |",
      "| Ada | a\\|b | line1<br>line2 |",
      "| Grace | x \\|\\| y | win1<br>win2 |",
    ].join("\n"),
  );
  assert.equal(formatTableAsMarkdown([], []), "");
});
