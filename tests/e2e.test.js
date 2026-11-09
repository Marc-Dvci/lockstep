// End-to-end test against a local NEAR sandbox (nearcore 2.14.0, see tests/sandbox.sh).
// Deploys the tUSD token, Lockstep and three Sputnik DAOs running the exact code that
// sputnikv2.testnet deploys (v3.31), then drives real proposals and votes. Each pledge is
// a transfer proposal the DAO files on itself by a council vote; Lockstep only approves it.
//
//   SANDBOX_RPC=http://127.0.0.1:3030 SANDBOX_KEY=<path to validator_key.json> node --test tests/e2e.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { provider, account, view, call, createSubAccount, deploy, teraToGas, nearToYocto } from '../scripts/lib/near.js';
import {
  lockstepRoleKind, pledgeByVote, pledgeTransferKind, registerPledge, transferKind, propose, approve, analyse,
  allocationArgs, getPlan, topup, collectAll, disburse, ONE_YOCTO,
} from '../scripts/lib/lockstep.js';
import { sputnikWasm } from '../scripts/fetch-sputnik.js';

const RPC = process.env.SANDBOX_RPC || 'http://127.0.0.1:3030';
const KEY = JSON.parse(readFileSync(process.env.SANDBOX_KEY || 'tests/res/sandbox-root-key.json', 'utf8'));
const rpc = provider(RPC);
const root = account(KEY.account_id, rpc, KEY.secret_key);
const LOCKSTEP_WASM = readFileSync('target/near/lockstep/lockstep.wasm');
const TUSD_WASM = readFileSync('target/near/tusd/tusd.wasm');
const D = 1_000_000n; // tUSD has 6 decimals
const usd = (n) => BigInt(n) * D;
const report = { measured: {} };

const w = {}; // the world: accounts and contracts

async function sub(parent, prefix, near) {
  const { id, secretKey } = await createSubAccount(parent, prefix, near);
  return account(id, rpc, secretKey);
}

async function bal(id) {
  return BigInt(await view(rpc, w.token.accountId, 'ft_balance_of', { account_id: id }));
}

async function mint(id, amount) {
  const r = await call(root, w.token.accountId, 'mint', { account_id: id, amount: String(amount) }, { gas: teraToGas('30') });
  assert.equal(r.fails.length, 0, JSON.stringify(r.fails));
}

async function register(id) {
  const r = await call(root, w.token.accountId, 'storage_deposit', { account_id: id }, { deposit: nearToYocto('0.0125'), gas: teraToGas('30') });
  assert.equal(r.fails.length, 0, JSON.stringify(r.fails));
}

async function newDao(name, council) {
  const dao = await sub(w.factory, name, '12');
  await deploy(dao, await sputnikWasm(), {
    method: 'new',
    args: { config: { name, purpose: `${name} demo community`, metadata: '' }, policy: council.map((c) => c.accountId) },
  });
  return dao.accountId;
}

async function daoVote(daoId, description, kind) {
  const { id } = await propose(w.alice, daoId, description, kind, rpc);
  const { proposal } = await approve([w.alice, w.bob], daoId, id, rpc);
  return { id, proposal };
}

async function newPlan(title) {
  const lines = [
    { key: 'venue', label: 'Venue', payee: w.venue.accountId, amount: String(usd(400)) },
    { key: 'food', label: 'Food', payee: w.caterer.accountId, amount: String(usd(300)) },
    { key: 'travel', label: 'Speaker travel', payee: w.speaker.accountId, amount: String(usd(300)) },
  ];
  const r = await call(w.coordinator, w.lockstep.accountId, 'create_plan', { title, token: w.token.accountId, lines, open_for_sec: 3600 }, { deposit: nearToYocto('0.1'), gas: teraToGas('50') });
  assert.equal(r.fails.length, 0, JSON.stringify(r.fails));
  return Number(r.value);
}

async function nearOf(id) {
  return BigInt((await rpc.query({ request_type: 'view_account', account_id: id, finality: 'final' })).amount);
}

async function pledge(dao, planId, cap, lines) {
  const r = await pledgeByVote(w.alice, [w.alice, w.bob], dao, { tokenId: w.token.accountId, lockstepId: w.lockstep.accountId, planId, cap, lines, description: `Pledge to Lockstep plan #${planId}` }, rpc);
  assert.equal(r.proposal.status, 'Approved', `${dao} pledge vote`);
  assert.notEqual(r.pledgeId, null, `${dao} filed its own pledge proposal`);
  const reg = await registerPledge(w.stranger, w.lockstep.accountId, planId, dao, r.pledgeId); // anyone may register
  assert.equal(reg.fails.length, 0, JSON.stringify(reg.fails));
  return r.pledgeId;
}

