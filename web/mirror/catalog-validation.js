import { invalid } from "./transactions.server.js";
import { normalizeCanonicalInput } from "../fields/canonical-input.js";
import { getFieldPolicy } from "../fields/constraints.js";

function optionalScalars(entity, value, keys) {
  for (const key of keys) {
    if (value[key] !== undefined) {
      const id = `${entity}.${key}`;
      normalizeCanonicalInput(
        id,
        value[key],
        getFieldPolicy(id, "read").constraints,
      );
    }
  }
}
export function validateProducts(records) {
  if (
    !Array.isArray(records) ||
    !records.length ||
    records.length > 100 ||
    Buffer.byteLength(JSON.stringify(records)) > 8 * 1024 * 1024
  )
    invalid("Bounded complete product batch required");
  const seen = new Set(),
    allVariants = new Set();
  for (const p of records) {
    if (
      typeof p.id !== "string" ||
      !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(p.id) ||
      seen.has(p.id)
    )
      invalid("Invalid or duplicate product");
    seen.add(p.id);
    if (p.deletedAt != null)
      invalid("Tombstones must not enter searchable catalog rows");
    optionalScalars("product", p, [
      "descriptionHtml",
      "vendor",
      "productType",
      "templateSuffix",
      "seoTitle",
      "seoDescription",
      "categoryId",
      "publishedAt",
    ]);
    if (p.seo != null)
      optionalScalars(
        "product",
        { seoTitle: p.seo.title, seoDescription: p.seo.description },
        ["seoTitle", "seoDescription"],
      );
    if (p.category != null)
      optionalScalars("product", { categoryId: p.category.id }, ["categoryId"]);
    for (const key of ["title", "handle", "status", "createdAt", "updatedAt"])
      if (typeof p[key] !== "string") invalid("Incomplete product snapshot");
    if (
      !["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].includes(p.status) ||
      !Number.isFinite(Date.parse(p.createdAt)) ||
      !Number.isFinite(Date.parse(p.updatedAt))
    )
      invalid("Invalid product scalar");
    if (
      !Array.isArray(p.tags) ||
      p.tags.some((t) => typeof t !== "string") ||
      !Array.isArray(p.variants) ||
      p.variants.length > 2048
    )
      invalid("Complete bounded tags and variants required");
    // An omitted/partial list must never become an authoritative empty list.
    // Validate every element and the dense-array/size contract without trimming,
    // deduplicating or truncating Shopify's complete value.
    normalizeCanonicalInput(
      "product.tags",
      p.tags,
      getFieldPolicy("product.tags", "read").constraints,
    );
    const ids = new Set();
    for (const v of p.variants) {
      if (
        typeof v.id !== "string" ||
        !/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(v.id) ||
        ids.has(v.id) ||
        allVariants.has(v.id) ||
        v.deletedAt != null
      )
        invalid("Invalid or duplicate variant");
      ids.add(v.id);
      allVariants.add(v.id);
      optionalScalars("variant", v, ["sku", "barcode"]);
      for (const key of ["title", "createdAt", "updatedAt"])
        if (typeof v[key] !== "string") invalid("Incomplete variant snapshot");
      for (const key of ["price", "compareAtPrice"])
        if (
          !(key === "compareAtPrice" && v[key] === null) &&
          (typeof v[key] !== "string" || !/^\d+(?:\.\d+)?$/.test(v[key]))
        )
          invalid("Exact decimal required");
      if (
        !Number.isFinite(Date.parse(v.createdAt)) ||
        !Number.isFinite(Date.parse(v.updatedAt)) ||
        typeof v.taxable !== "boolean" ||
        typeof v.requiresComponents !== "boolean" ||
        !["DENY", "CONTINUE"].includes(v.inventoryPolicy)
      )
        invalid("Invalid variant scalar");
      for (const key of ["inventoryQuantity", "position"])
        if (
          !(typeof v[key] === "number" && Number.isSafeInteger(v[key])) &&
          !(typeof v[key] === "string" && /^-?\d+$/.test(v[key]))
        )
          invalid("Exact integer required");
      if (BigInt(v.position) < 1n)
        invalid("Positive variant position required");
    }
  }
}
