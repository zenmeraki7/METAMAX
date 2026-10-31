/** Explicitly scoped deployment: actual V1, then empty-history V2 upgrade only.
 * Recovery dump/config stay in an ignored local audit directory. No credentials
 * are written to files, passed on command lines or printed in logs.
 */
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

const mode = process.argv[2];
if (!['backup','stage','live','verify'].includes(mode)) throw Error('Expected backup, stage, live or verify');
const web = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../.audit/history-deploy-20261030/', import.meta.url));
const targetNames = ['20261030110000_edit_history_v1','20261030120000_edit_history_v2_upgrade'];
const envBytes = await readFile(new URL('../.env', import.meta.url));
const local = dotenv.parse(envBytes);
const live = new URL(process.env.DIRECT_DATABASE_URL || local.DIRECT_DATABASE_URL || '');
if (live.hostname !== 'ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech' || live.pathname !== '/newmeta_app') throw Error('Configured migration target changed');
live.searchParams.set('schema','mirror');
const stage = new URL(live);
stage.hostname = 'ep-wild-scene-aoryowq0.c-2.ap-southeast-1.aws.neon.tech';
stage.pathname = '/history_v2_validation_20261030';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = name => `"${name.replaceAll('"','""')}"`;
const redact = message => String(message).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]')
  .replaceAll(decodeURIComponent(live.password),'[REDACTED]');
