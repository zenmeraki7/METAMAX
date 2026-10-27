// Shopify 2026-10 definition contracts for the supported metafield subset.
// No network calls, engine capability grants or merchant mutations.
import { FieldError, deepFreeze, isPlainRecord, ownValue } from "./types.js";
import { requireValueField } from "./sources.js";

const fail = message => { throw new FieldError("INVALID_METAFIELD_DEFINITION", message); };
function keys(record, allowed) {
  if (!isPlainRecord(record)) fail("Expected a plain definition projection");
  for (const key of Reflect.ownKeys(record)) {
    if (!allowed.includes(key)) fail("Unsupported definition projection property");
    ownValue(record, key);
  }
}
function boundedInteger(value, max) {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value) || Number(value) > max)
    fail("Invalid definition validation limit");
  return Number(value);
}

export function metafieldContract(definition, shopifyType, ownerType) {
  const reportedOwner = ownValue(definition, "ownerType");
  if (reportedOwner !== undefined && reportedOwner !== ownerType) fail("Definition owner type does not match its owner");
  const accessInput = ownValue(definition, "access");
  let access = null;
  if (accessInput !== undefined) {
    keys(accessInput, ["admin", "storefront", "customerAccount"]);
    const options = {
      admin: ["MERCHANT_READ", "MERCHANT_READ_WRITE", "PRIVATE", "PUBLIC_READ", "PUBLIC_READ_WRITE"],
      storefront: ["NONE", "PUBLIC_READ"],
      customerAccount: ["NONE", "READ", "READ_WRITE"],
    };
    access = {};
    for (const [key, values] of Object.entries(options)) {
      const value = ownValue(accessInput, key);
      if (value !== undefined && value !== null && !values.includes(value)) fail("Unknown definition access setting");
      access[key] = value ?? null;
    }
  }
  const list = shopifyType === "list.single_line_text_field";
  const text = ["single_line_text_field", "multi_line_text_field", "list.single_line_text_field"].includes(shopifyType);
  const numeric = ["number_integer", "number_decimal"].includes(shopifyType);
  const contract = {
    access, validationsKnown: false,
    ...(shopifyType === "number_decimal" ? { min: "-9999999999999.999999999", max: "9999999999999.999999999", maxPrecision: 9 } : {}),
    ...(list ? { maxItems: 128 } : {}),
  };
  const input = ownValue(definition, "validations");
  if (input === undefined) return deepFreeze(contract);
  if (!Array.isArray(input) || input.length > 32) fail("Expected a bounded definition validations array");
  const seen = new Set(), validations = [];
  for (let i = 0; i < input.length; i++) {
    const rule = ownValue(input, String(i));
    keys(rule, ["name", "value"]);
    const name = ownValue(rule, "name"), value = ownValue(rule, "value");
    if (typeof name !== "string" || typeof value !== "string" || value.length > 65536 || seen.has(name))
      fail("Malformed or duplicate definition validation");
    seen.add(name);
    if (["min", "max"].includes(name) && text) {
      contract[name === "min" ? "minTextLength" : "maxTextLength"] = boundedInteger(value, 65536);
    } else if (["min", "max"].includes(name) && numeric) {
      const pattern = shopifyType === "number_integer" ? /^[+-]?\d+$/ : /^[+-]?\d+(?:\.\d+)?$/;
      if (value.length > 64 || !pattern.test(value)) fail("Invalid numeric definition bound");
      const unsigned = value.replace(/^[+-]/, "");
      const [whole, fraction = ""] = unsigned.split(".");
      const precision = shopifyType === "number_integer" ? 0 : 9;
      if (fraction.length > precision) fail("Definition bound exceeds the type precision");
      const scaled = BigInt(whole + fraction.padEnd(precision, "0"));
      const limit = shopifyType === "number_integer" ? 9007199254740991n : 9999999999999999999999n;
      if (scaled > limit) fail("Definition bound exceeds the type range");
      contract[name === "min" ? "definitionMin" : "definitionMax"] = value;
    } else if (["list.min", "list.max"].includes(name) && list) {
      contract[name === "list.min" ? "minItems" : "maxItems"] = boundedInteger(value, 128);
    } else if (name === "max_precision" && shopifyType === "number_decimal") {
      contract.maxPrecision = boundedInteger(value, 9);
    } else if (name === "choices" && ["single_line_text_field", "list.single_line_text_field"].includes(shopifyType)) {
      let choices;
      try { choices = JSON.parse(value); } catch { fail("Invalid definition choices JSON"); }
      if (!Array.isArray(choices) || choices.length < 1 || choices.length > 128 ||
          choices.some(item => typeof item !== "string" || /\0|\p{Surrogate}/u.test(item)) || new Set(choices).size !== choices.length)
        fail("Invalid definition choices");
      contract.choices = choices;
    } else {
      // Do not execute merchant regexes with JS semantics or silently ignore them.
      throw new FieldError("UNSUPPORTED_METAFIELD_VALIDATION", "Definition validation is not implemented for this type");
    }
    validations.push({ name, value });
  }
  if (numeric && contract.definitionMin !== undefined && contract.definitionMax !== undefined) {
    const scaled = value => {
      const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
      return BigInt(whole + fraction.padEnd(9, "0")) * (value.startsWith("-") ? -1n : 1n);
    };
    if (scaled(contract.definitionMin) > scaled(contract.definitionMax)) fail("Inconsistent numeric definition bounds");
  }
  if ((contract.minItems ?? 0) > (contract.maxItems ?? Infinity) ||
      (contract.minTextLength ?? 0) > (contract.maxTextLength ?? Infinity)) fail("Inconsistent definition validation bounds");
  return deepFreeze({ ...contract, validationsKnown: true, validations });
}

