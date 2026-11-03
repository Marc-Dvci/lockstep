// Create the demo world.
//   node scripts/seed.js sandbox            root = tests/res/sandbox-root-key.json
//   ROOT_ACCOUNT=x.testnet ROOT_KEY=ed25519:... node scripts/seed.js testnet
import { readFileSync } from 'node:fs';
import { provider, account } from './lib/near.js';
import { createWorld, NETWORKS, worldPath } from './lib/world.js';

const network = process.argv[2] || 'sandbox';
const rpc = provider(NETWORKS[network].rpc);
let root;
if (network === 'sandbox') {
  const k = JSON.parse(readFileSync(process.env.SANDBOX_KEY || 'tests/res/sandbox-root-key.json', 'utf8'));
  root = account(k.account_id, rpc, k.secret_key);
} else {
  if (!process.env.ROOT_ACCOUNT || !process.env.ROOT_KEY) throw new Error('set ROOT_ACCOUNT and ROOT_KEY');
  root = account(process.env.ROOT_ACCOUNT, rpc, process.env.ROOT_KEY);
}
const t0 = Date.now();
await createWorld(network, root, { daoPrefix: process.env.DAO_PREFIX || 'lockstep', log: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`) });
console.log('world saved to', worldPath(network));
