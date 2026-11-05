// Lockstep demo server. Serves the page and runs demo actions on chain with
// throwaway demo accounts (test token, no value). One chain job runs at a time.
//
//   NETWORK=sandbox|testnet PORT=8787 node web/server.js
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { view, call, teraToGas, nearToYocto, sleep, retryRead } from '../scripts/lib/near.js';
import {
  pledgeKind, transferKind, propose, approve, analyse, allocationArgs, getPlan, topup, collectAll, disburse,
} from '../scripts/lib/lockstep.js';
import { loadWorld, DEMO, DATA_DIR, usd, balanceOf } from '../scripts/lib/world.js';

const NETWORK = process.env.NETWORK || 'sandbox';
const PORT = Number(process.env.PORT || 8787);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const w = loadWorld(NETWORK);
// The transaction log of each plan. A host's disk may be wiped on restart, so the
// committed snapshot in deployments/ (tx hashes and labels only, no keys) seeds it.
const STATE_FILE = DATA_DIR + `state-${NETWORK}.json`;
const SNAPSHOT = fileURLToPath(new URL(`../deployments/log-${NETWORK}.json`, import.meta.url));
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : { current: null, plans: {} };
const saveState = () => { try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* read-only disk: keep in memory */ } };
// Plans created by anyone else on the contract still show up.
async function syncPlans() {
  try {
    const plans = await view(w.rpc, w.lockstep, 'get_plans', { from_index: 0, limit: 50 });
    for (const p of plans) state.plans[p.id] ||= { title: p.title, created: new Date(Number(BigInt(p.created_at) / 1_000_000n)).toISOString(), log: [] };
    if (state.current === null && plans.length) state.current = plans[plans.length - 1].id;
  } catch (e) { console.error('syncPlans', e.message); }
}
await syncPlans();

const A = Object.fromEntries(Object.keys(w.accounts).filter((k) => w.accounts[k].key).map((k) => [k, w.acct(k)]));
// Without demo keys (no WORLD_JSON_B64 and no seeded world), the page reads the live plans and the actions are off.
const READ_ONLY = !A.coordinator;
const READ_ONLY_ERROR = 'This copy is read-only: it has no demo keys. It shows the live plans; the hosted demo runs the actions.';
const daoName = (id) => Object.values(w.daos).find((d) => d.id === id)?.name || id;
const lineLabel = Object.fromEntries(DEMO.lines.map((l) => [l.key, l.label]));
const txUrl = (hash) => (w.explorer && hash ? `${w.explorer}/txns/${hash}` : null);

// ---------------------------------------------------------------- job queue

const jobs = new Map();
let chain = Promise.resolve();
let seq = 0;

function startJob(kind, planId, fn) {
  const pending = [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
  if (pending.length >= 4) return { error: 'busy: a few demo actions are already running, try again shortly', status: 429 };
  const job = { id: String(++seq), kind, planId, status: 'queued', steps: [], started: null, finished: null, error: null };
  jobs.set(job.id, job);
  const step = (label, r, extra = {}) => {
    const s = { label, at: new Date().toISOString(), hash: r?.hash || null, url: txUrl(r?.hash), ok: r ? r.fails.length === 0 : true, ...extra };
    if (r && r.fails.length) s.failure = summariseFailure(r.fails);
    job.steps.push(s);
    for (const k of [...cache.keys()]) if (k.startsWith('plan:')) cache.delete(k);
    const pid = job.planId;
    if (pid !== null && pid !== undefined) {
      (state.plans[pid] ||= { log: [] }).log.push({ job: kind, ...s });
      saveState();
    }
    return s;
  };
  chain = chain.then(async () => {
    job.status = 'running';
    job.started = Date.now();
    try {
      await fn(step, job);
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.error = String(e.message || e);
      step(`Stopped: ${job.error}`, null, { ok: false });
    }
    job.finished = Date.now();
    job.ms = job.finished - job.started;
    fresh();
  });
  return { job };
}

function summariseFailure(fails) {
  const f = fails[fails.length - 1];
  const s = JSON.stringify(f.failure);
  const m = s.match(/"ExecutionError":"((?:[^"\\]|\\.)*)"/) || s.match(/"Smart contract panicked: ((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/^Smart contract panicked: /, '') : s.slice(0, 200);
}

