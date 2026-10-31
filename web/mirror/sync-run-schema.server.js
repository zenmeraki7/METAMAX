import { createHash } from "node:crypto";
import { runSyncDbTransaction } from "./sync-db-transaction.server.js";
import { inspectSyncDomainSchema, SYNC_DOMAIN_TABLES } from "./sync-domain-schema.server.js";

export const SYNC_RUN_COLUMNS = Object.freeze(["id", "shopId", "generationId", "phase", "attempt", "fence", "leaseToken",
  "leaseExpiresAt", "nextEligibleAt", "completedAt", "reviewRequired", "outcomeUncertain", "workerId"]);
const optional = ["cancelRequested", "lastError", "recoveryAttempts"];
const phases = ["STARTING", "WAITING", "INGESTING", "RECONCILING", "PUBLISHING"];
const mappings = new WeakMap();
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export class SyncSchemaError extends Error {
  constructor(message) { super(message); this.code = "SYNC_SCHEMA_MISMATCH"; this.name = "SyncSchemaError"; }
}
const reject = message => { throw new SyncSchemaError(message); };
function record(value, allowed) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject("Trusted mapping data required");
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || !Object.hasOwn(d, "value")) reject("Unsupported mapping property");
    copy[key] = d.value;
  }
  return copy;
}
function column(value) { if (typeof value !== "string" || !identifier.test(value)) reject("Unsafe physical identifier"); return value; }
function table(value) {
  if (typeof value !== "string" || value.split(".").length !== 2) reject("Schema-qualified table required");
  return value.split(".").map(column).join(".");
}
function capture(raw) {
  const root = record(raw, ["runs", "shops", "attemptLimit"]);
  const runs = record(root.runs, ["table", "columns"]), shops = record(root.shops, ["table", "columns"]);
  const columns = record(runs.columns, [...SYNC_RUN_COLUMNS, ...optional]);
  for (const key of SYNC_RUN_COLUMNS) column(columns[key]);
  for (const key of optional) if (Object.hasOwn(columns, key)) column(columns[key]);
  if (new Set(Object.values(columns)).size !== Object.keys(columns).length) reject("Colliding run columns");
  const shopColumns = record(shops.columns, ["shopId"]);
  const attemptLimit = root.attemptLimit ?? 12;
  if (!Number.isSafeInteger(attemptLimit) || attemptLimit < 1 || attemptLimit > 12) reject("Invalid physical attempt limit");
  if (shops.table !== "mirror.shops") reject("Installed mirror tenant registry required");
  return Object.freeze({ runs: Object.freeze({ table: table(runs.table), columns: Object.freeze(columns) }),
    shops: Object.freeze({ table: table(shops.table), columns: Object.freeze({ shopId: column(shopColumns.shopId) }) }), attemptLimit });
}

export function quoteSyncIdentifier(value) { return `"${column(value)}"`; }
export function quoteSyncTable(value) { return table(value).split(".").map(quoteSyncIdentifier).join("."); }