const save = (name, value) => writeFile(join(root,name),JSON.stringify(value,null,2));
await mkdir(root,{ recursive: true });
function run(executable, args, extraEnv = {}, timeout = 120000) {
  const result = spawnSync(executable,args,{ cwd: web,windowsHide: true,encoding: 'utf8',timeout,
    env: { ...process.env,...extraEnv },maxBuffer: 8*1024*1024 });
  if (result.error || result.status !== 0) throw Error(redact(result.stderr || result.error?.message || result.stdout || 'Migration command failed'));
  return redact((result.stdout || '') + (result.stderr || ''));
}
function pgEnv(url) {
  return { PGHOST: url.hostname,PGPORT: url.port || '5432',PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username),PGPASSWORD: decodeURIComponent(url.password),PGSSLMODE: 'require',PGCONNECT_TIMEOUT: '20' };
}
async function connect(url) {
  const p = new pg.Pool({ connectionString: url.href,connectionTimeoutMillis: 20000,query_timeout: 30000,max: 2 });
  await p.query('SELECT 1'); return p;
}
async function ledger(p) {
  const rows = (await p.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM mirror._prisma_migrations ORDER BY started_at,id')).rows;
  for (const r of rows.filter(r => !r.rolled_back_at)) {
    if (!r.finished_at) throw Error(`Incomplete migration: ${r.migration_name}`);
    const bytes = await readFile(new URL(`../prisma/migrations/${r.migration_name}/migration.sql`, import.meta.url));
    if (hash(bytes) !== r.checksum) throw Error(`Local migration checksum mismatch: ${r.migration_name}`);
  }
  return rows.filter(r => !r.rolled_back_at);
}
async function existingData(p) {
  const tables = (await p.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('mirror','public') AND c.relkind='r' AND c.relname<>'_prisma_migrations' ORDER BY n.nspname,c.relname`)).rows;
  const result = [];
  for (const table of tables) {
    const name = `${quote(table.schema)}.${quote(table.name)}`;
    const count = (await p.query(`SELECT count(*)::text AS count FROM ${name}`)).rows[0].count;
    if (BigInt(count)>100000n) throw Error(`Streaming verification required for large table ${name}`);
    const content = (await p.query(`SELECT md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS fingerprint
      FROM (SELECT md5(row_to_json(t)::text) AS h FROM ${name} t) rows`)).rows[0].fingerprint;
    result.push({ ...table,count,fingerprint: content });
  }
  return result;
}
async function prepareMigrationDirectory(rows) {
  const path = join(root,'migrations'); await mkdir(path,{ recursive: true });
  for (const name of new Set([...rows.map(r => r.migration_name),...targetNames])) {
    const destination = join(path,name); await mkdir(destination,{ recursive: true });
    await copyFile(new URL(`../prisma/migrations/${name}/migration.sql`,import.meta.url),join(destination,'migration.sql'));
  }
  await copyFile(new URL('../prisma/migrations/migration_lock.toml',import.meta.url),join(path,'migration_lock.toml'));
  const config = join(root,'prisma.config.mjs');
  await writeFile(config,`export default {schema:${JSON.stringify(join(web,'prisma'))},migrations:{path:${JSON.stringify(path)}},datasource:{url:process.env.HISTORY_MIGRATION_URL}};\n`);
  return config;
}
async function verifyHistory(p) {
  const history = await ledger(p);
  for (const name of targetNames) if (!history.some(r => r.migration_name === name)) throw Error(`History migration not recorded: ${name}`);
  const tables = (await p.query("SELECT tablename FROM pg_tables WHERE schemaname='edit_history' ORDER BY tablename")).rows.map(r => r.tablename);
  if (JSON.stringify(tables) !== JSON.stringify(['changes','operations','recovery_tasks','snapshots','undo_requests'])) throw Error('Unexpected history table inventory');
  const barrier = (await p.query("SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='eh_change_requires_before' AND tgrelid='edit_history.changes'::regclass")).rows[0];
  if (!barrier?.tgdeferrable || !barrier.tginitdeferred) throw Error('Deferred BEFORE barrier missing');
  const body = (await p.query("SELECT pg_get_functiondef('edit_history.guard_change_update()'::regprocedure) AS body")).rows[0].body;
  if ((body.match(/NEW.last_evidence_kind IS DISTINCT FROM/g) || []).length !== 5) throw Error('Evidence trigger is not NULL-safe');
  const constraints = (await p.query(`SELECT conname FROM pg_constraint WHERE connamespace='edit_history'::regnamespace
    AND conname IN ('eh_change_dispatch_evidence','eh_change_outcome_evidence','eh_snapshot_change_operation_fk','eh_recovery_targets','eh_undo_handoff_unique')`)).rows;
  if (constraints.length !== 5) throw Error('V2 integrity constraints missing');
  return { tables,barrier,nullSafeComparisons: 5,historyMigrations: targetNames,appliedMigrationCount: history.length };
}
async function deploy(url,label) {
  const p = await connect(url);
  try {
    const history = await ledger(p),before = await existingData(p);
    const prior = history.filter(r => !targetNames.includes(r.migration_name));
    const config = await prepareMigrationDirectory(prior);
    // Only V1 and V2 are present as unapplied migrations in this isolated config.
    const output = run(process.execPath,[process.env.PRISMA_CLI,'migrate','deploy','--config',config],{ HISTORY_MIGRATION_URL: url.href });
    await writeFile(join(root,`${label}-deploy.log`),output);
    const verification = await verifyHistory(p),after = await existingData(p);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error(`Existing ${label} data changed during deployment`);
    const applied = await ledger(p);
    if (applied.length !== prior.length+2) throw Error('Unexpected unrelated migration applied');
    const result = { label,host: url.hostname,database: url.pathname.slice(1),verifiedAt: new Date().toISOString(),
      existingDataPreserved: true,existingTableCount: before.length,...verification,before,after };
    await save(`${label}-verification.json`,result);
    console.log(`${label}: history V1/V2 migrations verified; ${before.length} existing tables preserved; unrelated migrations untouched`);
  } finally { await p.end(); }
}
try {
  if (mode === 'backup') {
    const p = await connect(live);
    try {
      const rows = await ledger(p);
      const schema = (await p.query("SELECT to_regnamespace('edit_history') AS schema")).rows[0].schema;
      if (schema !== null || rows.some(r => targetNames.includes(r.migration_name))) throw Error('Expected fresh history deployment; inspect existing history first');
      const before = await existingData(p);
      const backup = join(root,'before-history-v2.dump');
      run(join(process.env.FILTER_POSTGRES_BIN,'pg_dump.exe'),['--format=custom','--no-owner','--no-privileges','--file',backup],pgEnv(live));
      const metadata = { host: live.hostname,database: live.pathname.slice(1),createdAt: new Date().toISOString(),
        bytes: (await stat(backup)).size,sha256: hash(await readFile(backup)),migrationCount: rows.length,before };
      await save('recovery.json',metadata);
      console.log(`Recovery dump saved: ${metadata.bytes} bytes; ${rows.length} applied migration checksums verified`);
    } finally { await p.end(); }
  }
  if (mode === 'stage') {
    const backup = join(root,'before-history-v2.dump');
    const recovery = JSON.parse(await readFile(join(root,'recovery.json'),'utf8'));
    if (hash(await readFile(backup)) !== recovery.sha256) throw Error('Recovery dump checksum changed');
    const p = await connect(stage);
    try {
      if ((await p.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname IN ('mirror','public','edit_history')")).rows[0].count !== 0) throw Error('Scratch validation database is not empty');
    } finally { await p.end(); }
    run(join(process.env.FILTER_POSTGRES_BIN,'pg_restore.exe'),['--no-owner','--no-privileges','--exit-on-error','--dbname',stage.pathname.slice(1),backup],pgEnv(stage));
    const restored = await connect(stage);
    try { if (JSON.stringify(await existingData(restored)) !== JSON.stringify(recovery.before)) throw Error('Restored data differs from recovery snapshot'); }
    finally { await restored.end(); }
    await deploy(stage,'stage');
  }
  if (mode === 'live') {
    const stageProof = JSON.parse(await readFile(join(root,'stage-verification.json'),'utf8'));
    if (!stageProof.existingDataPreserved || stageProof.database !== stage.pathname.slice(1)) throw Error('Verified scratch deployment required');
    const recovery = JSON.parse(await readFile(join(root,'recovery.json'),'utf8'));
    if (hash(await readFile(join(root,'before-history-v2.dump'))) !== recovery.sha256) throw Error('Recovery archive missing or changed');
    await deploy(live,'live');
  }
  if (mode === 'verify') {
    const p = await connect(live);
    try { console.log(JSON.stringify(await verifyHistory(p))); } finally { await p.end(); }
  }
  if (hash(envBytes) !== hash(await readFile(new URL('../.env',import.meta.url)))) throw Error('Application environment changed');
} catch (error) { console.error(redact(error.message)); process.exitCode=1; }