async function pledgeAll(planId) {
  await pledge(w.events, planId, usd(500), ['venue']);
  await pledge(w.builders, planId, usd(250), ['travel']);
  await pledge(w.community, planId, usd(400), ['food', 'venue']);
}

/** No proposal on any DAO was filed by Lockstep. */
async function lockstepFiledNothing() {
  for (const dao of [w.events, w.builders, w.community]) {
    const all = await view(rpc, dao, 'get_proposals', { from_index: 0, limit: 200 });
    assert.ok(all.every((p) => p.proposer !== w.lockstep.accountId), `Lockstep filed a proposal on ${dao}`);
  }
}

test('setup: token, Lockstep, three Sputnik v3.31 DAOs with the Lockstep role', async () => {
  w.token = await sub(root, 'tusd', '10');
  await deploy(w.token, TUSD_WASM, { method: 'new', args: { owner_id: root.accountId, name: 'Lockstep test dollar (no value)', symbol: 'tUSD', decimals: 6 } });
  w.factory = await sub(root, 'sputnik', '60');
  w.lockstep = await sub(root, 'lockstep', '30');
  await deploy(w.lockstep, LOCKSTEP_WASM, { method: 'new', args: { tokens: [w.token.accountId], dao_factories: [w.factory.accountId], collect_window_sec: 600 } });
  for (const name of ['alice', 'bob', 'coordinator', 'donor', 'venue', 'caterer', 'speaker', 'stranger']) w[name] = await sub(root, name, '20');
  w.events = await newDao('events', [w.alice, w.bob]);
  w.builders = await newDao('builders', [w.alice, w.bob]);
  w.community = await newDao('community', [w.alice, w.bob]);
  for (const id of [w.lockstep.accountId, w.venue.accountId, w.caterer.accountId, w.speaker.accountId, w.stranger.accountId]) await register(id);
  await mint(w.events, usd(500));
  await mint(w.builders, usd(250));
  await mint(w.community, usd(400));
  await mint(w.donor.accountId, usd(200));
  for (const dao of [w.events, w.builders, w.community]) {
    const { proposal } = await daoVote(dao, 'Install Lockstep: it may approve transfer proposals, and approves only the one this DAO files as its pledge', lockstepRoleKind(w.lockstep.accountId));
    assert.equal(proposal.status, 'Approved');
  }
  const policy = await view(rpc, w.events, 'get_policy');
  assert.deepEqual(policy.roles.find((r) => r.name === 'lockstep').permissions, ['transfer:VoteApprove']);
});

test('a plan funded by three DAO pledges and a top-up settles and pays every payee', async () => {
  const planId = await newPlan("Builders' night");
  await pledgeAll(planId);

  let plan = await getPlan(rpc, w.lockstep.accountId, planId);
  let a = analyse(plan);
  assert.equal(a.pledged, usd(1150));
  assert.equal(a.required, usd(1000));
  assert.equal(a.gap, usd(50));
  assert.equal(a.completions.byLine.travel, usd(50));
  assert.equal(a.completions.byLine.food, null);
  assert.ok(a.certificateOk);

  // Activation with the gap is refused on chain.
  const early = await call(w.coordinator, w.lockstep.accountId, 'activate', { plan_id: planId, allocation: allocationArgs(a.allocation) }, { gas: teraToGas('100') });
  assert.ok(early.fails.length > 0, 'activation with a gap must fail');

  const t = await topup(w.donor, w.token.accountId, w.lockstep.accountId, planId, usd(50), ['travel']);
  assert.equal(t.fails.length, 0, JSON.stringify(t.fails));
  plan = await getPlan(rpc, w.lockstep.accountId, planId);
  a = analyse(plan);
  assert.equal(a.gap, 0n);

  const act = await call(w.coordinator, w.lockstep.accountId, 'activate', { plan_id: planId, allocation: allocationArgs(a.allocation) }, { gas: teraToGas('100') });
  assert.equal(act.fails.length, 0, JSON.stringify(act.fails));

  const daoBefore = { [w.events]: await bal(w.events), [w.builders]: await bal(w.builders), [w.community]: await bal(w.community) };
  const nearBefore = await nearOf(w.lockstep.accountId);
  const t0 = Date.now();
  const log = await collectAll(w.coordinator, rpc, w.lockstep.accountId, planId);
  report.measured.collect_ms = Date.now() - t0;
  report.measured.collect_gas_tgas = log.filter((l) => l.step === 'collect').map((l) => Number(l.gas / 10n ** 12n));
  for (const l of log) assert.equal(l.fails.length, 0, `${l.step} ${l.funder}: ${JSON.stringify(l.fails)}`);

  plan = await getPlan(rpc, w.lockstep.accountId, planId);
  assert.equal(plan.status, 'Settled', JSON.stringify(plan.shares));
  for (const s of plan.shares) {
    const p = await view(rpc, s.funder, 'get_proposal', { id: s.proposal_id });
    assert.equal(p.status, 'Approved');
    assert.equal(p.proposer, s.funder, 'the DAO filed its own pledge proposal');
    assert.equal(p.votes[w.lockstep.accountId], 'Approve', 'Lockstep approved it');
    assert.equal(daoBefore[s.funder] - (await bal(s.funder)), BigInt(s.amount), `${s.funder} paid exactly its share; the rest of its pledge came straight back`);
  }
  assert.ok((await nearOf(w.lockstep.accountId)) >= nearBefore, 'collecting cost Lockstep no NEAR');
  await lockstepFiledNothing();

  const d = await disburse(w.stranger, w.lockstep.accountId, planId); // anyone may disburse
  assert.equal(d.fails.length, 0, JSON.stringify(d.fails));
  plan = await getPlan(rpc, w.lockstep.accountId, planId);
  assert.ok(plan.claims.every((c) => c.state === 'Paid'));
  assert.equal(await bal(w.venue.accountId), usd(400));
  assert.equal(await bal(w.caterer.accountId), usd(300));
  assert.equal(await bal(w.speaker.accountId), usd(300));
  assert.equal(plan.escrow, '0');
  assert.equal(await bal(w.lockstep.accountId), 0n);
  report.measured.settled_plan = planId;
});

