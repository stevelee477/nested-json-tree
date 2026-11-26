import type { JsonTreeNode } from "./jsonTree";

export type SchemaTarget = "typescript" | "json-schema" | "zod" | "go" | "python";

export interface SchemaGenOptions {
  rootName?: string;
}

type NumberKind = "none" | "int" | "int64" | "float";

interface PropertySchema {
  key: string;
  presentCount: number;
  schema: SchemaNode;
}

interface ObjectShape {
  objectCount: number;
  properties: Map<string, PropertySchema>;
  typeName?: string;
}

interface SchemaNode {
  hasNull: boolean;
  hasBoolean: boolean;
  hasString: boolean;
  numberKind: NumberKind;
  hasArray: boolean;
  arrayElem?: SchemaNode;
  objectShape?: ObjectShape;
}

const MIN_SAFE_BIGINT = -9007199254740991n;
const MAX_SAFE_BIGINT = 9007199254740991n;
const PURE_INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const JS_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PYTHON_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "type",
  "while",
  "with",
  "yield",
]);

const PYTHON_RESERVED_MODEL_ATTRS: ReadonlySet<string> = new Set([
  "copy",
  "dict",
  "json",
  "schema",
  "schema_json",
  "validate",
  "fields",
  "construct",
  "from_orm",
  "parse_obj",
  "parse_raw",
  "parse_file",
  "update_forward_refs",
]);

const GO_COMMON_INITIALISMS: ReadonlySet<string> = new Set([
  "ACL",
  "API",
  "ASCII",
  "CPU",
  "CSS",
  "DNS",
  "EOF",
  "GUID",
  "HTML",
  "HTTP",
  "HTTPS",
  "ID",
  "IP",
  "JSON",
  "LHS",
  "QPS",
  "RAM",
  "RHS",
  "RPC",
  "SLA",
  "SMTP",
  "SQL",
  "SSH",
  "TCP",
  "TLS",
  "TTL",
  "UDP",
  "UI",
  "UID",
  "URI",
  "URL",
  "UTF8",
  "UUID",
  "VM",
  "XML",
  "XMPP",
  "XSRF",
  "XSS",
]);

/**
 * Generates idiomatic type definitions or schemas from a lossless `JsonTreeNode`
 * without using recursion.
 */
export function generateTypesFromTree(
  root: JsonTreeNode,
  target: SchemaTarget,
  options: SchemaGenOptions = {},
): string {
  let effectiveRoot = root;
  while (effectiveRoot.type === "string" && effectiveRoot.decoded !== undefined) {
    effectiveRoot = effectiveRoot.decoded.root;
  }

  const rawRootName = options.rootName?.trim() || "Root";
  const rootTypeName = /^[A-Z][A-Za-z0-9]*$/.test(rawRootName)
    ? rawRootName
    : toPascalCase(rawRootName, "Root");

  const rootSchema = inferSchemaIterative(effectiveRoot);
  const { postOrder, namedObjects } = analyzeAndNameSchemas(rootSchema, rootTypeName);

  switch (target) {
    case "typescript":
      return emitTypeScript(rootSchema, rootTypeName, postOrder, namedObjects);
    case "json-schema":
      return emitJsonSchema(rootSchema, rawRootName);
    case "zod":
      return emitZod(rootSchema, rootTypeName, postOrder);
    case "go":
      return emitGo(rootSchema, rootTypeName, postOrder, namedObjects);
    case "python":
      return emitPython(rootSchema, rootTypeName, postOrder, namedObjects);
  }
}

function createEmptySchemaNode(): SchemaNode {
  return {
    hasNull: false,
    hasBoolean: false,
    hasString: false,
    numberKind: "none",
    hasArray: false,
  };
}

function classifyNumberRaw(raw: string | undefined, fallbackValue: unknown): NumberKind {
  const token = (raw ?? String(fallbackValue ?? 0)).trim();
  if (!PURE_INTEGER_PATTERN.test(token)) {
    return "float";
  }
  try {
    const value = BigInt(token);
    return value < MIN_SAFE_BIGINT || value > MAX_SAFE_BIGINT ? "int64" : "int";
  } catch {
    return "float";
  }
}

