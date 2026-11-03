// The demo world: token, Lockstep, three Sputnik DAOs with a two-member council,
// a coordinator, a donor and three payees. Created on a sandbox or on testnet and
// saved to web/.data/world-<network>.json (git-ignored: it holds testnet keys).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { provider, account, view, call, createSubAccount, deploy, teraToGas, nearToYocto, b64json } from './near.js';
import { lockstepRoleKind, propose, approve } from './lockstep.js';
import { sputnikWasm } from '../fetch-sputnik.js';

export const DATA_DIR = fileURLToPath(new URL('../../web/.data/', import.meta.url));
export const D = 1_000_000n; // tUSD: 6 decimals
export const usd = (n) => BigInt(Math.round(Number(n) * 1e6));

export const NETWORKS = {
  sandbox: { rpc: process.env.SANDBOX_RPC || 'http://127.0.0.1:3030', explorer: null, daoFactory: null },
  testnet: {
    rpc: process.env.TESTNET_RPC || 'https://test.rpc.fastnear.com',
    explorer: 'https://testnet.nearblocks.io',
    daoFactory: 'sputnikv2.testnet',
  },
};

/** The standard demo: what each DAO holds and pledges, and the plan's cost lines. */
export const DEMO = {
  daos: [
    { key: 'events', name: 'Events DAO', treasury: 500, cap: 500, lines: ['venue'] },
    { key: 'builders', name: 'Builders DAO', treasury: 250, cap: 250, lines: ['travel'] },
    { key: 'community', name: 'Community DAO', treasury: 400, cap: 400, lines: ['food', 'venue'] },
  ],
  lines: [
    { key: 'venue', label: 'Venue', payee: 'venue', amount: 400 },
    { key: 'food', label: 'Food', payee: 'caterer', amount: 300 },
    { key: 'travel', label: 'Speaker travel', payee: 'speaker', amount: 300 },
  ],
  donor: 1000,
};

export function worldPath(network) {
  return DATA_DIR + `world-${network}.json`;
}

export function loadWorld(network) {
  const p = worldPath(network);
  if (!existsSync(p)) throw new Error(`no world for ${network}: run node scripts/seed.js ${network}`);
  const w = JSON.parse(readFileSync(p, 'utf8'));
  const rpc = provider(NETWORKS[network].rpc);
  const acct = (name) => account(w.accounts[name].id, rpc, w.accounts[name].key);
  return { ...w, rpc, acct, explorer: NETWORKS[network].explorer };
}

function save(network, w) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(worldPath(network), JSON.stringify(w, null, 2));
}

/**
 * Build the world under `root` (a funded account). On testnet the DAOs are created
 * through the sputnikv2.testnet factory; on a sandbox the same Sputnik code is
 * deployed to sub-accounts of a stand-in factory account.
 */
