/** CLI infrastructure only. Never import from HTTP/runtime modules. */
import {existsSync,readFileSync} from 'node:fs';
import dotenv from 'dotenv';
export function loadMigrationEnvironment(){
  const read=name=>{const file=new URL(`../${name}`,import.meta.url);return existsSync(file)?dotenv.parse(readFileSync(file)):{};};
  return {...read('.env'),...read('.env.migrations')};
}
