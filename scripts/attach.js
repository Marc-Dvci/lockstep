// Deploy Lockstep 2 to a new account and attach it to an existing demo world: the same token, DAOs, councils and
// demo accounts. The previous world file is kept as world-<network>-v1.json. Each step checks first, so a rerun
// resumes where it stopped. Delete the contract's keys afterwards with scripts/lock.js.
//   CONTRACT_ACCOUNT=lockstep-v2.testnet CONTRACT_KEY=ed25519:... node scripts/attach.js testnet
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { actions } from 'near-api-js';
import { provider, account, view, call, deploy, teraToGas, nearToYocto, retryRead } from './lib/near.js';
import { lockstepRoleKind, propose, approve } from './lib/lockstep.js';
import { NETWORKS, DATA_DIR, worldPath, writeDeployment } from './lib/world.js';
import { baseEncode } from './lib/verify-deps.js';

const network = process.argv[2] || 'testnet';
const id = process.env.CONTRACT_ACCOUNT;
const key = process.env.CONTRACT_KEY;
if (!id || !key) throw new Error('set CONTRACT_ACCOUNT and CONTRACT_KEY');
const rpc = provider(NETWORKS[network].rpc);
const NEAR = 10n ** 24n;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
const viewAccount = (a) => retryRead(() => rpc.query({ request_type: 'view_account', account_id: a, finality: 'final' }));
const free = async (a) => { const v = await viewAccount(a); return BigInt(v.amount) - BigInt(v.storage_usage) * 10n ** 19n; };
const near = (y) => (Number(y / 10n ** 21n) / 1000).toFixed(3);

const wp = worldPath(network);
const w = JSON.parse(readFileSync(wp, 'utf8'));
const v1Path = DATA_DIR + `world-${network}-v1.json`;
if (w.lockstep !== id) {
  if (!existsSync(v1Path)) copyFileSync(wp, v1Path);
  const st = DATA_DIR + `state-${network}.json`;
  if (existsSync(st)) renameSync(st, DATA_DIR + `state-${network}-v1.json`);
  log(`previous world kept as ${v1Path} (contract ${w.lockstep})`);
}
const contract = account(id, rpc, key);
const acct = (name) => account(w.accounts[name].id, rpc, w.accounts[name].key);
const daoIds = Object.values(w.daos).map((d) => d.id);

// 1. Treasuries in NEAR: a pledge vote makes the DAO file its own proposal with its own bond, so each DAO keeps
//    1.6 NEAR above its storage; the coordinator pays 0.1 NEAR of storage per plan.
const wasm = readFileSync(fileURLToPath(new URL('../target/near/lockstep/lockstep.wasm', import.meta.url)));
const code = (await viewAccount(id)).code_hash;
for (const [who, want] of [...daoIds.map((d) => [d, 16n * NEAR / 10n]), [w.accounts.coordinator.id, 3n * NEAR / 2n]]) {
  const have = await free(who);
  if (have >= want) { log(`${who} has ${near(have)} NEAR free`); continue; }
  const send = ((want - have) / (NEAR / 10n) + 1n) * (NEAR / 10n);
  const out = await contract.signAndSendTransaction({ receiverId: who, actions: [actions.transfer(send)], waitUntil: 'FINAL', throwOnFailure: true });
  log(`sent ${near(send)} NEAR to ${who} (${out.transaction.hash})`);
}

// 2. The contract
if (code === '11111111111111111111111111111111') {
  const out = await deploy(contract, wasm, { method: 'new', args: { tokens: [w.token], dao_factories: [w.factory], collect_window_sec: 600 } });
  log(`deployed and initialised ${id} (${out.transaction.hash})`);
} else {
  log(`${id} already runs code ${code}`);
}
const deployed = (await viewAccount(id)).code_hash;
const local = baseEncode(createHash('sha256').update(wasm).digest());
if (deployed !== local) throw new Error(`deployed code ${deployed} is not the local build ${local}`);
log(`code hash ${deployed} = target/near/lockstep/lockstep.wasm`);

// 3. Lockstep can hold the token
if (!(await view(rpc, w.token, 'storage_balance_of', { account_id: id }))) {
  const r = await call(acct('ops'), w.token, 'storage_deposit', { account_id: id }, { deposit: nearToYocto('0.0125'), gas: teraToGas('30') });
  if (r.fails.length) throw new Error('storage_deposit failed');
  log(`registered ${id} with ${w.token} (${r.hash})`);
}

// 4. Each council installs a role that may only approve transfer proposals
const alice = acct('alice'), bob = acct('bob');
for (const d of Object.values(w.daos)) {
  const policy = await view(rpc, d.id, 'get_policy');
  if (policy.roles.some((r) => r.kind?.Group?.includes(id))) { log(`${d.name} already has a role for ${id}`); continue; }
  const p = await propose(alice, d.id, `Install Lockstep 2 (${id}): it may approve transfer proposals, and approves only the one this DAO files as its pledge, once the plan is funded. It cannot file a proposal.`, lockstepRoleKind(id, 'lockstep-v2'), rpc);
  const { proposal, txs } = await approve([alice, bob], d.id, p.id, rpc);
  if (proposal.status !== 'Approved') throw new Error(`role on ${d.id}: ${proposal.status}`);
  log(`${d.name}: role lockstep-v2 installed by proposal #${p.id} (${txs.map((t) => t.hash).join(', ')})`);
  d.roleProposalV2 = p.id;
}

// 5. The world now points at Lockstep 2
w.lockstep = id;
w.accounts.lockstep = { id, key: null };
w.created = new Date().toISOString();
writeFileSync(wp, JSON.stringify(w, null, 2));
writeDeployment(network, w);
const depPath = fileURLToPath(new URL(`../deployments/${network}.json`, import.meta.url));
const dep = JSON.parse(readFileSync(depPath, 'utf8'));
writeFileSync(depPath, JSON.stringify({ ...dep, code_hash: deployed, source: 'contract/ at tag v2.0.0' }, null, 2) + '\n');
writeFileSync(DATA_DIR + 'RENDER_WORLD_JSON_B64.txt', Buffer.from(JSON.stringify(w)).toString('base64'));
log(`world, deployments/${network}.json and RENDER_WORLD_JSON_B64.txt updated; contract keeps ${near(await free(id))} NEAR free`);
log(`next: ROOT_ACCOUNT=${id} ROOT_KEY=<its key> node scripts/lock.js ${network}`);