export async function createWorld(network, root, { prefix = '', daoPrefix = 'lockstep', log = console.log } = {}) {
  const net = NETWORKS[network];
  const rpc = root.provider;
  const w = { network, created: new Date().toISOString(), accounts: {}, daos: {}, explorer: net.explorer };
  const keep = (name, a) => { w.accounts[name] = { id: a.id, key: a.secretKey }; save(network, w); return account(a.id, rpc, a.secretKey); };
  const mk = async (name, near) => keep(name, await createSubAccount(root, prefix ? `${prefix}-${name}` : name, near));

  log('accounts');
  const ops = await mk('ops', network === 'testnet' ? '3' : '20'); // token owner
  const token = await mk('token', '3');
  const lockstep = await mk('lockstep', network === 'testnet' ? '4' : '20');
  for (const n of ['alice', 'bob', 'coordinator', 'donor', 'venue', 'caterer', 'speaker', 'landlord']) await mk(n, network === 'testnet' ? (['alice', 'bob'].includes(n) ? '2' : '1') : '20');

  log('token');
  await deploy(token, readFileSync(fileURLToPath(new URL('../../target/near/tusd/tusd.wasm', import.meta.url))), {
    method: 'new', args: { owner_id: ops.accountId, name: 'Lockstep test dollar (no value)', symbol: 'tUSD', decimals: 6 },
  });
  w.token = token.accountId;

  log('DAOs');
  const council = [w.accounts.alice.id, w.accounts.bob.id];
  let factoryId = net.daoFactory;
  if (!factoryId) factoryId = (await mk('sputnik', '50')).accountId;
  for (const d of DEMO.daos) {
    const name = `${daoPrefix}-${d.key}`;
    const args = { config: { name, purpose: `${d.name}: demo community for Lockstep (test funds, no value)`, metadata: '' }, policy: council };
    let daoId;
    if (net.daoFactory) {
      const r = await call(root, factoryId, 'create', { name, args: b64json(args) }, { deposit: nearToYocto('6'), gas: teraToGas('300') });
      if (r.fails.length) throw new Error(`DAO ${name}: ${JSON.stringify(r.fails[0].failure)}`);
      daoId = `${name}.${factoryId}`;
    } else {
      const factory = account(factoryId, rpc, w.accounts.sputnik.key);
      const sub = await createSubAccount(factory, name, '12');
      await deploy(account(sub.id, rpc, sub.secretKey), await sputnikWasm(), { method: 'new', args });
      daoId = sub.id;
    }
    w.daos[d.key] = { id: daoId, name: d.name };
    save(network, w);
  }

  log('Lockstep');
  await deploy(lockstep, readFileSync(fileURLToPath(new URL('../../target/near/lockstep/lockstep.wasm', import.meta.url))), {
    method: 'new', args: { tokens: [w.token], dao_factories: [factoryId], collect_window_sec: 600 },
  });
  w.lockstep = lockstep.accountId;
  w.factory = factoryId;
  save(network, w);

  log('token registrations');
  for (const id of [w.lockstep, w.accounts.venue.id, w.accounts.caterer.id, w.accounts.speaker.id, w.accounts.landlord.id]) {
    const r = await call(ops, w.token, 'storage_deposit', { account_id: id }, { deposit: nearToYocto('0.0125'), gas: teraToGas('30') });
    if (r.fails.length) throw new Error(`storage_deposit ${id}`);
  }

  log('Lockstep role on each DAO');
  const alice = account(w.accounts.alice.id, rpc, w.accounts.alice.key);
  const bob = account(w.accounts.bob.id, rpc, w.accounts.bob.key);
  for (const d of Object.values(w.daos)) {
    const { id } = await propose(alice, d.id, 'Install Lockstep: it may file and approve transfer proposals, only for shares this DAO pledged by vote', lockstepRoleKind(w.lockstep), rpc);
    const { proposal } = await approve([alice, bob], d.id, id, rpc);
    if (proposal.status !== 'Approved') throw new Error(`role on ${d.id}: ${proposal.status}`);
    d.roleProposal = id;
  }
  save(network, w);
  writeDeployment(network, w);
  log('done');
  return w;
}

/** Public facts about a deployment (no keys), committed so anyone can run verify. */
export function writeDeployment(network, w) {
  const dir = fileURLToPath(new URL('../../deployments/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + `${network}.json`, JSON.stringify({
    network, rpc: NETWORKS[network].rpc, explorer: NETWORKS[network].explorer, created: w.created,
    lockstep: w.lockstep, token: w.token, factory: w.factory,
    daos: Object.values(w.daos).map((d) => ({ id: d.id, name: d.name })),
    council: [w.accounts.alice.id, w.accounts.bob.id],
    demoAccounts: Object.fromEntries(['coordinator', 'donor', 'venue', 'caterer', 'speaker', 'landlord'].map((k) => [k, w.accounts[k].id])),
  }, null, 2) + String.fromCharCode(10));
}

export async function balanceOf(rpc, tokenId, id) {
  return BigInt(await view(rpc, tokenId, 'ft_balance_of', { account_id: id }));
}