// ------------------------------------------------------------- demo actions

async function refill(step) {
  for (const d of DEMO.daos) {
    const id = w.daos[d.key].id;
    const have = await balanceOf(w.rpc, w.token, id);
    const want = usd(d.treasury);
    if (have < want) step(`Treasury of ${d.name} topped back up to ${d.treasury} tUSD (test token)`, await call(A.ops, w.token, 'mint', { account_id: id, amount: String(want - have) }, { gas: teraToGas('30') }));
  }
  const donor = await balanceOf(w.rpc, w.token, A.donor.accountId);
  if (donor < usd(200)) step('Demo donor receives test tUSD', await call(A.ops, w.token, 'mint', { account_id: A.donor.accountId, amount: String(usd(DEMO.donor)) }, { gas: teraToGas('30') }));
}

async function preparePlan(step, job) {
  await refill(step);
  const title = "Builders' night";
  const lines = DEMO.lines.map((l) => ({ key: l.key, label: l.label, payee: A[l.payee].accountId, amount: String(usd(l.amount)) }));
  const r = await call(A.coordinator, w.lockstep, 'create_plan', { title, token: w.token, lines, open_for_sec: 7 * 24 * 3600 }, { deposit: nearToYocto('0.1'), gas: teraToGas('50') });
  if (r.fails.length) throw new Error('create_plan failed: ' + summariseFailure(r.fails));
  const planId = Number(r.value);
  job.planId = planId;
  state.plans[planId] = { title, created: new Date().toISOString(), log: [] };
  state.current = planId;
  saveState();
  step(`Coordinator proposes "${title}": venue 400, food 300, speaker travel 300`, r);
  for (const d of DEMO.daos) {
    const id = w.daos[d.key].id;
    const what = d.lines.map((k) => lineLabel[k].toLowerCase()).join(' or ');
    const p = await propose(A.alice, id, `Pledge up to ${d.cap} tUSD to Lockstep plan #${planId} (${title}), for ${what} only. No money moves unless the whole plan is funded.`, pledgeKind(w.lockstep, planId, usd(d.cap), d.lines), w.rpc);
    step(`${d.name}: a council member proposes a pledge of ${d.cap} for ${what} (proposal #${p.id})`, { hash: p.hash, fails: [] });
    const { proposal, txs } = await approve([A.alice, A.bob], id, p.id, w.rpc);
    for (const [i, t] of txs.entries()) step(`${d.name}: council member ${i + 1} of 2 votes yes`, t);
    if (proposal.status !== 'Approved') throw new Error(`${d.name} pledge vote ended ${proposal.status}`);
  }
}

async function topupAction(planId, amount, line, step) {
  const r = await topup(A.donor, w.token, w.lockstep, planId, usd(amount), [line]);
  step(`Donor tops up ${amount} tUSD for ${lineLabel[line] || line} (held in escrow until the plan settles)`, r);
  if (r.fails.length) throw new Error(summariseFailure(r.fails));
}

