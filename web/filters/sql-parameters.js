/** Internal PostgreSQL operand guard; no objects, nested arrays or coercion. */
import { FieldError, FIELD_ERROR_CODES as C, hasUnpairedSurrogate } from "../fields/types.js";

export function assertSqlParameter(value, type) {
  let valid = false;
  if (type === "boolean") valid = typeof value === "boolean";
  else if (type === "integer" || type === "bigint") {
    valid = typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);
    if (!valid && type === "bigint" && typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value) && value !== "-0" && value.length <= 20) {
      const integer = BigInt(value);
      valid = integer >= -9223372036854775808n && integer <= 9223372036854775807n;
    }
  }
  else if (typeof value === "string" && !value.includes("\0") && !hasUnpairedSurrogate(value)) {
    if (type === "text") valid = true;
    else if (type === "uuid") valid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
    else if (type === "numeric") valid = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
    else if (type === "date") valid = /^\d{4}-\d{2}-\d{2}$/.test(value);
    else if (type === "timestamptz") valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
  }
  if (!valid) throw new FieldError(C.CONTRACT_MISMATCH, "Unsupported normalized PostgreSQL parameter");
  return value;
}

export function assertSqlParameters(values, types, maximum = 500) {
  if (!Array.isArray(values) || !Array.isArray(types) || values.length !== types.length || values.length > maximum) {
    throw new FieldError(C.INVALID_VALUE, "Compiled SQL parameter budget exceeded");
  }
  for (const array of [values, types]) {
    if (Object.getPrototypeOf(array) !== Array.prototype || Reflect.ownKeys(array).length !== array.length + 1) {
      throw new FieldError(C.CONTRACT_MISMATCH, "Invalid PostgreSQL parameter array");
    }
  }
  for (let index = 0; index < values.length; index++) {
    const value = Object.getOwnPropertyDescriptor(values, String(index));
    const type = Object.getOwnPropertyDescriptor(types, String(index));
    if (!value || !type || !Object.hasOwn(value, "value") || !Object.hasOwn(type, "value")) {
      throw new FieldError(C.CONTRACT_MISMATCH, "Invalid PostgreSQL parameter descriptor");
    }
    assertSqlParameter(value.value, type.value);
  }
  return values;
}