function widenNumberKind(current: NumberKind, next: NumberKind): NumberKind {
  if (current === "none") return next;
  if (next === "none") return current;
  if (current === "float" || next === "float") return "float";
  if (current === "int64" || next === "int64") return "int64";
  return "int";
}

function inferSchemaIterative(root: JsonTreeNode): SchemaNode {
  const rootSchema = createEmptySchemaNode();
  const stack: Array<{ ast: JsonTreeNode; schema: SchemaNode }> = [{ ast: root, schema: rootSchema }];

  while (stack.length > 0) {
    const { ast, schema } = stack.pop()!;
    if (ast.type === "null") {
      schema.hasNull = true;
      continue;
    }
    if (ast.type === "boolean") {
      schema.hasBoolean = true;
      continue;
    }
    if (ast.type === "string") {
      schema.hasString = true;
      continue;
    }
    if (ast.type === "number") {
      schema.numberKind = widenNumberKind(schema.numberKind, classifyNumberRaw(ast.raw, ast.value));
      continue;
    }
    if (ast.type === "array") {
      schema.hasArray = true;
      const children = ast.children ?? [];
      if (children.length > 0) {
        if (schema.arrayElem === undefined) {
          schema.arrayElem = createEmptySchemaNode();
        }
        for (let i = children.length - 1; i >= 0; i -= 1) {
          stack.push({ ast: children[i].value, schema: schema.arrayElem });
        }
      }
      continue;
    }
    if (ast.type === "object") {
      if (schema.objectShape === undefined) {
        schema.objectShape = { objectCount: 0, properties: new Map() };
      }
      const shape = schema.objectShape;
      shape.objectCount += 1;
      const children = ast.children ?? [];
      const seenInObject = new Set<string>();
      for (let i = 0; i < children.length; i += 1) {
        const key = String(children[i].key);
        let prop = shape.properties.get(key);
        if (prop === undefined) {
          prop = { key, presentCount: 0, schema: createEmptySchemaNode() };
          shape.properties.set(key, prop);
        }
        if (!seenInObject.has(key)) {
          seenInObject.add(key);
          prop.presentCount += 1;
        }
      }
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const key = String(children[i].key);
        const prop = shape.properties.get(key)!;
        stack.push({ ast: children[i].value, schema: prop.schema });
      }
    }
  }

  return rootSchema;
}

function isPureRootObject(rootSchema: SchemaNode): boolean {
  return (
    rootSchema.objectShape !== undefined &&
    !rootSchema.hasNull &&
    !rootSchema.hasBoolean &&
    !rootSchema.hasString &&
    rootSchema.numberKind === "none" &&
    !rootSchema.hasArray
  );
}

function analyzeAndNameSchemas(
  rootSchema: SchemaNode,
  rootTypeName: string,
): { postOrder: SchemaNode[]; namedObjects: ObjectShape[] } {
  const usedNames = new Set<string>();
  const claimName = (preferred: string, parentHint?: string): string => {
    if (!usedNames.has(preferred)) {
      usedNames.add(preferred);
      return preferred;
    }
    if (parentHint !== undefined) {
      const prefixed = `${parentHint}${preferred}`;
      if (!usedNames.has(prefixed)) {
        usedNames.add(prefixed);
        return prefixed;
      }
    }
    let suffix = 2;
    while (usedNames.has(`${preferred}${suffix}`)) {
      suffix += 1;
    }
    const candidate = `${preferred}${suffix}`;
    usedNames.add(candidate);
    return candidate;
  };

  if (!isPureRootObject(rootSchema)) {
    usedNames.add(rootTypeName);
  }

  const postOrder: SchemaNode[] = [];
  const namedObjects: ObjectShape[] = [];

  interface Frame {
    node: SchemaNode;
    suggestedName: string;
    parentName?: string;
    isRoot: boolean;
    expanded: boolean;
  }

  const stack: Frame[] = [
    { node: rootSchema, suggestedName: rootTypeName, isRoot: true, expanded: false },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.expanded) {
      postOrder.push(frame.node);
      continue;
    }
    frame.expanded = true;
    stack.push(frame);

    const { node, suggestedName, parentName, isRoot } = frame;
    let currentOwnerName = parentName ?? suggestedName;

    if (node.objectShape !== undefined) {
      const shouldName =
        node.objectShape.properties.size > 0 || (isRoot && isPureRootObject(node));
      if (shouldName) {
        const claimed = claimName(suggestedName, parentName);
        node.objectShape.typeName = claimed;
        namedObjects.push(node.objectShape);
        currentOwnerName = claimed;
      }
    }

    const props = node.objectShape !== undefined ? [...node.objectShape.properties.values()] : [];
    for (let i = props.length - 1; i >= 0; i -= 1) {
      const prop = props[i];
      const childSuggested = toPascalCase(prop.key, "Field");
      stack.push({
        node: prop.schema,
        suggestedName: childSuggested,
        parentName: currentOwnerName,
        isRoot: false,
        expanded: false,
      });
    }

    if (node.arrayElem !== undefined) {
      const elemSuggested = isRoot
        ? singularizePascal(rootTypeName, true)
        : singularizePascal(suggestedName, false);
      stack.push({
        node: node.arrayElem,
        suggestedName: elemSuggested,
        parentName: currentOwnerName,
        isRoot: false,
        expanded: false,
      });
    }
  }

  return { postOrder, namedObjects };
}

