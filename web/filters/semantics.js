/** Versioned SQL semantics, independent of structural AST parsing. */
export const FILTER_NULL_SEMANTICS_VERSION = 1;
export const FILTER_NEGATIVE_OPERATORS = Object.freeze([
  "neq", "not_in", "not_contains", "list_not_contains",
]);
export const FILTER_NULL_SEMANTICS = Object.freeze({
  version: FILTER_NULL_SEMANTICS_VERSION,
  negativePredicates: "exclude_null",
  logicalOperators: "sql_three_valued",
  nullInspection: "explicit_is_null_or_is_not_null",
  nullOperands: "rejected_presence_operators_take_no_operand",
});