async function spendElsewhere(planId, daoKey, step) {
  // A rolled-back share leaves its proposal bond with the DAO (Sputnik returns bonds only
  // on success), so each failure demo costs the contract one bond. Keep a margin.
  const acct = await retryRead(() => w.rpc.query({ request_type: 'view_account', account_id: w.lockstep, finality: 'final' }));
  const spare = BigInt(acct.amount) - BigInt(acct.storage_usage) * 10n ** 19n;
  if (spare < 3n * 10n ** 24n) throw new Error('the demo contract is low on testnet NEAR for proposal bonds; the failure demo is paused until it is topped up');
  const d = w.daos[daoKey];
  const amount = 250;
  const p = await propose(A.alice, d.id, `Pay ${amount} tUSD for another event's hall deposit`, transferKind(w.token, A.landlord.accountId, usd(amount)), w.rpc);
  step(`${d.name}: council proposes to pay ${amount} for another event (proposal #${p.id})`, { hash: p.hash, fails: [] });
  const { proposal, txs } = await approve([A.alice, A.bob], d.id, p.id, w.rpc);
  for (const [i, t] of txs.entries()) step(`${d.name}: council member ${i + 1} of 2 votes yes`, t);
  step(`${d.name} paid ${amount} elsewhere: its treasury now holds ${Number(await balanceOf(w.rpc, w.token, d.id)) / 1e6} tUSD`, null);
  if (proposal.status !== 'Approved') throw new Error(`spend vote ended ${proposal.status}`);
}

async function activateAction(planId, step) {
  const plan = await getPlan(w.rpc, w.lockstep, planId);
  const a = analyse(plan);
  if (a.gap > 0n) throw new Error(`still ${Number(a.gap) / 1e6} tUSD short: activation would be refused`);
  const r = await call(A.coordinator, w.lockstep, 'activate', { plan_id: planId, allocation: allocationArgs(a.allocation) }, { gas: teraToGas('100') });
  step('Activate: the contract checks that every cost line is covered exactly, within each pledge\'s cap and permitted lines', r);
  if (r.fails.length) throw new Error(summariseFailure(r.fails));
}

async function collectAction(planId, step) {
  const t0 = Date.now();
  const log = await collectAll(A.coordinator, w.rpc, w.lockstep, planId);
  for (const l of log) {
    const label = l.step === 'collect'
      ? `Collect from ${daoName(l.funder)}: Lockstep reads the DAO policy, files a transfer proposal and approves it with its role`
      : `Ask ${daoName(l.funder)} how its transfer proposal ended`;
    step(label, l, { events: l.events.map((e) => e.event) });
  }
  const plan = await getPlan(w.rpc, w.lockstep, planId);
  step(plan.status === 'Settled' ? `Every share arrived: plan settled (${((Date.now() - t0) / 1000).toFixed(1)} s)` : plan.status === 'RolledBack' ? 'A share failed: plan rolled back, every token that arrived is owed back' : `Plan is ${plan.status}`, null);
}

async function disburseAction(planId, step) {
  for (let i = 0; i < 3; i++) {
    const plan = await getPlan(w.rpc, w.lockstep, planId);
    if (!plan.claims.some((c) => c.state === 'Pending')) break;
    const r = await disburse(A.coordinator, w.lockstep, planId);
    step(plan.status === 'Settled' ? 'Pay the payees (anyone may call disburse)' : 'Send the refunds (anyone may call disburse)', r);
  }
}

// --------------------------------------------------------------- read model

// Cache reads: public RPCs rate-limit, and many viewers may poll the same plan.
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const pending = fn().then(
    (value) => { cache.set(key, { at: Date.now(), value }); return value; },
    (e) => { cache.delete(key); throw e; },
  );
  cache.set(key, { pending });
  return pending;
}
const fresh = () => cache.clear();

async function planView(planId) {
  return cached('plan:' + planId, 4000, () => planViewUncached(planId));
}

