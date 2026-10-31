/** Generate the empty-V1 upgrade without dropping history tables or rewriting V1. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const v1 = await readFile(new URL('../prisma/migrations/20261030110000_edit_history_v1/migration.sql', import.meta.url), 'utf8');
const v2 = await readFile(new URL('../prisma-fresh/20261030110000_edit_history_v2/migration.sql', import.meta.url), 'utf8');
const clean = sql => sql.replace(/--[^\n]*/g, '');
const pattern = /CREATE TABLE edit_history\.(\w+) \(([\s\S]*?)\n\);/g;
function parts(body) {
  let level = 0, quoted = false, start = 0; const result = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "'") { if (quoted && body[i+1] === "'") { i++; continue; } quoted = !quoted; }
    if (quoted) continue;
    if (body[i] === '(') level++;
    if (body[i] === ')') level--;
    if (body[i] === ',' && level === 0) { result.push(body.slice(start,i).trim()); start = i+1; }
  }
  result.push(body.slice(start).trim()); return result;
}
const tables = sql => [...clean(sql).matchAll(pattern)].map(m => ({ name: m[1], parts: parts(m[2]) }));
const old = tables(v1), next = tables(v2);
if (old.length !== 5 || next.length !== 5) throw Error('Expected five history tables');
const drops = [], columns = [], foreignKeys = [];
for (const m of clean(v1).matchAll(/ALTER TABLE edit_history\.(\w+)\s+ADD CONSTRAINT (\w+)\s+([\s\S]*?);/g)) {
  (/FOREIGN KEY/.test(m[3]) ? foreignKeys : drops).push(`ALTER TABLE edit_history.${m[1]} DROP CONSTRAINT ${m[2]};`);
}
for (const table of old) {
  for (const p of table.parts.filter(p => p.startsWith('CONSTRAINT '))) {
    const constraint = p.match(/^CONSTRAINT (\w+)/)[1];
    (/FOREIGN KEY/.test(p) ? foreignKeys : drops).push(`ALTER TABLE edit_history.${table.name} DROP CONSTRAINT ${constraint};`);
  }
  const replacement = next.find(n => n.name === table.name);
  const oldColumns = table.parts.filter(p => !p.startsWith('CONSTRAINT '));
  for (const p of replacement.parts.filter(p => !p.startsWith('CONSTRAINT '))) {
    const name = p.match(/^\w+/)[0], previous = oldColumns.find(c => c.match(/^\w+/)[0] === name);
    if (!previous) columns.push(`ALTER TABLE edit_history.${table.name} ADD COLUMN ${p};`);
    else if (previous.replace(/\s+/g,' ') !== p.replace(/\s+/g,' ')) throw Error(`Unexpected column definition change: ${table.name}.${name}`);
  }
}
const triggers = [...v1.matchAll(/CREATE TRIGGER (\w+)\s+BEFORE (?:UPDATE|INSERT|DELETE)(?:[^;]*?) ON edit_history\.(\w+)[\s\S]*?EXECUTE FUNCTION[^;]*;/g)]
  .map(m => `DROP TRIGGER ${m[1]} ON edit_history.${m[2]};`);
if (triggers.length !== 3) throw Error('Unexpected V1 trigger inventory');
const indexes = [...v1.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map(m => `DROP INDEX edit_history.${m[1]};`);
const functions = [...v1.matchAll(/CREATE FUNCTION edit_history\.(\w+)\(\)/g)].map(m => `DROP FUNCTION edit_history.${m[1]}();`);
const names = old.map(t => `edit_history.${t.name}`).join(', ');
const header = `-- Edit History V2 upgrade from EMPTY V1. History Contract V3.\n-- V1 is preserved and actually applied; no table/data drops or invented backfills.\n-- Populated V1 requires a separate provenance-aware data migration and is rejected.\n-- Generated from the reviewed V1 and V2 sources by build-history-v2-upgrade.js.\n-- V2 SHA256: ${createHash('sha256').update(v2).digest('hex')}\nBEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\nLOCK TABLE ${names} IN ACCESS EXCLUSIVE MODE;\nDO $$ BEGIN\n${old.map(t => `  IF EXISTS (SELECT 1 FROM edit_history.${t.name}) THEN\n    RAISE EXCEPTION 'V2 upgrade requires empty V1 history; preserve legacy records and migrate authenticated provenance first' USING ERRCODE='55000';\n  END IF;`).join('\n')}\nEND $$;\n`;
const changes = [...triggers,...foreignKeys,...drops,...indexes,...functions,...columns].join('\n');
const body = v2.replace(/--[^\n]*/g, '').replace(pattern, (_match, name, content) =>
  parts(content).filter(p => p.startsWith('CONSTRAINT ')).map(p => `ALTER TABLE edit_history.${name} ADD ${p};`).join('\n')).trim();
const target = new URL('../prisma/migrations/20261030120000_edit_history_v2_upgrade/', import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(new URL('migration.sql', target), `${header}\n${changes}\n\n${body}\nCOMMIT;\n`);
console.log(`Generated ${columns.length} added columns and V2 constraints/triggers; V1 unchanged`);
