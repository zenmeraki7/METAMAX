// The caller writes the canonical product JSON in the same fenced transaction.
// A variant belongs to one product, but inventoryItemId is deliberately nonunique.
export async function replaceVariantProjection(
  tx,
  shop,
  snapshotId,
  productId,
  data,
) {
  const rows = data.variants.map((variant) => ({
    shop,
    snapshotId,
    productId,
    id: variant.id,
    inventoryItemId:
      variant.inventoryItemId ?? variant.inventoryItem?.id ?? null,
  }));
  await tx.variant.deleteMany({ where: { shop, snapshotId, productId } });
  for (let i = 0; i < rows.length; i += 200) {
    await tx.variant.createMany({ data: rows.slice(i, i + 200) });
  }
}

// Complete product batches arrive under the same snapshot lease and transaction.
export async function replaceVariantProjections(
  tx,
  shop,
  snapshotId,
  products,
) {
  await tx.variant.deleteMany({
    where: {
      shop,
      snapshotId,
      productId: { in: products.map((row) => row.productId) },
    },
  });
  const rows = products.flatMap(({ productId, data }) =>
    data.variants.map((variant) => ({
      shop,
      snapshotId,
      productId,
      id: variant.id,
      inventoryItemId:
        variant.inventoryItemId ?? variant.inventoryItem?.id ?? null,
    })),
  );
  for (let i = 0; i < rows.length; i += 2000)
    await tx.variant.createMany({ data: rows.slice(i, i + 2000) });
}