async function planViewUncached(planId) {
  const plan = await getPlan(w.rpc, w.lockstep, planId);
  if (!plan) return null;
  const a = analyse(plan);
  const daos = await Promise.all(Object.values(w.daos).map(async (d) => {
    const [bal, policy] = await Promise.all([balanceOf(w.rpc, w.token, d.id), cached('policy:' + d.id, 120000, () => view(w.rpc, d.id, 'get_policy'))]);
    const role = policy.roles.find((r) => r.kind?.Group?.includes(w.lockstep));
    return { id: d.id, name: d.name, balance: bal, role: role ? role.permissions : null, bond: policy.proposal_bond };
  }));
  const proposals = {};
  for (const s of plan.shares) if (s.proposal_id !== null) proposals[s.funder] = (await view(w.rpc, s.funder, 'get_proposal', { id: s.proposal_id })).status;
  const payees = await Promise.all(plan.lines.map(async (l) => ({ id: l.payee, balance: await balanceOf(w.rpc, w.token, l.payee) })));
  return {
    plan, daos, proposals, payees,
    analysis: { required: a.required, funded: a.funded, gap: a.gap, pledged: a.pledged, shortByLine: a.shortByLine, completions: a.completions, certificateOk: a.certificateOk },
    log: state.plans[planId]?.log || [],
    escrowHeld: await balanceOf(w.rpc, w.token, w.lockstep),
  };
}

// ------------------------------------------------------------------- http

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 4096) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

function staticFile(res, urlPath) {
  const map = urlPath === '/' ? 'web/public/index.html' : urlPath.startsWith('/core/') ? urlPath.slice(1) : 'web/public' + urlPath;
  const file = normalize(join(ROOT, map));
  if (!file.startsWith(normalize(ROOT)) || !existsSync(file) || file.includes('.data')) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/world') {
      return json(res, 200, {
        network: NETWORK, explorer: w.explorer, lockstep: w.lockstep, token: w.token, factory: w.factory,
        daos: Object.values(w.daos), council: [w.accounts.alice.id, w.accounts.bob.id], coordinator: w.accounts.coordinator.id,
        donor: w.accounts.donor.id, readOnly: READ_ONLY, current: state.current, plans: Object.entries(state.plans).map(([id, v]) => ({ id: Number(id), title: v.title })),
        demo: DEMO,
      });
    }
    if (req.method === 'GET' && p.startsWith('/api/plan/')) {
      const v = await planView(Number(p.split('/')[3]));
      return v ? json(res, 200, v) : json(res, 404, { error: 'no such plan' });
    }
    if (req.method === 'GET' && p.startsWith('/api/job/')) {
      const j = jobs.get(p.split('/')[3]);
      return j ? json(res, 200, j) : json(res, 404, { error: 'no such job' });
    }
    if (req.method === 'POST' && READ_ONLY) return json(res, 503, { error: READ_ONLY_ERROR });
    if (req.method === 'POST' && p === '/api/plans') {
      const r = startJob('prepare', null, preparePlan);
      return r.error ? json(res, r.status, r) : json(res, 202, { job: r.job.id });
    }
    const m = p.match(/^\/api\/plan\/(\d+)\/(topup|spend|activate|collect|disburse)$/);
    if (req.method === 'POST' && m) {
      const planId = Number(m[1]);
      const b = await body(req);
      const fns = {
        topup: (step) => {
          const amount = Number(b.amount);
          if (!(amount > 0 && amount <= 500)) throw new Error('amount must be between 0 and 500');
          if (!DEMO.lines.some((l) => l.key === b.line)) throw new Error('unknown line');
          return topupAction(planId, amount, b.line, step);
        },
        spend: (step) => {
          if (!w.daos[b.dao]) throw new Error('unknown DAO');
          return spendElsewhere(planId, b.dao, step);
        },
        activate: (step) => activateAction(planId, step),
        collect: (step) => collectAction(planId, step),
        disburse: (step) => disburseAction(planId, step),
      };
      const r = startJob(m[2], planId, fns[m[2]]);
      return r.error ? json(res, r.status, r) : json(res, 202, { job: r.job.id });
    }
    if (req.method === 'GET') return staticFile(res, p);
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`Lockstep demo on http://127.0.0.1:${PORT} (${NETWORK}, contract ${w.lockstep}${READ_ONLY ? ', read-only' : ''})`));
export { sleep };