// ---------------------------------------------------------------------------
// 1. TypeScript Emitter
// ---------------------------------------------------------------------------

function emitTypeScript(
  rootSchema: SchemaNode,
  rootTypeName: string,
  postOrder: SchemaNode[],
  namedObjects: ObjectShape[],
): string {
  const exprMap = new Map<SchemaNode, string>();

  for (const node of postOrder) {
    const variants: string[] = [];
    if (node.objectShape !== undefined) {
      variants.push(
        node.objectShape.typeName !== undefined
          ? node.objectShape.typeName
          : "Record<string, unknown>",
      );
    }
    if (node.hasArray) {
      const elem = node.arrayElem !== undefined ? exprMap.get(node.arrayElem)! : "unknown";
      const needsParens = elem.includes("|") || elem.startsWith("/*");
      variants.push(needsParens ? `(${elem})[]` : `${elem}[]`);
    }
    if (node.hasString) variants.push("string");
    if (node.numberKind === "int64") variants.push("/* int64 */ number");
    else if (node.numberKind !== "none") variants.push("number");
    if (node.hasBoolean) variants.push("boolean");
    if (node.hasNull) variants.push("null");

    exprMap.set(node, variants.length === 0 ? "unknown" : variants.join(" | "));
  }

  const blocks: string[] = [];
  if (!isPureRootObject(rootSchema)) {
    blocks.push(`export type ${rootTypeName} = ${exprMap.get(rootSchema)!};`);
  }

  for (const shape of namedObjects) {
    const lines: string[] = [`export interface ${shape.typeName!} {`];
    for (const prop of shape.properties.values()) {
      const optional = prop.presentCount < shape.objectCount;
      const formattedKey = formatJsPropertyKey(prop.key);
      const propType = exprMap.get(prop.schema)!;
      lines.push(`  ${formattedKey}${optional ? "?" : ""}: ${propType};`);
    }
    lines.push("}");
    blocks.push(lines.join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// 2. JSON Schema (Draft 2020-12) Emitter (Iterative)
// ---------------------------------------------------------------------------

function emitJsonSchema(rootSchema: SchemaNode, title: string): string {
  const indentUnit = "  ";
  const output: string[] = [];

  type Task =
    | { kind: "text"; text: string }
    | { kind: "schema"; node: SchemaNode; depth: number; isRoot: boolean };

  const tasks: Task[] = [{ kind: "schema", node: rootSchema, depth: 0, isRoot: true }];

  const pushObjectEntries = (
    entries: Array<{ key: string; renderValue: () => void }>,
    depth: number,
  ): void => {
    if (entries.length === 0) {
      output.push("{}");
      return;
    }
    output.push("{\n");
    tasks.push({ kind: "text", text: `\n${indentUnit.repeat(depth)}}` });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (i < entries.length - 1) {
        tasks.push({ kind: "text", text: ",\n" });
      }
      entries[i].renderValue();
      tasks.push({
        kind: "text",
        text: `${indentUnit.repeat(depth + 1)}${JSON.stringify(entries[i].key)}: `,
      });
    }
  };

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "text") {
      output.push(task.text);
      continue;
    }

    const { node, depth, isRoot } = task;
    const headerEntries: Array<{ key: string; renderValue: () => void }> = [];
    if (isRoot) {
      headerEntries.push(
        {
          key: "$schema",
          renderValue: () => {
            tasks.push({
              kind: "text",
              text: JSON.stringify("https://json-schema.org/draft/2020-12/schema"),
            });
          },
        },
        {
          key: "title",
          renderValue: () => {
            tasks.push({ kind: "text", text: JSON.stringify(title) });
          },
        },
      );
    }

    const primitiveTypes: string[] = [];
    if (node.hasString) primitiveTypes.push("string");
    if (node.numberKind === "int" || node.numberKind === "int64") primitiveTypes.push("integer");
    else if (node.numberKind === "float") primitiveTypes.push("number");
    if (node.hasBoolean) primitiveTypes.push("boolean");
    if (node.hasNull) primitiveTypes.push("null");

    const hasObject = node.objectShape !== undefined;
    const hasArray = node.hasArray;
    const branchCount = (hasObject ? 1 : 0) + (hasArray ? 1 : 0) + primitiveTypes.length;

    // Empty/unknown schema
    if (branchCount === 0) {
      pushObjectEntries(headerEntries, depth);
      continue;
    }

    // Pure primitive(s) without object/array
    if (!hasObject && !hasArray) {
      const typeVal =
        primitiveTypes.length === 1
          ? JSON.stringify(primitiveTypes[0])
          : `[${primitiveTypes.map((t) => JSON.stringify(t)).join(", ")}]`;
      pushObjectEntries(
        [
          ...headerEntries,
          {
            key: "type",
            renderValue: () => {
              tasks.push({ kind: "text", text: typeVal });
            },
          },
        ],
        depth,
      );
      continue;
    }

    // Pure single object (no other union branches)
    if (hasObject && !hasArray && primitiveTypes.length === 0) {
      const shape = node.objectShape!;
      const props = [...shape.properties.values()];
      const required = props
        .filter((p) => p.presentCount === shape.objectCount)
        .map((p) => p.key);

      const entries: Array<{ key: string; renderValue: () => void }> = [
        ...headerEntries,
        {
          key: "type",
          renderValue: () => {
            tasks.push({ kind: "text", text: '"object"' });
          },
        },
      ];

      if (props.length > 0 || isRoot) {
        entries.push({
          key: "properties",
          renderValue: () => {
            if (props.length === 0) {
              tasks.push({ kind: "text", text: "{}" });
              return;
            }
            const propDepth = depth + 1;
            tasks.push({ kind: "text", text: `\n${indentUnit.repeat(propDepth)}}` });
            for (let i = props.length - 1; i >= 0; i -= 1) {
              if (i < props.length - 1) {
                tasks.push({ kind: "text", text: ",\n" });
              }
              tasks.push({
                kind: "schema",
                node: props[i].schema,
                depth: propDepth + 1,
                isRoot: false,
              });
              tasks.push({
                kind: "text",
                text: `${indentUnit.repeat(propDepth + 1)}${JSON.stringify(props[i].key)}: `,
              });
            }
            tasks.push({ kind: "text", text: "{\n" });
          },
        });
      }

      if (required.length > 0) {
        entries.push({
          key: "required",
          renderValue: () => {
            tasks.push({
              kind: "text",
              text: `[${required.map((k) => JSON.stringify(k)).join(", ")}]`,
            });
          },
        });
      }

      pushObjectEntries(entries, depth);
      continue;
    }

    // Pure single array (no other union branches)
    if (hasArray && !hasObject && primitiveTypes.length === 0) {
      const entries: Array<{ key: string; renderValue: () => void }> = [
        ...headerEntries,
        {
          key: "type",
          renderValue: () => {
            tasks.push({ kind: "text", text: '"array"' });
          },
        },
      ];
      if (node.arrayElem !== undefined) {
        const elemNode = node.arrayElem;
        entries.push({
          key: "items",
          renderValue: () => {
            tasks.push({ kind: "schema", node: elemNode, depth: depth + 1, isRoot: false });
          },
        });
      }
      pushObjectEntries(entries, depth);
      continue;
    }

    // Multi-branch union involving object and/or array -> emit `anyOf`
    const branchSchemas: SchemaNode[] = [];
    if (hasObject) {
      const branch = createEmptySchemaNode();
      branch.objectShape = node.objectShape;
      branchSchemas.push(branch);
    }
    if (hasArray) {
      const branch = createEmptySchemaNode();
      branch.hasArray = true;
      branch.arrayElem = node.arrayElem;
      branchSchemas.push(branch);
    }
    for (const prim of primitiveTypes) {
      const branch = createEmptySchemaNode();
      if (prim === "string") branch.hasString = true;
      else if (prim === "integer") branch.numberKind = "int";
      else if (prim === "number") branch.numberKind = "float";
      else if (prim === "boolean") branch.hasBoolean = true;
      else if (prim === "null") branch.hasNull = true;
      branchSchemas.push(branch);
    }

    pushObjectEntries(
      [
        ...headerEntries,
        {
          key: "anyOf",
          renderValue: () => {
            const arrDepth = depth + 1;
            tasks.push({ kind: "text", text: `\n${indentUnit.repeat(arrDepth)}]` });
            for (let i = branchSchemas.length - 1; i >= 0; i -= 1) {
              if (i < branchSchemas.length - 1) {
                tasks.push({ kind: "text", text: ",\n" });
              }
              tasks.push({
                kind: "schema",
                node: branchSchemas[i],
                depth: arrDepth + 1,
                isRoot: false,
              });
              tasks.push({ kind: "text", text: indentUnit.repeat(arrDepth + 1) });
            }
            tasks.push({ kind: "text", text: "[\n" });
          },
        },
      ],
      depth,
    );
  }

  return `${output.join("")}\n`;
}

