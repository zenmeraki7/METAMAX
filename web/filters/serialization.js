import { parseFilterAst } from "./ast.js";

export const FILTER_SERIALIZATION_VERSION = 1;

/**
 * Canonical object-key order; preserve group children, operand arrays and exact
 * scalar representation. This is structural identity, not semantic equivalence.
 * Parsing first prevents getters/toJSON or runtime objects reaching serialization.
 */
export function serializeCanonicalFilter(input) {
  const ast = parseFilterAst(input);
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const result = Object.create(null);
      for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
      return result;
    }
    return value;
  }
  return JSON.stringify({ serializationVersion: FILTER_SERIALIZATION_VERSION, ast: canonical(ast) });
}