async function catalogs(tx, relations) {
  // All relations are locked before this read. Batch metadata in this transaction,
  // never cache a physical-schema proof across claims or weaken revalidation.
  const prefix = `WITH relations AS (SELECT relation,to_regclass(relation) AS oid FROM unnest($1::text[]) relation) `;
  const columns = await tx.$queryRawUnsafe(prefix+`SELECT r.relation,a.attname::text AS name,t.typname::text AS type,a.attnotnull AS required,
    pg_get_expr(d.adbin,d.adrelid) AS default_value,
    ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS enum_values
    FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid JOIN pg_type t ON t.oid=a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attnum>0 AND NOT a.attisdropped ORDER BY r.relation,a.attnum`, relations);
  const constraints = await tx.$queryRawUnsafe(prefix+`SELECT r.relation,p.contype::text AS type,p.convalidated AS validated,pg_get_constraintdef(p.oid) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(p.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    n.nspname::text AS target_schema,c.relname::text AS target_table,
    ARRAY(SELECT a.attname::text FROM unnest(p.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=p.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns
    FROM relations r JOIN pg_constraint p ON p.conrelid=r.oid LEFT JOIN pg_class c ON c.oid=p.confrelid LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
    ORDER BY r.relation,p.conname`, relations);
  const indexes = await tx.$queryRawUnsafe(prefix+`SELECT r.relation,i.indisunique AS unique,i.indisvalid AS valid,i.indisready AS ready,
    pg_get_expr(i.indpred,i.indrelid) AS predicate,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num
      WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS columns
    FROM relations r JOIN pg_index i ON i.indrelid=r.oid ORDER BY r.relation,i.indexrelid`, relations);
  const found = new Map(relations.map(relation => [relation,{columns:[],constraints:[],indexes:[]} ]));
  for (const [key,rows] of Object.entries({columns,constraints,indexes})) {
    for (const {relation,...metadata} of rows) found.get(relation)[key].push(metadata);
  }
  return found;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const condition = s => s.replace(/[\s"()]/g, "").replace(/::text/g, "");

async function inspect(tx, m) {
  // Keep the verified physical relations stable even against DDL that does not
  // participate in the application publication-barrier protocol.
  const relations = [...new Set([m.shops.table,m.runs.table,'mirror.generations',
    ...(m.runs.table === 'mirror.catalog_import_executions' ? SYNC_DOMAIN_TABLES : [])])];
  await tx.$executeRawUnsafe(`LOCK TABLE ${relations.map(quoteSyncTable).join(', ')} IN ACCESS SHARE MODE`);
  const metadata = await catalogs(tx, relations);
  const catalog = async (_tx,relation) => metadata.get(relation);
  const run = metadata.get(m.runs.table), shop = metadata.get(m.shops.table);
  const c = m.runs.columns;
  const found = new Map(run.columns.map(value => [value.name, value]));
  for (const [key, name] of Object.entries(c)) {
    const col = found.get(name);
    const text = ["id", "shopId", "generationId", "leaseToken", "workerId", "lastError"].includes(key);
    const date = ["leaseExpiresAt", "nextEligibleAt", "completedAt"].includes(key);
    const bool = ["reviewRequired", "outcomeUncertain", "cancelRequested"].includes(key);
    if (!col || (text && !["text", "varchar"].includes(col.type)) || (date && col.type !== "timestamptz") ||
        (bool && col.type !== "bool") || (["attempt","recoveryAttempts"].includes(key) && col.type !== "int4") || (key === "fence" && col.type !== "int8")) reject(`Incompatible physical column: ${key}`);
    const nullable = ["leaseToken", "workerId", "leaseExpiresAt", "nextEligibleAt", "completedAt", "lastError"].includes(key);
    if (col.required === nullable) reject(`Incompatible nullability: ${key}`);
  }
  const shopId = shop.columns.find(value => value.name === m.shops.columns.shopId);
  if (!shopId?.required || !["text", "varchar"].includes(shopId.type)) reject("Incompatible tenant identity");
  const usable = indexes => indexes.filter(index => index.valid && index.ready && index.predicate == null);
  if (!usable(run.indexes).some(index => index.unique && equal(index.columns, [c.id]))) reject("Globally unique run ID required for notification lookup");
  if (!usable(shop.indexes).some(index => index.unique && equal(index.columns, [m.shops.columns.shopId]))) reject("Unique tenant identity required");
  if (!run.indexes.some(index => index.valid && index.ready && index.columns[0] === c.shopId && index.columns.includes(c.leaseExpiresAt))) reject("Shop lease coordination index required");
  if (!run.indexes.some(index => index.valid && index.ready && index.columns.includes(c.nextEligibleAt))) reject("Dispatcher eligibility index required");
  const checks = run.constraints.filter(k => k.type === "c" && k.validated).map(k => condition(k.definition));
  if (!checks.includes(`CHECK${c.attempt}>=0AND${c.attempt}<=${m.attemptLimit}`)) reject("Bounded integer attempt constraint required");
  if (c.recoveryAttempts && !checks.includes(`CHECK${c.recoveryAttempts}>=0AND${c.recoveryAttempts}<=8`)) reject("Bounded recovery attempt constraint required");
  if (!checks.includes(`CHECK${c.fence}>=0`)) reject("Nonnegative bigint fence constraint required");
  const phase = found.get(c.phase);
  const phaseCheck = checks.find(value => value.startsWith(`CHECK${c.phase}=ANYARRAY[`));
  const labels = phaseCheck && [...phaseCheck.matchAll(/'([^']*)'/g)].map(match => match[1]);
  const expected = values => equal([...values].sort(), [...phases].sort());
  if (!(phase.enum_values?.length && expected(phase.enum_values)) &&
      !(phase.type === "text" && labels && expected(labels) && phaseCheck === `CHECK${c.phase}=ANYARRAY[${labels.map(value => `'${value}'`).join(",")}]`)) reject("Exact synchronization phase constraint required");
  const foreign = run.constraints.filter(k => k.type === "f" && k.validated);
  if (!foreign.some(k => equal(k.columns, [c.shopId]) && k.target_schema === "mirror" && k.target_table === "shops" && equal(k.target_columns, [m.shops.columns.shopId]))) reject("Run-to-shop foreign key required");
  if (!foreign.some(k => equal(k.columns, [c.shopId, c.generationId]) && k.target_schema === "mirror" && k.target_table === "generations" && equal(k.target_columns, ["shop_id", "id"]))) reject("Tenant-bound run-to-generation foreign key required");
  const domain = m.runs.table === 'mirror.catalog_import_executions'
    ? await inspectSyncDomainSchema(tx, { mapping:m, execution:run, catalog, reject }) : null;
  return createHash("sha256").update(JSON.stringify({ run, shop, domain })).digest("hex");
}

/** Captures server configuration only after a real, consistent catalog read.
 * This physical proof grants no shop authorization or durable phase evidence.
 */
export async function verifySyncRunDbMapping({ database, prisma, mapping }) {
  const captured = capture(mapping);
  const fingerprint = await runSyncDbTransaction({ database, prisma, readOnly: true,
    work: tx => inspect(tx, captured) });
  const receipt = Object.freeze({ fingerprint, attemptLimit: captured.attemptLimit, table: captured.runs.table });
  mappings.set(receipt, { mapping: captured, fingerprint, driver: database || prisma });
  return receipt;
}
export function requireSyncRunDbMapping(receipt, driver) {
  const value = receipt && mappings.get(receipt);
  if (!value) reject("Genuine physically verified synchronization mapping required");
  if (driver && value.driver !== driver) reject("Synchronization mapping belongs to another database client");
  return value.mapping;
}
export async function revalidateSyncRunDbMapping(tx, receipt) {
  const m = requireSyncRunDbMapping(receipt);
  if (await inspect(tx, m) !== mappings.get(receipt).fingerprint) reject("Synchronization physical schema changed");
  return m;
}