// ---------------------------------------------------------------------------
// 3. Zod Emitter (Iterative)
// ---------------------------------------------------------------------------

function emitZod(rootSchema: SchemaNode, rootTypeName: string, postOrder: SchemaNode[]): string {
  const depthMap = new Map<SchemaNode, number>();
  const computeDepthStack: Array<{ node: SchemaNode; depth: number }> = [
    { node: rootSchema, depth: 0 },
  ];
  while (computeDepthStack.length > 0) {
    const { node, depth } = computeDepthStack.pop()!;
    depthMap.set(node, depth);
    if (node.arrayElem !== undefined) {
      computeDepthStack.push({ node: node.arrayElem, depth });
    }
    if (node.objectShape !== undefined) {
      for (const prop of node.objectShape.properties.values()) {
        computeDepthStack.push({ node: prop.schema, depth: depth + 1 });
      }
    }
  }

  const exprMap = new Map<SchemaNode, string>();

  for (const node of postOrder) {
    const nonNullVariants: string[] = [];
    if (node.objectShape !== undefined) {
      const shape = node.objectShape;
      const isRootNode = node === rootSchema && isPureRootObject(rootSchema);
      if (shape.properties.size === 0 && !isRootNode) {
        nonNullVariants.push("z.record(z.string(), z.unknown())");
      } else if (shape.properties.size === 0) {
        nonNullVariants.push("z.object({})");
      } else {
        const depth = depthMap.get(node) ?? 0;
        const pad = "  ".repeat(depth + 1);
        const closePad = "  ".repeat(depth);
        const propLines: string[] = [];
        for (const prop of shape.properties.values()) {
          const optional = prop.presentCount < shape.objectCount;
          const childExpr = exprMap.get(prop.schema)!;
          const fullExpr = optional ? `${childExpr}.optional()` : childExpr;
          propLines.push(`${pad}${formatJsPropertyKey(prop.key)}: ${fullExpr},`);
        }
        nonNullVariants.push(`z.object({\n${propLines.join("\n")}\n${closePad}})`);
      }
    }
    if (node.hasArray) {
      const elem = node.arrayElem !== undefined ? exprMap.get(node.arrayElem)! : "z.unknown()";
      nonNullVariants.push(`z.array(${elem})`);
    }
    if (node.hasString) nonNullVariants.push("z.string()");
    if (node.numberKind === "int" || node.numberKind === "int64") {
      nonNullVariants.push("z.number().int()");
    } else if (node.numberKind === "float") {
      nonNullVariants.push("z.number()");
    }
    if (node.hasBoolean) nonNullVariants.push("z.boolean()");

    let expr: string;
    if (nonNullVariants.length === 0) {
      expr = node.hasNull ? "z.null()" : "z.unknown()";
    } else if (nonNullVariants.length === 1) {
      expr = node.hasNull ? `${nonNullVariants[0]}.nullable()` : nonNullVariants[0];
    } else {
      const unionExpr = `z.union([${nonNullVariants.join(", ")}])`;
      expr = node.hasNull ? `${unionExpr}.nullable()` : unionExpr;
    }
    exprMap.set(node, expr);
  }

  const schemaVar = rootTypeName.endsWith("Schema") ? `${rootTypeName}Def` : `${rootTypeName}Schema`;
  return [
    'import { z } from "zod";',
    "",
    `export const ${schemaVar} = ${exprMap.get(rootSchema)!};`,
    "",
    `export type ${rootTypeName} = z.infer<typeof ${schemaVar}>;`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 4. Go Emitter (Iterative)
// ---------------------------------------------------------------------------

function emitGo(
  rootSchema: SchemaNode,
  rootTypeName: string,
  postOrder: SchemaNode[],
  namedObjects: ObjectShape[],
): string {
  interface GoTypeInfo {
    baseType: string;
    pointerWhenNullable: boolean;
  }

  const infoMap = new Map<SchemaNode, GoTypeInfo>();

  for (const node of postOrder) {
    const nonNullVariants: Array<{ type: string; nilable: boolean }> = [];
    if (node.objectShape !== undefined) {
      if (node.objectShape.typeName !== undefined) {
        nonNullVariants.push({ type: node.objectShape.typeName, nilable: false });
      } else {
        nonNullVariants.push({ type: "map[string]any", nilable: true });
      }
    }
    if (node.hasArray) {
      const elemInfo = node.arrayElem !== undefined ? infoMap.get(node.arrayElem)! : undefined;
      let elemType = "any";
      if (elemInfo !== undefined) {
        elemType =
          node.arrayElem!.hasNull && elemInfo.pointerWhenNullable
            ? `*${elemInfo.baseType}`
            : elemInfo.baseType;
      }
      nonNullVariants.push({ type: `[]${elemType}`, nilable: true });
    }
    if (node.hasString) nonNullVariants.push({ type: "string", nilable: false });
    if (node.numberKind === "int64") nonNullVariants.push({ type: "int64", nilable: false });
    else if (node.numberKind === "int") nonNullVariants.push({ type: "int", nilable: false });
    else if (node.numberKind === "float") nonNullVariants.push({ type: "float64", nilable: false });
    if (node.hasBoolean) nonNullVariants.push({ type: "bool", nilable: false });

    if (nonNullVariants.length !== 1) {
      infoMap.set(node, { baseType: "any", pointerWhenNullable: false });
    } else {
      infoMap.set(node, {
        baseType: nonNullVariants[0].type,
        pointerWhenNullable: !nonNullVariants[0].nilable,
      });
    }
  }

  const blocks: string[] = [];
  if (!isPureRootObject(rootSchema)) {
    const rootInfo = infoMap.get(rootSchema)!;
    const rootGoType =
      rootSchema.hasNull && rootInfo.pointerWhenNullable
        ? `*${rootInfo.baseType}`
        : rootInfo.baseType;
    blocks.push(`type ${rootTypeName} ${rootGoType}`);
  }

  for (const shape of namedObjects) {
    const props = [...shape.properties.values()];
    if (props.length === 0) {
      blocks.push(`type ${shape.typeName!} struct{}`);
      continue;
    }
    const usedFields = new Set<string>();
    const lines: string[] = [`type ${shape.typeName!} struct {`];
    for (const prop of props) {
      const fieldName = uniqueGoFieldName(prop.key, usedFields);
      const optional = prop.presentCount < shape.objectCount;
      const propInfo = infoMap.get(prop.schema)!;
      const needsPointer = (prop.schema.hasNull || optional) && propInfo.pointerWhenNullable;
      const fieldType = needsPointer ? `*${propInfo.baseType}` : propInfo.baseType;
      const tag = formatGoJsonStructTag(prop.key, optional);
      lines.push(`\t${fieldName} ${fieldType} ${tag}`);
    }
    lines.push("}");
    blocks.push(lines.join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// 5. Python (Pydantic v2 BaseModel) Emitter (Iterative)
// ---------------------------------------------------------------------------

function emitPython(
  rootSchema: SchemaNode,
  rootTypeName: string,
  postOrder: SchemaNode[],
  namedObjects: ObjectShape[],
): string {
  const exprMap = new Map<SchemaNode, string>();
  let usesAny = false;

  for (const node of postOrder) {
    const variants: string[] = [];
    if (node.objectShape !== undefined) {
      if (node.objectShape.typeName !== undefined) {
        variants.push(node.objectShape.typeName);
      } else {
        usesAny = true;
        variants.push("dict[str, Any]");
      }
    }
    if (node.hasArray) {
      if (node.arrayElem !== undefined) {
        variants.push(`list[${exprMap.get(node.arrayElem)!}]`);
      } else {
        usesAny = true;
        variants.push("list[Any]");
      }
    }
    if (node.hasString) variants.push("str");
    if (node.numberKind === "int" || node.numberKind === "int64") variants.push("int");
    else if (node.numberKind === "float") variants.push("float");
    if (node.hasBoolean) variants.push("bool");
    if (node.hasNull) variants.push("None");

    if (variants.length === 0) {
      usesAny = true;
      exprMap.set(node, "Any");
    } else {
      exprMap.set(node, variants.join(" | "));
    }
  }

  // Emit child BaseModel classes BEFORE parent BaseModel classes so Pydantic v2
  // resolves all forward references immediately at class definition time.
  const shapeOrder = new Set<ObjectShape>(namedObjects);
  const orderedModels: ObjectShape[] = [];
  for (const node of postOrder) {
    if (node.objectShape !== undefined && shapeOrder.has(node.objectShape)) {
      orderedModels.push(node.objectShape);
    }
  }

  let usesField = false;
  let usesConfigDict = false;
  const modelBlocks: string[] = [];

  for (const shape of orderedModels) {
    const props = [...shape.properties.values()];
    if (props.length === 0) {
      modelBlocks.push(`class ${shape.typeName!}(BaseModel):\n    pass`);
      continue;
    }

    const usedAttrs = new Set<string>(["model_config"]);
    // Reserve exact valid identifiers first so sanitized aliases never collide with them.
    for (const prop of props) {
      if (!needsPythonAlias(prop.key)) {
        usedAttrs.add(prop.key);
      }
    }

    let modelHasAlias = false;
    const fieldLines: string[] = [];

    for (const prop of props) {
      const optional = prop.presentCount < shape.objectCount;
      let pyType = exprMap.get(prop.schema)!;
      if (optional && !prop.schema.hasNull && pyType !== "Any") {
        pyType = `${pyType} | None`;
      }

      const aliased = needsPythonAlias(prop.key);
      if (aliased) {
        usesField = true;
        usesConfigDict = true;
        modelHasAlias = true;
        const attrName = uniquePythonAttrName(prop.key, usedAttrs);
        const aliasLiteral = JSON.stringify(prop.key);
        const defaultArg = optional ? ", default=None" : "";
        fieldLines.push(`    ${attrName}: ${pyType} = Field(alias=${aliasLiteral}${defaultArg})`);
      } else if (optional) {
        fieldLines.push(`    ${prop.key}: ${pyType} = None`);
      } else {
        fieldLines.push(`    ${prop.key}: ${pyType}`);
      }
    }

    const classLines: string[] = [`class ${shape.typeName!}(BaseModel):`];
    if (modelHasAlias) {
      classLines.push("    model_config = ConfigDict(populate_by_name=True)");
      classLines.push("");
    }
    classLines.push(...fieldLines);
    modelBlocks.push(classLines.join("\n"));
  }

  if (!isPureRootObject(rootSchema)) {
    modelBlocks.push(`${rootTypeName} = ${exprMap.get(rootSchema)!}`);
  }

  const imports: string[] = ["from __future__ import annotations"];
  if (usesAny) {
    imports.push("from typing import Any");
  }
  if (orderedModels.length > 0) {
    const pydanticSymbols = ["BaseModel"];
    if (usesConfigDict) pydanticSymbols.push("ConfigDict");
    if (usesField) pydanticSymbols.push("Field");
    imports.push(`from pydantic import ${pydanticSymbols.join(", ")}`);
  }

  const sections = [imports.join("\n"), ...modelBlocks];
  return `${sections.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Identifier & Tag Formatting Helpers
// ---------------------------------------------------------------------------

function splitIdentifierWords(raw: string): string[] {
  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return normalized.match(/[A-Za-z0-9]+/g) ?? [];
}

function toPascalCase(raw: string, fallback: string): string {
  const words = splitIdentifierWords(raw);
  if (words.length === 0) return fallback;
  let joined = words
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join("");
  if (/^\d/.test(joined)) {
    joined = `${fallback}${joined}`;
  }
  return joined;
}

function toGoPascalCase(raw: string, fallback: string): string {
  const words = splitIdentifierWords(raw);
  if (words.length === 0) return fallback;
  let joined = words
    .map((word) => {
      const upper = word.toUpperCase();
      if (GO_COMMON_INITIALISMS.has(upper)) return upper;
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
  if (/^\d/.test(joined)) {
    joined = `${fallback}${joined}`;
  }
  return joined;
}

function singularizePascal(name: string, isRootArray: boolean): string {
  if (/[^aeiou]ies$/i.test(name) && name.length > 3) {
    return `${name.slice(0, -3)}y`;
  }
  if (/(?:sses|xes|zes|ches|shes)$/i.test(name) && name.length > 4) {
    return name.slice(0, -2);
  }
  if (/s$/i.test(name) && !/(?:ss|us|is|os)$/i.test(name) && name.length > 2) {
    return name.slice(0, -1);
  }
  return isRootArray ? `${name}Item` : `${name}Item`;
}

function formatJsPropertyKey(key: string): string {
  if (JS_IDENTIFIER_PATTERN.test(key) && key !== "__proto__") {
    return key;
  }
  return JSON.stringify(key);
}

function uniqueGoFieldName(key: string, used: Set<string>): string {
  const base = toGoPascalCase(key, "Field");
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) {
    suffix += 1;
  }
  const candidate = `${base}${suffix}`;
  used.add(candidate);
  return candidate;
}

function formatGoJsonStructTag(key: string, optional: boolean): string {
  if (key === "-") {
    // In Go encoding/json, `json:"-"` ignores the field, while `json:"-,"` encodes key "-".
    return optional ? '`json:"-,omitempty"`' : '`json:"-,"`';
  }
  const tagValue = `${key}${optional ? ",omitempty" : ""}`;
  // Raw Go struct tag `json:"..."` when key contains no backticks or quotes/control chars.
  if (!/[`"\\\r\n\t]/.test(key)) {
    return `\`json:"${tagValue}"\``;
  }
  if (!key.includes("`")) {
    const quotedInner = JSON.stringify(tagValue);
    return `\`json:${quotedInner}\``;
  }
  // Fallback double-quoted Go string literal when the JSON key itself contains a backtick.
  const fullTag = `json:${JSON.stringify(tagValue)}`;
  return JSON.stringify(fullTag);
}

function needsPythonAlias(key: string): boolean {
  if (key.length === 0) return true;
  if (key.startsWith("_")) return true;
  if (key.startsWith("model_")) return true;
  if (!PYTHON_IDENTIFIER_PATTERN.test(key)) return true;
  if (PYTHON_KEYWORDS.has(key)) return true;
  if (PYTHON_RESERVED_MODEL_ATTRS.has(key)) return true;
  return false;
}

function uniquePythonAttrName(key: string, used: Set<string>): string {
  const words = splitIdentifierWords(key);
  let base = words.length > 0 ? words.map((w) => w.toLowerCase()).join("_") : "field";
  if (/^\d/.test(base)) {
    base = `field_${base}`;
  }
  if (base.startsWith("model_")) {
    base = `field_${base}`;
  }
  if (PYTHON_KEYWORDS.has(base) || PYTHON_RESERVED_MODEL_ATTRS.has(base)) {
    base = `${base}_`;
  }
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  const candidate = `${base}_${suffix}`;
  used.add(candidate);
  return candidate;
}
