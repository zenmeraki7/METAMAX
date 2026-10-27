const PRODUCT_ID = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/;
const MONEY = /^\d+(?:\.\d+)?$/;
const INVENTORY_ITEM_ID = /^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/;

export function mapVariant(productId, variant) {
  if (
    !variant ||
    !VARIANT_ID.test(variant.id) ||
    variant.__parentId !== productId ||
    !Number.isSafeInteger(variant.position) ||
    variant.position < 1 ||
    typeof variant.price !== "string" ||
    !MONEY.test(variant.price) ||
    (variant.compareAtPrice !== null &&
      (typeof variant.compareAtPrice !== "string" ||
        !MONEY.test(variant.compareAtPrice)))
  ) {
    throw new TypeError("Invalid variant identity, position, or decimal price");
  }
  const { __parentId, ...mapped } = variant;
  const inventoryItemId = variant.inventoryItem?.id ?? variant.inventoryItemId ?? null;
  if ((inventoryItemId !== null && !INVENTORY_ITEM_ID.test(inventoryItemId)) ||
    (variant.inventoryItem?.id != null && variant.inventoryItemId != null && variant.inventoryItem.id !== variant.inventoryItemId))
    throw new TypeError("Invalid or conflicting inventory item reference");
  mapped.inventoryItemId = inventoryItemId;
  // Money remains the original decimal string. Never convert it with Number().
  return mapped;
}

// Canonical JSON mapping for this repo's ProductMirror model. The repository
// owns tenant/revision fields; they cannot be supplied by Shopify response data.
export function mapCurrentProduct(productId, current) {
  if (
    !PRODUCT_ID.test(productId) ||
    !current ||
    current.product?.id !== productId ||
    !Array.isArray(current.variants)
  ) {
    throw new TypeError("Incomplete product representation");
  }
  const count = current.product.variantsCount;
  if (
    count?.precision !== "EXACT" ||
    !Number.isSafeInteger(count.count) ||
    count.count !== current.variants.length ||
    count.count > 2048
  ) {
    throw new TypeError(
      "Cannot replace a product with an incomplete variant set"
    );
  }
  const ids = new Set(),
    positions = new Set();
  const variants = current.variants
    .map((variant) => {
      const row = mapVariant(productId, variant);
      if (ids.has(row.id) || positions.has(row.position))
        throw new TypeError("Duplicate variant ID or position");
      ids.add(row.id);
      positions.add(row.position);
      return row;
    })
    .sort((a, b) => a.position - b.position);
  const { variants: firstPage, ...product } = current.product;
  // Validate JSON serializability before the transaction performs a write.
  return JSON.parse(JSON.stringify({ ...product, variants }));
}
