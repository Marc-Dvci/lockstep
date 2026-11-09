// Check Lockstep deployments from public chain data only. No keys, no wallet.
//   node scripts/verify.js            (testnet: Lockstep 2 in deployments/testnet.json, then version 1 in testnet-v1.json)
//   node scripts/verify.js sandbox    (local sandbox, deployments/sandbox.json)
//   node scripts/verify.js testnet-v1 (one deployment)
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { provider, view, baseEncode } from './lib/verify-deps.js';
import { solve, verifyCertificate } from '../core/gap.js';

const arg = process.argv[2] || 'testnet';
const names = arg === 'testnet' ? ['testnet', 'testnet-v1'] : [arg];
let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); return cond; };
const info = (msg) => console.log(`      ${msg}`);
const big = (x) => BigInt(x);
const fmt = (x) => (Number(big(x)) / 1e6).toLocaleString('en-US');
const msgOf = (t) => { try { return JSON.parse(t?.msg || '{}'); } catch { return {}; } };

async function verify(name) {
  const dep = JSON.parse(readFileSync(fileURLToPath(new URL(`../deployments/${name}.json`, import.meta.url)), 'utf8'));
  const version = dep.version || 1;
  const rpc = provider(process.env.RPC || dep.rpc);
  const query = (params) => rpc.query({ finality: 'final', ...params });
  console.log(`\nLockstep ${version === 2 ? '2' : '1 (as filmed)'} on ${dep.network}: ${dep.lockstep} (${dep.rpc})\n`);

  // 1. The contract itself
  const acct = await query({ request_type: 'view_account', account_id: dep.lockstep });
  const keys = await query({ request_type: 'view_access_key_list', account_id: dep.lockstep });
  if (dep.network === 'testnet') ok(keys.keys.length === 0, `${dep.lockstep} has no access keys: nobody can redeploy or sign for it (${keys.keys.length} keys)`);
  else info(`${dep.lockstep} has ${keys.keys.length} access key(s) (sandbox: keys are kept)`);
  info(`code hash ${acct.code_hash}`);
  const local = fileURLToPath(new URL('../target/near/lockstep/lockstep.wasm', import.meta.url));
  if (version === 2 && existsSync(local)) {
    const h = baseEncode(createHash('sha256').update(readFileSync(local)).digest());
    info(`local build target/near/lockstep/lockstep.wasm hashes to ${h}${h === acct.code_hash ? ' (matches)' : ' (differs from the deployed code; rebuild from the deployed commit to compare)'}`);
  }
  if (dep.code_hash) ok(acct.code_hash === dep.code_hash, `deployed code is the recorded build ${dep.code_hash}${dep.source ? ` (${dep.source})` : ''}`);
  try {
    const meta = await view(rpc, dep.lockstep, 'contract_source_metadata');
    ok(!!meta && (meta.link || meta.version), `NEP-330 source metadata published: ${JSON.stringify({ version: meta.version, link: meta.link, standards: meta.standards?.map((s) => `${s.standard} ${s.version}`) })}`);
  } catch {
    ok(false, 'NEP-330 contract_source_metadata view');
  }
  const cfg = await view(rpc, dep.lockstep, 'get_config');
  ok(cfg.tokens.length === 1 && cfg.tokens[0] === dep.token, `accepts one token only: ${cfg.tokens.join(', ')}`);
  ok(cfg.dao_factories.includes(dep.factory), `pledges accepted only from DAOs created by ${cfg.dao_factories.join(', ')}`);

  // 2. Each DAO's Lockstep role
  for (const d of dep.daos) {
    const policy = await view(rpc, d.id, 'get_policy');
    const roles = policy.roles.filter((r) => r.kind?.Group?.includes(dep.lockstep));
    const perms = roles.flatMap((r) => r.permissions);
    const oneMember = roles.length === 1 && roles[0].kind.Group.length === 1;
    if (version === 2) {
      ok(oneMember && perms.length === 1 && perms[0] === 'transfer:VoteApprove', `${d.name} (${d.id}): Lockstep's role is a one-member group that may only approve transfers (${perms.join(', ') || 'no role'}); it cannot file a proposal`);
    } else {
      ok(oneMember && perms.every((p) => p.startsWith('transfer:')) && perms.includes('transfer:AddProposal') && perms.includes('transfer:VoteApprove'),
        `${d.name} (${d.id}): Lockstep role is a one-member group limited to ${perms.join(', ') || 'nothing'}`);
    }
  }

  // 3. Every plan
  const plans = [];
  for (let from = 0; ; from += 50) {
    const page = await view(rpc, dep.lockstep, 'get_plans', { from_index: from, limit: 50 });
    plans.push(...page);
    if (page.length < 50) break;
  }
  console.log(`\n${plans.length} plan(s)\n`);
  let escrowTotal = 0n;
  const shareProposals = new Map(); // dao -> ids of proposals that are shares of a plan this DAO pledged to
  const openCaps = new Map(); // dao -> tUSD Lockstep may still approve from it (open pledges)
  for (const plan of plans) {
    const tag = `plan #${plan.id} "${plan.title}" [${plan.status}]`;
    const lines = plan.lines.map((l) => ({ key: l.key, amount: big(l.amount) }));
    const required = lines.reduce((a, l) => a + l.amount, 0n);
    escrowTotal += big(plan.escrow);
    for (const s of plan.shares) {
      if (s.proposal_id === null) continue;
      if (!shareProposals.has(s.funder)) shareProposals.set(s.funder, new Set());
      shareProposals.get(s.funder).add(s.proposal_id);
    }
    if (plan.status === 'Open' || plan.status === 'Expired') {
      if (plan.status === 'Open') for (const p of plan.pledges) openCaps.set(p.funder, (openCaps.get(p.funder) || 0n) + big(p.cap));
      const sources = [
        ...plan.pledges.map((p) => ({ id: 'pledge:' + p.funder, cap: big(p.cap), lines: p.lines })),
        ...plan.topups.map((t) => ({ id: 'topup:' + t.id, cap: big(t.amount), lines: t.lines })),
      ];
      const r = solve(lines, sources);
      const v = verifyCertificate(lines, sources, r.allocation, r.certificate);
      ok(v.ok, `${tag}: most the pledges can legally cover is ${fmt(r.funded)} of ${fmt(required)} (cut certificate ${fmt(v.cut)}), gap ${fmt(r.gap)}`);
      if (version === 2 && plan.status === 'Open') {
        for (const p of plan.pledges) {
          const q = await view(rpc, p.funder, 'get_proposal', { id: p.proposal_id });
          const t = q.kind.Transfer;
          ok(q.proposer === p.funder && t && t.receiver_id === dep.lockstep && t.token_id === dep.token && t.amount === p.cap && msgOf(t).pledge?.plan_id === plan.id,
            `${tag}: ${p.funder} pledge is its own proposal #${p.proposal_id}, filed by the DAO, moving ${fmt(p.cap)} to Lockstep for this plan (${q.status})`);
        }
      }
    } else {
      // allocation exactly covers every line within caps and permitted lines
      const perLine = {}, perSource = {};
      let legal = true;
      for (const a of plan.allocation) {
        perLine[a.line] = (perLine[a.line] || 0n) + big(a.amount);
        perSource[a.source] = (perSource[a.source] || 0n) + big(a.amount);
        const src = a.source.startsWith('pledge:') ? plan.pledges.find((p) => 'pledge:' + p.funder === a.source) : plan.topups.find((t) => 'topup:' + t.id === a.source);
        if (!src || !src.lines.includes(a.line)) legal = false;
        if (src && perSource[a.source] > big(src.cap ?? src.amount)) legal = false;
      }
      ok(legal && lines.every((l) => perLine[l.key] === l.amount), `${tag}: accepted allocation covers each line exactly within caps and permitted lines`);
      // every share against the DAO's own proposal
      for (const s of plan.shares) {
        if (s.proposal_id === null) { info(`${tag}: ${s.funder} share ${s.state}, no proposal filed${s.note ? ` (${s.note})` : ''}`); continue; }
        const p = await view(rpc, s.funder, 'get_proposal', { id: s.proposal_id });
        const t = p.kind.Transfer;
        const agree = (s.state === 'Arrived' && p.status === 'Approved') || (s.state === 'Failed' && ['Failed', 'Rejected', 'Removed', 'Expired', 'InProgress'].includes(p.status));
        if (version === 2) {
          const shape = p.proposer === s.funder && t && t.receiver_id === dep.lockstep && t.token_id === dep.token && t.amount === s.pledged && msgOf(t).pledge?.plan_id === plan.id;
          ok(shape && agree, `${tag}: ${s.funder} share ${fmt(s.amount)} of its own proposal #${s.proposal_id} (filed by the DAO, ${fmt(s.pledged)} to Lockstep for this plan); DAO says ${p.status}, Lockstep says ${s.state}`);
        } else {
          const shape = p.proposer === dep.lockstep && t && t.receiver_id === dep.lockstep && t.token_id === dep.token && t.amount === s.amount && msgOf(t).share?.plan_id === plan.id;
          ok(shape && agree, `${tag}: ${s.funder} proposal #${s.proposal_id} transfers ${fmt(s.amount)} to Lockstep for this plan; DAO says ${p.status}, Lockstep says ${s.state}`);
        }
      }
      if (plan.status === 'Settled' || plan.status === 'RolledBack') {
        const inflow = plan.shares.filter((s) => s.state === 'Arrived').reduce((a, s) => a + big(s.amount), 0n) + plan.topups.reduce((a, t) => a + big(t.amount), 0n);
        const owed = plan.claims.reduce((a, c) => a + big(c.amount), 0n);
        ok(inflow === owed, `${tag}: everything that arrived (${fmt(inflow)}) is owed out (${fmt(owed)})`);
        if (plan.status === 'Settled') {
          const payouts = plan.claims.filter((c) => c.kind === 'Payout');
          const want = {};
          for (const l of plan.lines) want[l.payee] = (want[l.payee] || 0n) + big(l.amount);
          ok(Object.entries(want).every(([to, amt]) => payouts.some((c) => c.to === to && big(c.amount) === amt)), `${tag}: each payee is owed exactly its lines`);
        } else {
          ok(plan.claims.every((c) => c.kind === 'Refund'), `${tag}: only refunds, no payouts`);
        }
        const unpaid = plan.claims.filter((c) => c.state !== 'Paid').reduce((a, c) => a + big(c.amount), 0n);
        ok(big(plan.escrow) === unpaid, `${tag}: escrow ${fmt(plan.escrow)} equals unpaid claims ${fmt(unpaid)}; ${plan.claims.filter((c) => c.state === 'Paid').length}/${plan.claims.length} claims paid`);
      }
    }
  }

  // 4. Everything Lockstep ever did on each DAO, read from the DAO's side
  console.log('');
  for (const d of dep.daos) {
    const all = [];
    for (let from = 0; ; from += 100) {
      const page = await view(rpc, d.id, 'get_proposals', { from_index: from, limit: 100 });
      all.push(...page);
      if (page.length < 100) break;
    }
    const filed = all.filter((p) => p.proposer === dep.lockstep);
    const voted = all.filter((p) => p.votes && dep.lockstep in p.votes);
    const known = shareProposals.get(d.id) || new Set();
    const touched = [...new Set([...filed, ...voted].map((p) => p.id))];
    const stray = touched.filter((id) => !known.has(id));
    if (version === 2) {
      ok(filed.length === 0 && stray.length === 0, `${d.name}: of its ${all.length} proposals, Lockstep filed none and approved ${voted.length}, each a share of a plan this DAO pledged to${stray.length ? `; not a share: #${stray.join(', #')}` : ''}`);
      info(`${d.name}: open pledges let Lockstep approve at most ${fmt(openCaps.get(d.id) || 0n)} tUSD from it now`);
    } else {
      ok(stray.length === 0, `${d.name}: of its ${all.length} proposals, Lockstep filed ${filed.length} and voted on ${voted.length}, each a share of a plan this DAO pledged to${stray.length ? `; not a share: #${stray.join(', #')}` : ''}`);
    }
  }

  // 5. Solvency: the contract holds at least what it owes
  const held = big(await view(rpc, dep.token, 'ft_balance_of', { account_id: dep.lockstep }));
  ok(held >= escrowTotal, `Lockstep holds ${fmt(held)} tUSD and owes ${fmt(escrowTotal)} across all plans`);
}

for (const n of names) await verify(n);
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
