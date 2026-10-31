// Prisma 7.10.1 infers a one-to-one reverse relation from publications.shop_id
// even though its composite FK does not have an exact composite unique key.
// Use the same reverse collection as the canonical application model, without
// inventing a physical unique constraint or changing the database.
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../prisma-live/schema.prisma", import.meta.url);
const source = readFileSync(file, "utf8");
const normalized = source.replace(/model generations \{[\s\S]*?\n\}/, block =>
  block.replace(/^(\s+publications\s+)publications\?/m, "$1publications[]"),
).replace(/model job_items \{[\s\S]*?\n\}/, block =>
  // Re-introspection can reuse the edit-operation field name and FK map for
  // the distinct job-command FK on the same local columns. Preserve both real
  // constraints, with their actual targets and names from migration SQL.
  block.replace(/^(\s+)edit_operations(\s+job_commands\s+@relation[^\n]*map: )"edit_item_operation_fkey"/m,
    '$1job_commands$2"job_items_shop_id_command_id_fkey"'),
);
if (normalized !== source) writeFileSync(file, normalized);
console.log(normalized !== source ? "Normalized introspected relation names/cardinality; database constraints unchanged." : "Live relations require no normalization.");
