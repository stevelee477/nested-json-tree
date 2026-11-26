import assert from "node:assert/strict";
import test from "node:test";
import { parseTree } from "jsonc-parser";
import {
  JsonTreeNode,
  buildJsonTree,
  buildJsonTreeContextIndex,
} from "../jsonTree";
import { SchemaTarget, generateTypesFromTree } from "../schemaGen";

function parseLosslessly(source: string): JsonTreeNode {
  const errors: unknown[] = [];
  const root = parseTree(source, errors as never[], { allowTrailingComma: true });
  assert.ok(root);
  assert.deepEqual(errors, []);
  return buildJsonTree(root, source);
}

const SAMPLE_COMPLEX_JSON = `{
  "traceId": 9007199254740993,
  "ratio": 0.75,
  "user": {
    "id": 42,
    "weird-key": "ok",
    "_id": "mongo-1"
  },
  "items": [
    { "sku": "A", "qty": 2, "note": null, "payload": 10 },
    { "sku": "B", "note": "fragile", "payload": "ten" },
    { "sku": "C", "qty": 5, "note": "rush", "payload": true }
  ],
  "emptyMeta": {},
  "emptyList": []
}`;

test("TypeScript generator merges array shapes, detects int64 via raw, and quotes non-identifiers", () => {
  const root = parseLosslessly(SAMPLE_COMPLEX_JSON);
  const ts = generateTypesFromTree(root, "typescript", { rootName: "OrderEvent" });

  assert.match(ts, /export interface OrderEvent \{/);
  assert.match(ts, /traceId: \/\* int64 \*\/ number;/);
  assert.match(ts, /ratio: number;/);
  assert.match(ts, /user: User;/);
  assert.match(ts, /items: Item\[\];/);
  assert.match(ts, /emptyMeta: Record<string, unknown>;/);
  assert.match(ts, /emptyList: unknown\[\];/);

  // User interface quotes "weird-key" while keeping valid identifiers unquoted
  assert.match(ts, /export interface User \{/);
  assert.match(ts, /id: number;/);
  assert.match(ts, /"weird-key": string;/);
  assert.match(ts, /_id: string;/);

  // Item interface marks qty optional, note nullable, and payload as heterogeneous union
  assert.match(ts, /export interface Item \{/);
  assert.match(ts, /sku: string;/);
  assert.match(ts, /qty\?: number;/);
  assert.match(ts, /note: string \| null;/);
  assert.match(ts, /payload: string \| number \| boolean;/);

  // Array of int64 values parenthesizes element type cleanly
  const bigArr = parseLosslessly("[1, -9007199254740995]");
  const bigArrTs = generateTypesFromTree(bigArr, "typescript");
  assert.equal(bigArrTs.trim(), "export type Root = (/* int64 */ number)[];");
});

test("JSON Schema generator emits valid Draft 2020-12 with integer vs number, required, and union types", () => {
  const root = parseLosslessly(SAMPLE_COMPLEX_JSON);
  const rawSchema = generateTypesFromTree(root, "json-schema", { rootName: "OrderEvent" });
  const schema = JSON.parse(rawSchema) as Record<string, unknown>;

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.title, "OrderEvent");
  assert.equal(schema.type, "object");

  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(props.traceId, { type: "integer" });
  assert.deepEqual(props.ratio, { type: "number" });

  const userSchema = props.user;
  const userProps = userSchema.properties as Record<string, unknown>;
  assert.deepEqual(userProps["weird-key"], { type: "string" });
  assert.deepEqual(userSchema.required, ["id", "weird-key", "_id"]);

  const itemsSchema = props.items;
  assert.equal(itemsSchema.type, "array");
  const itemElem = itemsSchema.items as Record<string, unknown>;
  assert.deepEqual(itemElem.required, ["sku", "note", "payload"]);
  const itemProps = itemElem.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(itemProps.qty, { type: "integer" });
  assert.deepEqual(itemProps.note, { type: ["string", "null"] });
  assert.deepEqual(itemProps.payload, { type: ["string", "integer", "boolean"] });

  // Union of structured object + primitive emits anyOf
  const mixedUnion = parseLosslessly('[{"a": 1}, "fallback", null]');
  const mixedSchema = JSON.parse(generateTypesFromTree(mixedUnion, "json-schema")) as {
    items: { anyOf: Array<Record<string, unknown>> };
  };
  assert.equal(mixedSchema.items.anyOf.length, 3);
  assert.equal(mixedSchema.items.anyOf[0].type, "object");
  assert.deepEqual(mixedSchema.items.anyOf[1], { type: "string" });
  assert.deepEqual(mixedSchema.items.anyOf[2], { type: "null" });
});

test("Zod generator emits quoted keys, .int(), .nullable(), .optional(), and z.union", () => {
  const root = parseLosslessly(SAMPLE_COMPLEX_JSON);
  const zodCode = generateTypesFromTree(root, "zod", { rootName: "Order" });

  assert.match(zodCode, /import \{ z \} from "zod";/);
  assert.match(zodCode, /export const OrderSchema = z\.object\(\{/);
  assert.match(zodCode, /traceId: z\.number\(\)\.int\(\),/);
  assert.match(zodCode, /ratio: z\.number\(\),/);
  assert.match(zodCode, /"weird-key": z\.string\(\),/);
  assert.match(zodCode, /qty: z\.number\(\)\.int\(\)\.optional\(\),/);
  assert.match(zodCode, /note: z\.string\(\)\.nullable\(\),/);
  assert.match(zodCode, /payload: z\.union\(\[z\.string\(\), z\.number\(\)\.int\(\), z\.boolean\(\)\]\),/);
  assert.match(zodCode, /emptyMeta: z\.record\(z\.string\(\), z\.unknown\(\)\),/);
  assert.match(zodCode, /export type Order = z\.infer<typeof OrderSchema>;/);
});

test("Go generator emits int64 for unsafe integers, exported fields, pointers, and json struct tags", () => {
  const root = parseLosslessly(SAMPLE_COMPLEX_JSON);
  const goCode = generateTypesFromTree(root, "go", { rootName: "order_event" });

  assert.match(goCode, /type OrderEvent struct \{/);
  assert.match(goCode, /\tTraceID int64 `json:"traceId"`/);
  assert.match(goCode, /\tRatio float64 `json:"ratio"`/);
  assert.match(goCode, /\tID int `json:"id"`/);
  assert.match(goCode, /\tWeirdKey string `json:"weird-key"`/);
  assert.match(goCode, /\tQty \*int `json:"qty,omitempty"`/);
  assert.match(goCode, /\tNote \*string `json:"note"`/);
  assert.match(goCode, /\tPayload any `json:"payload"`/);
  assert.match(goCode, /\tEmptyMeta map\[string\]any `json:"emptyMeta"`/);

  // Special Go keys: "-", colliding keys "a-b" & "a_b", numeric key "123"
  const trickyGo = generateTypesFromTree(
    parseLosslessly('{"-":1,"a-b":2,"a_b":3,"123":true}'),
    "go",
  );
  assert.match(trickyGo, /\tField int `json:"-,"`/);
  assert.match(trickyGo, /\tAB int `json:"a-b"`/);
  assert.match(trickyGo, /\tAB2 int `json:"a_b"`/);
  assert.match(trickyGo, /\tField123 bool `json:"123"`/);
});

test("Python generator emits Pydantic v2 BaseModel in dependency order with Field(alias=...)", () => {
  const root = parseLosslessly(
    '{"class":"gold","_id":"abc","model_name":"gpt","weird-key":1,"weird_key":2,"child":{"ok":true},"items":[{"tag":"x"},{"other":5}]}',
  );
  const py = generateTypesFromTree(root, "python", { rootName: "Account" });

  assert.match(py, /from __future__ import annotations/);
  assert.match(py, /from pydantic import BaseModel, ConfigDict, Field/);
  assert.match(py, /model_config = ConfigDict\(populate_by_name=True\)/);

  // Child models appear BEFORE parent Account model
  const childIdx = py.indexOf("class Child(BaseModel):");
  const itemIdx = py.indexOf("class Item(BaseModel):");
  const accountIdx = py.indexOf("class Account(BaseModel):");
  assert.ok(childIdx >= 0 && childIdx < accountIdx);
  assert.ok(itemIdx >= 0 && itemIdx < accountIdx);

  // Keywords, leading underscores, model_* namespace, and hyphens all use Field(alias=...)
  assert.match(py, /class_: str = Field\(alias="class"\)/);
  assert.match(py, /id: str = Field\(alias="_id"\)/);
  assert.match(py, /field_model_name: str = Field\(alias="model_name"\)/);
  assert.match(py, /weird_key_2: int = Field\(alias="weird-key"\)/);
  assert.match(py, /weird_key: int\b/);
  assert.match(py, /tag: str \| None = None/);
  assert.match(py, /other: int \| None = None/);
});

test("generateTypesFromTree infers from root.decoded.root when root is a decoded string", () => {
  const outer = parseLosslessly('"{\\"service\\":\\"auth\\",\\"port\\":8080}"');
  // Without decoded attached, root is treated as a plain string
  assert.equal(generateTypesFromTree(outer, "typescript").trim(), "export type Root = string;");

  // Once decoded is attached on the string root, generateTypesFromTree unwraps root.decoded.root
  buildJsonTreeContextIndex(outer).attachDecoded(outer.id, {
    root: parseLosslessly('{"service":"auth","port":8080}'),
    unwrapDepth: 0,
  });

  const ts = generateTypesFromTree(outer, "typescript", { rootName: "ServiceConfig" });
  assert.match(ts, /export interface ServiceConfig \{/);
  assert.match(ts, /service: string;/);
  assert.match(ts, /port: number;/);
});

test("generateTypesFromTree handles __proto__, empty objects, and 5,000-level deep trees iteratively across all targets", () => {
  const protoRoot = parseLosslessly('{"__proto__":{"safe":true}}');
  const targets: SchemaTarget[] = ["typescript", "json-schema", "zod", "go", "python"];
  for (const target of targets) {
    const out = generateTypesFromTree(protoRoot, target);
    assert.ok(out.length > 0, `empty output for ${target}`);
    if (target === "json-schema") {
      const parsed = JSON.parse(out) as { properties: Record<string, unknown> };
      assert.equal(Object.prototype.hasOwnProperty.call(parsed.properties, "__proto__"), true);
    }
  }

  const emptyObj = parseLosslessly("{}");
  for (const target of targets) {
    const out = generateTypesFromTree(emptyObj, target);
    assert.ok(out.length > 0);
  }

  // Deep nesting stack-safety across every target (including iterative JSON Schema writer)
  let deep: JsonTreeNode = { id: 0, type: "number", raw: "9007199254740999" };
  for (let i = 0; i < 5_000; i += 1) {
    deep = { id: i + 1, type: "array", children: [{ key: 0, value: deep }] };
  }
  for (const target of targets) {
    const out = generateTypesFromTree(deep, target);
    assert.ok(out.length > 5_000, `expected deep output for ${target}`);
  }
});
