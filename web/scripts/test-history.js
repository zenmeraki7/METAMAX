/** Do not report empty future-phase placeholders as passing tests. */
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = new URL('../edit-history/tests/',import.meta.url);
const candidates = (await readdir(directory)).filter(name => name.endsWith('.test.js')).sort();
const files = [];
for (const name of candidates) if ((await readFile(new URL(name,directory),'utf8')).trim()) files.push(fileURLToPath(new URL(name,directory)));
if (!files.length) throw Error('No implemented history tests found');
console.log(`Running ${files.length} implemented history test files; ${candidates.length-files.length} empty placeholders excluded.`);
const result = spawnSync(process.execPath,['--experimental-test-module-mocks','--test',...files],{ stdio: 'inherit',windowsHide: true,timeout: 60000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.error || result.status !== 0 ? 1 : 0;
