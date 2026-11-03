// Delete every access key of the Lockstep contract account, so nobody can redeploy
// it or sign for it. Irreversible.   ROOT_ACCOUNT=... ROOT_KEY=... node scripts/lock.js testnet
import { readFileSync } from 'node:fs';
import { actions, KeyPair, PublicKey } from 'near-api-js';
import { provider, account } from './lib/near.js';
import { NETWORKS } from './lib/world.js';

const network = process.argv[2] || 'testnet';
const dep = JSON.parse(readFileSync(new URL(`../deployments/${network}.json`, import.meta.url), 'utf8'));
const rpc = provider(NETWORKS[network].rpc);
if (process.env.ROOT_ACCOUNT !== dep.lockstep) throw new Error(`ROOT_ACCOUNT must be ${dep.lockstep}`);
const acct = account(dep.lockstep, rpc, process.env.ROOT_KEY);
const { keys } = await rpc.query({ request_type: 'view_access_key_list', account_id: dep.lockstep, finality: 'final' });
const mine = KeyPair.fromString(process.env.ROOT_KEY).getPublicKey().toString();
const others = keys.map((k) => k.public_key).filter((k) => k !== mine);
const out = await acct.signAndSendTransaction({
  receiverId: dep.lockstep,
  actions: [...others, mine].map((pk) => actions.deleteKey(PublicKey.fromString(pk))),
  waitUntil: 'FINAL',
  throwOnFailure: true,
});
console.log(`deleted ${others.length + 1} key(s) of ${dep.lockstep} in ${out.transaction.hash}`);
