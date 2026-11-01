/**
 * METAMAX — Hardened Filter AST
 *
 * web/filters/ast.js
 *
 * Node.js 22+ / ESM
 *
 * Structural validation only.
 *
 * NOT responsible for:
 * - Field authorization
 * - Operator compatibility
 * - SQL compilation
 * - Mirror dataset coverage
 * - Bulk-edit execution approval
 */

import {
  isSupportedFieldId,
  hasUnpairedSurrogate,
} from "../fields/types.js";

export const FILTER_AST_VERSION = 1;

export const FILTER_AST_LIMITS = Object.freeze({
  MAX_NODES: 1000,
  MAX_DEPTH: 32,
  MAX_CHILDREN: 1000,
  MAX_BYTES: 131072,
  MAX_FIELD_BYTES: 160,
  MAX_OPERATOR_BYTES: 64,
  MAX_VALUE_STRING_BYTES: 65536,
  MAX_VALUE_KEY_BYTES: 256,
  MAX_VALUE_ARRAY_ITEMS: 100,
  MAX_VALUE_OBJECT_KEYS: 32,
  MAX_VALUE_DEPTH: 8,
});

export const FILTER_NODE_KINDS = Object.freeze({
  GROUP: "group",
  CONDITION: "condition",
});

export const FILTER_GROUP_OPERATORS = Object.freeze({
  AND: "AND",
  OR: "OR",
  NOT: "NOT",
});

export const FILTER_AST_ERROR_CODES = Object.freeze({
  INVALID_AST: "INVALID_FILTER_AST",
  INVALID_NODE: "INVALID_FILTER_NODE",
  INVALID_VALUE: "INVALID_FILTER_VALUE",
  LIMIT_EXCEEDED: "FILTER_LIMIT_EXCEEDED",
  UNSUPPORTED_VERSION: "UNSUPPORTED_FILTER_VERSION",
});

export class FilterAstError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FilterAstError";
    this.code = code;
    this.status = 400;
  }
}

const L = FILTER_AST_LIMITS;
const E = FILTER_AST_ERROR_CODES;
const K = FILTER_NODE_KINDS;

const GROUP_OPERATORS = new Set(
  Object.values(FILTER_GROUP_OPERATORS)
);

const ROOT_KEYS = new Set([
  "version",
  "root",
]);

const GROUP_KEYS = new Set([
  "kind",
  "operator",
  "children",
]);

const CONDITION_KEYS = new Set([
  "kind",
  "field",
  "operator",
  "value",
]);

const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const OPERATOR_PATTERN =
  /^[a-z][a-z0-9_]*$/;

/**
 * Private structural provenance.
 *
 * This NEVER represents authorization.
 */
const TRUSTED_AST = new WeakSet();
const INSPECTION_CACHE = new WeakMap();
const SERIALIZATION_CACHE = new WeakMap();

function fail(code, message) {
  throw new FilterAstError(code, message);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function isPlainRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

/**
 * Avoid calling getters or custom toJSON
 * methods on untrusted input.
 */
function readOwnData(
  object,
  key,
  code = E.INVALID_AST
) {
  const descriptor =
    Object.getOwnPropertyDescriptor(object, key);

  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value")
  ) {
    fail(code, "Missing or accessor-backed property");
  }

  return descriptor.value;
}

function enterObject(value, state) {
  if (state.seen.has(value)) {
    fail(
      E.INVALID_AST,
      "Cyclic or shared object reference"
    );
  }

  state.seen.add(value);
}

function consume(state, amount) {
  state.lowerBoundBytes += amount;

  if (
    state.lowerBoundBytes > L.MAX_BYTES
  ) {
    fail(
      E.LIMIT_EXCEEDED,
      "Filter exceeds byte limit"
    );
  }
}

function consumeString(state, value) {
  consume(
    state,
    byteLength(JSON.stringify(value))
  );
}

/**
 * Reads only own data properties.
 *
 * Rejects:
 * - Unexpected keys
 * - Symbols
 * - Accessors
 * - Prototype pollution keys
 * - Custom prototypes
 */
