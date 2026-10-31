import { FieldError, FIELD_ERROR_CODES as C, DYNAMIC_FIELD_ID_PATTERN, isDynamicMetafieldId } from "./types.js";

export const DYNAMIC_METAFIELD_ID_PATTERN = DYNAMIC_FIELD_ID_PATTERN;
export const METAFIELD_DEFINITION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
export const METAFIELD_DEFINITION_ID_PATTERN = /^gid:\/\/shopify\/MetafieldDefinition\/[1-9][0-9]*$/;
export const METAFIELD_LOCATOR_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{0,254}$/;

export function validateMetafieldShop(shopId) {
  if (typeof shopId !== "string" || shopId.length === 0 || shopId.length > 255 ||
      shopId.trim() !== shopId || /[\u0000-\u001f\u007f]/.test(shopId)) {
    throw new FieldError(C.INVALID_VALUE, "Invalid shop identity");
  }
  return shopId;
}

export function validateDynamicMetafieldId(fieldId) {
  if (!isDynamicMetafieldId(fieldId)) {
    throw new FieldError(C.UNKNOWN_FIELD, "Invalid dynamic metafield identifier");
  }
  return fieldId;
}