// Definition access and owner scopes only. Coverage, freshness, target and actual
// engine capability must pass separately. Context comes from trusted services.
export function checkMetafieldAccess(reference, action, context) {
  const field = requireValueField(reference);
  const result = reason => Object.freeze({ allowed: reason === null, reason });
  if (!field.dynamic) return result("NOT_A_METAFIELD");
  if (!["read", "write"].includes(action)) return result("INVALID_ACTION");
  if (!isPlainRecord(context) || ownValue(context, "authorized") !== true) return result("NOT_AUTHORIZED");
  if (ownValue(context, "shopId") !== field.shopId) return result("SHOP_MISMATCH");
  const scopes = ownValue(context, "scopes");
  if (!Array.isArray(scopes) || scopes.length > 1000) return result("OWNER_SCOPE_MISSING");
  const granted = new Set();
  for (let i = 0; i < scopes.length; i++) {
    const scope = ownValue(scopes, String(i));
    if (typeof scope !== "string") return result("OWNER_SCOPE_MISSING");
    granted.add(scope);
  }
  if (!granted.has("write_products") && (action === "write" || !granted.has("read_products")))
    return result("OWNER_SCOPE_MISSING");
  const admin = field.metafieldContract.access?.admin;
  if (!admin) return result("DEFINITION_ACCESS_UNKNOWN");
  const reserved = /^app--(\d+)(?:--|$)/.exec(field.namespace);
  if (reserved) {
    const appId = ownValue(context, "appId");
    if (typeof appId !== "string" || !/^\d+$/.test(appId) || reserved[1] !== appId)
      return result("APP_NAMESPACE_DENIED");
    if (!["MERCHANT_READ", "MERCHANT_READ_WRITE"].includes(admin)) return result("DEFINITION_ACCESS_DENIED");
  } else if (field.namespace.startsWith("app--")) {
    return result("APP_NAMESPACE_DENIED");
  } else if (!(action === "read" ? ["PUBLIC_READ", "PUBLIC_READ_WRITE"] : ["PUBLIC_READ_WRITE"]).includes(admin)) {
    return result("DEFINITION_ACCESS_DENIED");
  }
  return result(null);
}
