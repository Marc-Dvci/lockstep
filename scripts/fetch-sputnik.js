// Download the Sputnik DAO v2 code that sputnikv2.testnet deploys by default
// (factory default version [3,31], commit 7764926c) and check its hash.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/near-daos/sputnik-dao-contract/7764926cfd3c47f62b5fcde231c251f3c3892887/sputnikdao2/res/sputnikdao2.wasm';
const SHA256 = '880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da';
const FILE = fileURLToPath(new URL('../tests/res/sputnikdao2-v3.31.wasm', import.meta.url));

export async function sputnikWasm() {
  if (!existsSync(FILE)) {
    mkdirSync(fileURLToPath(new URL('../tests/res/', import.meta.url)), { recursive: true });
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    writeFileSync(FILE, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(FILE);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== SHA256) throw new Error(`sputnik wasm hash ${got} != ${SHA256}`);
  return bytes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  sputnikWasm().then((b) => console.log(`ok: ${b.length} bytes, sha256 ${SHA256}`));
}