test('when one DAO no longer holds its pledge, the plan rolls back and nobody pays', async () => {
  // Refill the DAOs and the donor for a second round.
  await mint(w.events, usd(400));
  await mint(w.builders, usd(250));
  await mint(w.community, usd(300));
  const planId = await newPlan("Builders' night (second date)");
  await pledgeAll(planId);
  const t = await topup(w.donor, w.token.accountId, w.lockstep.accountId, planId, usd(50), ['travel']);
  assert.equal(t.fails.length, 0);

  // Community DAO's council pays an unrelated bill: its treasury drops below its share.
  const drain = await daoVote(w.community, 'Pay the hall deposit for another event', transferKind(w.token.accountId, w.stranger.accountId, usd(250)));
  assert.equal(drain.proposal.status, 'Approved');

  const before = { events: await bal(w.events), builders: await bal(w.builders), community: await bal(w.community), donor: await bal(w.donor.accountId) };
  let plan = await getPlan(rpc, w.lockstep.accountId, planId);
  const a = analyse(plan);
  assert.equal(a.gap, 0n);
  const act = await call(w.coordinator, w.lockstep.accountId, 'activate', { plan_id: planId, allocation: allocationArgs(a.allocation) }, { gas: teraToGas('100') });
  assert.equal(act.fails.length, 0, JSON.stringify(act.fails));

  const nearBefore = await nearOf(w.lockstep.accountId);
  const log = await collectAll(w.coordinator, rpc, w.lockstep.accountId, planId);
  plan = await getPlan(rpc, w.lockstep.accountId, planId);
  assert.equal(plan.status, 'RolledBack', JSON.stringify(plan.shares));
  assert.ok((await nearOf(w.lockstep.accountId)) >= nearBefore, 'a failed share cost Lockstep no NEAR');
  const failed = plan.shares.find((s) => s.state === 'Failed');
  assert.equal(failed.funder, w.community);
  const proposal = await view(rpc, w.community, 'get_proposal', { id: failed.proposal_id });
  assert.equal(proposal.status, 'Failed', 'the DAO itself marked the transfer Failed');
  assert.equal(proposal.proposer, w.community, 'the failed proposal was the DAO\'s own, with its own bond');
  report.measured.rollback_reason = failed.note;
  report.measured.rollback_steps = log.map((l) => l.step + ':' + l.funder.split('.')[0]);

  const d = await disburse(w.coordinator, w.lockstep.accountId, planId);
  assert.equal(d.fails.length, 0, JSON.stringify(d.fails));
  plan = await getPlan(rpc, w.lockstep.accountId, planId);
  assert.ok(plan.claims.every((c) => c.state === 'Paid' && c.kind === 'Refund'));
  assert.equal(await bal(w.events), before.events, 'Events DAO got its share back');
  assert.equal(await bal(w.builders), before.builders, 'Builders DAO got its share back');
  assert.equal(await bal(w.community), before.community, 'Community DAO lost nothing');
  assert.equal(await bal(w.donor.accountId), before.donor + usd(50), 'the donor got the top-up back');
  assert.equal(await bal(w.lockstep.accountId), 0n);
  report.measured.rolled_back_plan = planId;
});

