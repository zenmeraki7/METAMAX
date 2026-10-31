/** Test-only pg protocol fixture. Never imported by production modules. */
export function catalogPool(productExtras = {}, variantExtras = {}) {
  const column = type => ({ type, modifier: -1, notNull: true, collation: "100" });
  const state = { identifierLimit: "63", failure: null, commands: [], released: 0,
    tables: {
      products: { oid: "123", columns: { id: column("text"), shop_id: column("text"), generation_id: column("text"), ...productExtras },
        indexes: [{ unique: true, columns: ["shop_id", "generation_id", "id"], collations: ["default", "default", "pg_catalog.C"] }] },
      variants: { oid: "456", columns: { product_id: column("text"), shop_id: column("text"), generation_id: column("text"), ...variantExtras },
        indexes: [{ unique: false, columns: ["shop_id", "generation_id", "product_id"] }] },
    },
  };
  const pool = { connect: async () => ({
    async query(sql, parameters) {
      state.commands.push({ sql, parameters });
      if (state.failure) throw state.failure;
      if (sql === "SHOW max_identifier_length") return { rows: [{ max_identifier_length: state.identifierLimit }] };
      if (!parameters) return { rows: [] };
      const table = parameters[0] === "mirror" && state.tables[parameters[1]];
      if (!table) return { rows: [] };
      if (sql.includes("pg_catalog.pg_index")) return { rows: structuredClone(table.indexes) };
      return { rows: Object.entries(table.columns).map(([name, attributes], index) => ({ tableOid: table.oid, name, number: index + 1, ...attributes })) };
    },
    release() { state.released++; },
  }) };
  return { pool, state };
}
export const physicalMapping = () => ({
  products: { schema: "mirror", table: "products", id: "id", shop: "shop_id", generation: "generation_id" },
  variants: { schema: "mirror", table: "variants", productId: "product_id", shop: "shop_id", generation: "generation_id" },
});
export const physicalColumn = type => ({ type, modifier: -1, notNull: false });
