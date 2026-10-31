import test from "node:test";
import assert from "node:assert/strict";
import { assertSqlParameter, assertSqlParameters } from "../sql-parameters.js";

test("SQL values require exact normalized scalar types without driver object serialization", () => {
  for (const value of [{}, { toPostgres() { assert.fail("Driver hook executed"); } }, [], ["x"], new Date(),
    undefined, null, Symbol("x"), 1n, () => {}, NaN, Infinity, -0]) {
    for (const type of ["text", "numeric", "bigint", "boolean", "jsonb", "text[]"]) assert.throws(() => assertSqlParameter(value, type));
  }
  for (const [value, type] of [["x", "text"], ["12.5", "numeric"], [12, "bigint"], [true, "boolean"], ["2026-10-27", "date"]]) {
    assert.strictEqual(assertSqlParameter(value, type), value);
  }
  assert.throws(() => assertSqlParameter(12.5, "numeric"));
  assert.throws(() => assertSqlParameter("x\0y", "text"));
});

test("final emitted values are dense, scalar, typed and within the complete query budget", () => {
  assertSqlParameters(Array(500).fill("x"), Array(500).fill("text"));
  assert.throws(() => assertSqlParameters(Array(501).fill("x"), Array(501).fill("text")));
  const accessor = ["x"];
  Object.defineProperty(accessor, "0", { get() { assert.fail("Parameter getter executed"); } });
  for (const values of [new Array(1), accessor, [["x"]], [{ nested: true }]]) {
    assert.throws(() => assertSqlParameters(values, ["text"]));
  }
});