test('a DAO without the Lockstep role is not failed: its council approves its own pledge', async () => {
  const lonely = await newDao('lonely', [w.alice, w.bob]);
  await mint(lonely, usd(100));
  const r = await call(w.coordinator, w.lockstep.accountId, 'create_plan', {
    title: 'Snacks', token: w.token.accountId, open_for_sec: 3600,
    lines: [{ key: 'food', label: 'Food', payee: w.caterer.accountId, amount: String(usd(100)) }],
  }, { deposit: nearToYocto('0.1'), gas: teraToGas('50') });
  const planId = Number(r.value);
  const pledgeId = await pledge(lonely, planId, usd(100), ['food']);
  const a = analyse(await getPlan(rpc, w.lockstep.accountId, planId));
  await call(w.coordinator, w.lockstep.accountId, 'activate', { plan_id: planId, allocation: allocationArgs(a.allocation) }, { gas: teraToGas('100') });
  await collectAll(w.coordinator, rpc, w.lockstep.accountId, planId);
  let plan = await getPlan(rpc, w.lockstep.accountId, planId);
  assert.equal(plan.status, 'Collecting');
  assert.equal(plan.shares[0].state, 'Waiting');
  assert.match(plan.shares[0].note, /council can approve it itself/);
  // The council approves its own pledge proposal; the transfer arrives like any other.
  const { proposal } = await approve([w.alice, w.bob], lonely, pledgeId, rpc);
  assert.equal(proposal.status, 'Approved');
  plan = await getPlan(rpc, w.lockstep.accountId, planId);
  assert.equal(plan.status, 'Settled');
  assert.equal(await bal(lonely), 0n);
});

test('spoofed tokens, foreign senders and food-only top-ups cannot move the plan', async () => {
  const planId = await newPlan("Builders' night (third date)");
  await pledgeAll(planId);
  // An account that is not a DAO under the accepted factory cannot pledge.
  const p = await registerPledge(w.stranger, w.lockstep.accountId, planId, w.stranger.accountId, 0);
  assert.ok(p.fails.length > 0);
  // Anyone may file proposals on a Sputnik DAO; a stranger's pledge-shaped proposal is not the DAO's pledge.
  const forged = await propose(w.stranger, w.events, 'Pledge 50 for travel', pledgeTransferKind(w.token.accountId, w.lockstep.accountId, planId, usd(50), ['travel']), rpc);
  const reg = await registerPledge(w.stranger, w.lockstep.accountId, planId, w.events, forged.id);
  assert.ok(reg.fails.some((f) => JSON.stringify(f.failure).includes('filed on itself')), JSON.stringify(reg.fails));
  // A food-only top-up is accepted as escrow but does not close the travel gap.
  const t = await topup(w.donor, w.token.accountId, w.lockstep.accountId, planId, usd(50), ['food']);
  assert.equal(t.fails.length, 0);
  const a = analyse(await getPlan(rpc, w.lockstep.accountId, planId));
  assert.equal(a.gap, usd(50));
  // A fake pledge arrival sent by a plain account through the real token is refunded.
  const donorBefore = await bal(w.donor.accountId);
  const fake = await call(w.donor, w.token.accountId, 'ft_transfer_call', {
    receiver_id: w.lockstep.accountId, amount: String(usd(10)), msg: JSON.stringify({ pledge: { plan_id: planId, lines: ['travel'] } }),
  }, { deposit: ONE_YOCTO, gas: teraToGas('100') });
  assert.ok(fake.fails.some((f) => f.executor === w.lockstep.accountId));
  assert.equal(await bal(w.donor.accountId), donorBefore);
  // A different token contract cannot reach ft_on_transfer.
  const direct = await call(w.stranger, w.lockstep.accountId, 'ft_on_transfer', { sender_id: w.donor.accountId, amount: '1', msg: JSON.stringify({ topup: { plan_id: planId, lines: ['travel'] } }) }, { gas: teraToGas('30') });
  assert.ok(direct.fails.length > 0);
});

test.after(() => {
  report.network = RPC;
  report.accounts = { lockstep: w.lockstep?.accountId, token: w.token?.accountId, daos: [w.events, w.builders, w.community] };
  writeFileSync('tests/res/e2e-report.json', JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
});
