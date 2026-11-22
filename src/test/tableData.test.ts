import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonCandidates } from "../parser";
import {
  buildTableFromArrayNode,
  buildTableFromJsonlRecords,
  formatTableAsCsv,
  isTabularArrayNode,
} from "../tableData";

test("isTabularArrayNode and buildTableFromArrayNode extract union columns and lossless cells", () => {
  const [candidate] = parseJsonCandidates(
    '[{"id":9007199254740993,"name":"Ada","meta":{"role":"admin"}},{"id":2,"name":"Grace","active":true}]',
  );
  assert.equal(isTabularArrayNode(candidate.tree), true);
  const table = buildTableFromArrayNode(candidate.tree, "$");
  assert.ok(table);
  assert.deepEqual(table.columns, ["id", "name", "meta", "active"]);
  assert.deepEqual(table.rows.map((row) => row.cells), [
    ["9007199254740993", "Ada", '{"role":"admin"}', ""],
    ["2", "Grace", "", "true"],
  ]);
  assert.equal(table.rows[0].rowLabel, "[0]");
  assert.equal(table.truncated, false);
});

test("buildTableFromJsonlRecords and formatTableAsCsv format RFC 4180 CSV safely", () => {
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