function readRecord(input, allowedKeys, state) {
  if (!isPlainRecord(input)) {
    fail(
      E.INVALID_AST,
      "Expected a plain filter object"
    );
  }

  enterObject(input, state);

  const output = Object.create(null);
  const keys = Reflect.ownKeys(input);
  // Count braces, colons and commas even when all values are empty containers.
  consume(state, 2 + keys.length + Math.max(0, keys.length - 1));

  for (const key of keys) {
    if (
      typeof key !== "string" ||
      FORBIDDEN_KEYS.has(key) ||
      !allowedKeys.has(key)
    ) {
      fail(
        E.INVALID_AST,
        "Unexpected filter property"
      );
    }

    const value = readOwnData(input, key);

    consumeString(state, key);

    Object.defineProperty(output, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  return output;
}

/**
 * Reads only standard dense arrays.
 *
 * No custom properties, symbols, accessors,
 * sparse elements or unusual prototypes.
 */
function readArray(input, maxItems, state) {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !==
      Array.prototype ||
    input.length > maxItems
  ) {
    fail(
      E.INVALID_AST,
      "Invalid filter array"
    );
  }

  enterObject(input, state);

  const keys = Reflect.ownKeys(input);

  if (keys.length !== input.length + 1) {
    fail(
      E.INVALID_AST,
      "Unexpected array properties"
    );
  }

  // Structural overhead bounds operand traversal independently of scalar data.
  consume(state, 2 + Math.max(0, input.length - 1));

  const output = [];

  for (let i = 0; i < input.length; i++) {
    output.push(
      readOwnData(
        input,
        String(i),
        E.INVALID_AST
      )
    );
  }

  return output;
}

// --------------------------------------------------
// 1. Identifier validation
// --------------------------------------------------

function readIdentifier(
  value,
  predicate,
  maxBytes,
  state
) {
  if (
    typeof value !== "string" ||
    hasUnpairedSurrogate(value) ||
    byteLength(value) > maxBytes ||
    !predicate(value)
  ) {
    fail(
      E.INVALID_NODE,
      "Invalid filter identifier"
    );
  }

  consumeString(state, value);

  return value;
}

// --------------------------------------------------
// 2. Operand validation
// --------------------------------------------------

/**
 * Operand values must be JSON-compatible.
 *
 * The parser does not know field types.
 * Decimal-string requirements and operator
 * semantics are enforced by validate.js.
 */
function readOperand(
  value,
  depth,
  state
) {
  if (depth > L.MAX_VALUE_DEPTH) {
    fail(
      E.LIMIT_EXCEEDED,
      "Operand nesting limit exceeded"
    );
  }

  if (value === null) {
    consume(state, 4);
    return null;
  }

  switch (typeof value) {
    case "string": {
      if (hasUnpairedSurrogate(value)) {
        fail(E.INVALID_VALUE, "Malformed Unicode in filter operand");
      }
      const size = byteLength(value);

      if (size > L.MAX_VALUE_STRING_BYTES) {
        fail(
          E.LIMIT_EXCEEDED,
          "Operand string is too large"
        );
      }

      consumeString(state, value);

      return value;
    }

    case "number": {
      if (
        !Number.isFinite(value) ||
        (
          Number.isInteger(value) &&
          !Number.isSafeInteger(value)
        )
      ) {
        fail(
          E.INVALID_VALUE,
          "Invalid or unsafe numeric operand"
        );
      }

      if (Object.is(value, -0)) {
        fail(E.INVALID_VALUE, "Negative zero is not a canonical numeric operand");
      }

      consume(
        state,
        byteLength(JSON.stringify(value))
      );

      return value;
    }

    case "boolean":
      consume(state, value ? 4 : 5);
      return value;

    case "object":
      break;

    default:
      fail(
        E.INVALID_VALUE,
        "Unsupported operand type"
      );
  }

  if (Array.isArray(value)) {
    const values = readArray(
      value,
      L.MAX_VALUE_ARRAY_ITEMS,
      state
    );

    const result = values.map((item) =>
      readOperand(
        item,
        depth + 1,
        state
      )
    );

    return Object.freeze(result);
  }

  if (!isPlainRecord(value)) {
    fail(
      E.INVALID_VALUE,
      "Invalid operand object"
    );
  }

  const keys = Reflect.ownKeys(value);

  if (keys.length > L.MAX_VALUE_OBJECT_KEYS) {
    fail(
      E.LIMIT_EXCEEDED,
      "Too many operand properties"
    );
  }

  const allowed = new Set();

  for (const key of keys) {
    if (
      typeof key !== "string" ||
      FORBIDDEN_KEYS.has(key) ||
      hasUnpairedSurrogate(key) ||
      byteLength(key) > L.MAX_VALUE_KEY_BYTES
    ) {
      fail(
        E.INVALID_VALUE,
        "Invalid operand object key"
      );
    }

    allowed.add(key);
  }

  const data = readRecord(
    value,
    allowed,
    state
  );

  const result = Object.create(null);

  for (const key of keys) {
    Object.defineProperty(result, key, {
      value: readOperand(
        data[key],
        depth + 1,
        state
      ),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  return Object.freeze(result);
}

// --------------------------------------------------
// 3. AST node parsing
// --------------------------------------------------

function parseNode(
  input,
  depth,
  state
) {
  if (depth > L.MAX_DEPTH) {
    fail(
      E.LIMIT_EXCEEDED,
      "Filter depth limit exceeded"
    );
  }

  state.nodes++;

  if (state.nodes > L.MAX_NODES) {
    fail(
      E.LIMIT_EXCEEDED,
      "Filter node limit exceeded"
    );
  }

  if (!isPlainRecord(input)) {
    fail(
      E.INVALID_NODE,
      "Expected filter node"
    );
  }

  const kind = readOwnData(
    input,
    "kind",
    E.INVALID_NODE
  );

  if (kind === K.CONDITION) {
    const data = readRecord(
      input,
      CONDITION_KEYS,
      state
    );

    if (!isSupportedFieldId(data.field)) {
      fail(E.INVALID_NODE, "Invalid filter field identifier");
    }

    consumeString(state, data.field);

    const field = data.field;

    const operator = readIdentifier(
      data.operator,
      (id) => OPERATOR_PATTERN.test(id),
      L.MAX_OPERATOR_BYTES,
      state
    );

    const result = {
      kind: K.CONDITION,
      field,
      operator,
    };

    if (Object.hasOwn(data, "value")) {
      result.value = readOperand(
        data.value,
        0,
        state
      );
    }

    return Object.freeze(result);
  }

  if (kind === K.GROUP) {
    const data = readRecord(
      input,
      GROUP_KEYS,
      state
    );

    if (!GROUP_OPERATORS.has(data.operator)) {
      fail(
        E.INVALID_NODE,
        "Invalid logical group operator"
      );
    }

    consumeString(state, data.operator);

    const children = readArray(
      data.children,
      L.MAX_CHILDREN,
      state
    );

    if (children.length === 0) {
      fail(
        E.INVALID_NODE,
        "Empty groups are not supported"
      );
    }

    if (
      data.operator ===
        FILTER_GROUP_OPERATORS.NOT &&
      children.length !== 1
    ) {
      fail(
        E.INVALID_NODE,
        "NOT requires exactly one child"
      );
    }

    const parsedChildren = children.map(
      (child) =>
        parseNode(
          child,
          depth + 1,
          state
        )
    );

    return Object.freeze({
      kind: K.GROUP,
      operator: data.operator,
      children: Object.freeze(parsedChildren),
    });
  }

  fail(
    E.INVALID_NODE,
    "Unsupported filter node kind"
  );
}

// --------------------------------------------------
// 4. Trusted inspection
// --------------------------------------------------

function inspectTrustedAst(
  ast,
  serializedBytes
) {
  let nodeCount = 0;
  let conditionCount = 0;
  let groupCount = 0;
  let maxDepth = 0;

  const fieldIds = new Set();

  const stack = [{
    node: ast.root,
    depth: 1,
  }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop();

    nodeCount++;
    maxDepth = Math.max(maxDepth, depth);

    if (node.kind === K.CONDITION) {
      conditionCount++;
      fieldIds.add(node.field);
      if (
        node.value !== null &&
        typeof node.value === "object" &&
        node.value.kind === "field" &&
        typeof node.value.field === "string" &&
        isSupportedFieldId(node.value.field)
      ) {
        fieldIds.add(node.value.field);
      }
      continue;
    }

    groupCount++;

    for (
      let i = node.children.length - 1;
      i >= 0;
      i--
    ) {
      stack.push({
        node: node.children[i],
        depth: depth + 1,
      });
    }
  }

  return Object.freeze({
    version: FILTER_AST_VERSION,
    nodes: nodeCount,
    conditions: conditionCount,
    groups: groupCount,
    maxDepth,
    byteSize: serializedBytes,
    uniqueFields: fieldIds.size,
    fieldIds: Object.freeze(
      [...fieldIds].sort()
    ),
  });
}

// --------------------------------------------------
// 5. Public parser
// --------------------------------------------------

export function parseFilterAst(input) {
  // Structural provenance only.
  if (
    input !== null &&
    typeof input === "object" &&
    TRUSTED_AST.has(input)
  ) {
    return input;
  }

  const state = {
    nodes: 0,
    lowerBoundBytes: 0,
    seen: new WeakSet(),
  };

  const data = readRecord(
    input,
    ROOT_KEYS,
    state
  );

  if (data.version !== FILTER_AST_VERSION) {
    fail(
      E.UNSUPPORTED_VERSION,
      "Unsupported filter AST version"
    );
  }

  if (!Object.hasOwn(data, "root")) {
    fail(
      E.INVALID_AST,
      "Missing filter root"
    );
  }

  const root = parseNode(
    data.root,
    1,
    state
  );

  const ast = Object.freeze({
    version: FILTER_AST_VERSION,
    root,
  });

  /**
   * Serialize only objects created by this
   * module after strict input validation.
   *
   * This measures complete JSON syntax,
   * escaping, strings and scalar values.
   */
  const serialized = JSON.stringify(ast);

  const serializedBytes = byteLength(
    serialized
  );

  if (serializedBytes > L.MAX_BYTES) {
    fail(
      E.LIMIT_EXCEEDED,
      "Filter serialized byte limit exceeded"
    );
  }

  const inspection = inspectTrustedAst(
    ast,
    serializedBytes
  );

  TRUSTED_AST.add(ast);

  INSPECTION_CACHE.set(
    ast,
    inspection
  );

  SERIALIZATION_CACHE.set(
    ast,
    serialized
  );

  return ast;
}

// --------------------------------------------------
// 6. Public inspection
// --------------------------------------------------

export function inspectFilterAst(input) {
  const ast = parseFilterAst(input);

  return INSPECTION_CACHE.get(ast);
}

// --------------------------------------------------
// 7. Structural serialization (compatibility API)
// --------------------------------------------------

/**
 * Deterministic structural serialization.
 *
 * Does not imply semantic equivalence:
 *
 * A AND B is not assigned the same serialized
 * identity as B AND A.
 *
 * Canonical object-key ordering belongs in filters/serialization.js.
 * Cryptographic fingerprints belong in filters/fingerprint.js.
 */
export function serializeFilterAst(input) {
  const ast = parseFilterAst(input);

  return SERIALIZATION_CACHE.get(ast);
}

// --------------------------------------------------
// 8. Contract metadata
// --------------------------------------------------

export const FILTER_AST_INFO = Object.freeze({
  version: FILTER_AST_VERSION,
  limits: FILTER_AST_LIMITS,
  nodeKinds: Object.freeze(Object.values(
    FILTER_NODE_KINDS
  )),
  groupOperators: Object.freeze(Object.values(
    FILTER_GROUP_OPERATORS
  )),
  numericPolicy:
    "finite, safe integers, negative-zero rejected",
  executionComplexityValidatedHere: false,
});
