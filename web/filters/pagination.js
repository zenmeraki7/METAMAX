/** HMAC cursor service. Configure once with a server-owned secret. */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  FieldError,
  FIELD_ERROR_CODES as C,
  isPlainObject,
  hasUnpairedSurrogate,
} from "../fields/types.js";

const SERVICES = new WeakSet();
const KEYS = [
  "fingerprint",
  "schemaFingerprint",
  "shopId",
  "generationId",
  "idType",
  "ordering",
];
const HEX = /^[a-f0-9]{64}$/;
function fail() {
  throw new FieldError(C.INVALID_VALUE, "Invalid or expired pagination cursor");
}
function data(raw, keys) {
  if (!isPlainObject(raw) || Reflect.ownKeys(raw).length !== keys.length)
    fail();
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !Object.hasOwn(d, "value")) fail();
    result[key] = d.value;
  }
  return result;
}
export function requireCursorPosition(value, type) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > 255 ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value)
  )
    fail();
  if (type === "text") return value;
  if (
    type === "uuid" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  )
    return value;
  if (type === "bigint" && /^-?(?:0|[1-9]\d*)$/.test(value) && value !== "-0") {
    const integer = BigInt(value);
    if (integer >= -9223372036854775808n && integer <= 9223372036854775807n)
      return value;
  }
  fail();
}
function identity(raw) {
  const result = data(raw, KEYS);
  if (
    typeof result.fingerprint !== "string" ||
    typeof result.schemaFingerprint !== "string" ||
    !HEX.test(result.fingerprint) ||
    !HEX.test(result.schemaFingerprint) ||
    typeof result.shopId !== "string" ||
    !result.shopId ||
    result.shopId.length > 255 ||
    result.shopId.trim() !== result.shopId ||
    /[\u0000-\u001f\u007f]/.test(result.shopId) ||
    typeof result.generationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(result.generationId) ||
    !["text", "bigint", "uuid"].includes(result.idType) ||
    result.ordering !==
      (result.idType === "text" ? "text:C" : `${result.idType}:native`)
  )
    fail();
  return result;
}

export function createCursorService({
  secret,
  clock = Date.now,
  maxAgeMs = 900000,
} = {}) {
  if (
    !Buffer.isBuffer(secret) ||
    secret.length < 32 ||
    typeof clock !== "function" ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > 86400000
  ) {
    throw new TypeError("Server cursor secret and bounded lifetime required");
  }
  const key = Buffer.from(secret);
  const mac = (body) =>
    createHmac("sha256", key)
      .update(`metamax:cursor:v1:${body}`, "utf8")
      .digest();
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError("Invalid cursor clock");
    return value;
  }
  const service = Object.freeze({
    readContext(token, shopId) {
      // Routing only: compilation still verifies the complete filter/schema binding.
      if (
        typeof token !== "string" ||
        token.length > 4096 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
      )
        fail();
      const [body, signature] = token.split("."),
        supplied = Buffer.from(signature, "base64url"),
        actual = mac(body);
      if (
        supplied.length !== actual.length ||
        !timingSafeEqual(supplied, actual)
      )
        fail();
      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        fail();
      }
      if (!isPlainObject(payload)) fail();
      const binding = identity(
        Object.fromEntries(KEYS.map((key) => [key, payload[key]])),
      );
      if (binding.shopId !== shopId) fail();
      service.verify(token, binding);
      return Object.freeze({ generationId: binding.generationId });
    },
    issue(expected, lastProductId) {
      const binding = identity(expected),
        issuedAt = now(),
        expiresAt = issuedAt + maxAgeMs;
      if (!Number.isSafeInteger(expiresAt)) fail();
      const body = Buffer.from(
        JSON.stringify({
          version: 1,
          ...binding,
          lastProductId: requireCursorPosition(lastProductId, binding.idType),
          issuedAt,
          expiresAt,
        }),
      ).toString("base64url");
      return `${body}.${mac(body).toString("base64url")}`;
    },
    verify(token, expected) {
      const binding = identity(expected);
      if (
        typeof token !== "string" ||
        token.length > 4096 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)
      )
        fail();
      const [body, signature] = token.split(".");
      const supplied = Buffer.from(signature, "base64url"),
        actual = mac(body);
      if (
        supplied.length !== actual.length ||
        supplied.toString("base64url") !== signature ||
        !timingSafeEqual(supplied, actual)
      )
        fail();
      let raw;
      try {
        raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        fail();
      }
      const payload = data(raw, [
        "version",
        ...KEYS,
        "lastProductId",
        "issuedAt",
        "expiresAt",
      ]);
      const current = now();
      if (
        payload.version !== 1 ||
        KEYS.some((key) => payload[key] !== binding[key]) ||
        !Number.isSafeInteger(payload.issuedAt) ||
        !Number.isSafeInteger(payload.expiresAt) ||
        payload.issuedAt > current ||
        payload.issuedAt < 0 ||
        payload.expiresAt <= current ||
        payload.expiresAt <= payload.issuedAt ||
        payload.expiresAt - payload.issuedAt > maxAgeMs
      )
        fail();
      return Object.freeze({
        lastProductId: requireCursorPosition(
          payload.lastProductId,
          binding.idType,
        ),
      });
    },
  });
  SERVICES.add(service);
  return service;
}
export function assertCursorService(service) {
  if (!service || !SERVICES.has(service))
    throw new TypeError("Trusted cursor service required");
  return service;
}
