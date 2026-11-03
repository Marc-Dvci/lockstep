// Domain helpers: Sputnik DAO proposals, Lockstep plans, and the funding-gap engine
// wired together. Used by the sandbox tests, the testnet seed script and the demo server.
import { solve, completions, verifyCertificate } from '../../core/gap.js';
import { call, view, b64json, teraToGas, nearToYocto, sleep } from './near.js';

export const ONE_YOCTO = 1n;

// ------------------------------------------------------------------ Sputnik

export function lockstepRoleKind(lockstepId) {
  return {
    ChangePolicyAddOrUpdateRole: {
      role: {
        name: 'lockstep',
        kind: { Group: [lockstepId] },
        permissions: ['transfer:AddProposal', 'transfer:VoteApprove'],
        vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } },
      },
    },
  };
}

export function pledgeKind(lockstepId, planId, cap, lines) {
  return {
    FunctionCall: {
      receiver_id: lockstepId,
      actions: [{ method_name: 'pledge', args: b64json({ plan_id: planId, cap: String(cap), lines }), deposit: '0', gas: String(teraToGas('50')) }],
    },
  };
}

export function transferKind(tokenId, receiverId, amount) {
  return { Transfer: { token_id: tokenId, receiver_id: receiverId, amount: String(amount), msg: null } };
}

/** File a proposal as `proposer` (attaching the DAO's bond) and return its id. */
export async function propose(proposer, daoId, description, kind, rpc) {
  const policy = await view(rpc, daoId, 'get_policy');
  const r = await call(proposer, daoId, 'add_proposal', { proposal: { description, kind } }, { deposit: BigInt(policy.proposal_bond), gas: teraToGas('50') });
  if (r.fails.length) throw new Error(`add_proposal failed: ${JSON.stringify(r.fails[0].failure)}`);
  return { id: Number(r.value), hash: r.hash };
}

/** Approve proposal `id` as each voter in turn; returns the vote transactions. */
export async function approve(voters, daoId, id, rpc) {
  const p = await view(rpc, daoId, 'get_proposal', { id });
  const txs = [];
  for (const v of voters) {
    const cur = await view(rpc, daoId, 'get_proposal', { id });
    if (cur.status !== 'InProgress') break;
    const r = await call(v, daoId, 'act_proposal', { id, action: 'VoteApprove', proposal: p.kind }, { gas: teraToGas('200') });
    txs.push(r);
  }
  return { proposal: await view(rpc, daoId, 'get_proposal', { id }), txs };
}

// ----------------------------------------------------------------- Lockstep

/** Convert an on-chain plan into the gap engine's lines and sources. */
export function planGraph(plan, nowNs = BigInt(Date.now()) * 1_000_000n) {
  const lines = plan.lines.map((l) => ({ key: l.key, amount: BigInt(l.amount) }));
  const sources = [
    ...plan.pledges.filter((p) => BigInt(p.expires_at) > nowNs).map((p) => ({ id: 'pledge:' + p.funder, cap: BigInt(p.cap), lines: p.lines })),
    ...plan.topups.map((t) => ({ id: 'topup:' + t.id, cap: BigInt(t.amount), lines: t.lines })),
  ];
  return { lines, sources };
}

export function analyse(plan, nowNs) {
  const { lines, sources } = planGraph(plan, nowNs);
  const r = solve(lines, sources);
  const c = completions(lines, sources);
  const v = verifyCertificate(lines, sources, r.allocation, r.certificate);
  return { ...r, completions: c, certificateOk: v.ok, pledged: sources.filter((s) => s.id.startsWith('pledge:')).reduce((a, s) => a + s.cap, 0n) };
}

export function allocationArgs(allocation) {
  return allocation.map((a) => ({ source: a.source, line: a.line, amount: String(a.amount) }));
}

export async function getPlan(rpc, lockstepId, planId) {
  return view(rpc, lockstepId, 'get_plan', { plan_id: planId });
}

export async function topup(donor, tokenId, lockstepId, planId, amount, lines) {
  return call(donor, tokenId, 'ft_transfer_call', {
    receiver_id: lockstepId,
    amount: String(amount),
    msg: JSON.stringify({ topup: { plan_id: planId, lines } }),
  }, { deposit: ONE_YOCTO, gas: teraToGas('100') });
}

/**
 * Pull every waiting share, then ask the DAO about any share whose transfer did not
 * arrive. Returns the transactions in order, labelled.
 */
export async function collectAll(caller, rpc, lockstepId, planId) {
  const log = [];
  let plan = await getPlan(rpc, lockstepId, planId);
  for (const s of plan.shares) {
    plan = await getPlan(rpc, lockstepId, planId);
    const cur = plan.shares.find((x) => x.funder === s.funder);
    if (plan.status !== 'Collecting' || cur.state !== 'Waiting') continue;
    const r = await call(caller, lockstepId, 'collect', { plan_id: planId, funder: s.funder }, { gas: teraToGas('300') });
    log.push({ step: 'collect', funder: s.funder, ...r });
  }
  for (let round = 0; round < 3; round++) {
    plan = await getPlan(rpc, lockstepId, planId);
    const pending = plan.status === 'Collecting' ? plan.shares.filter((s) => s.state === 'Requested' && s.proposal_id !== null) : [];
    if (!pending.length) break;
    for (const s of pending) {
      const r = await call(caller, lockstepId, 'check_share', { plan_id: planId, funder: s.funder }, { gas: teraToGas('100') });
      log.push({ step: 'check_share', funder: s.funder, ...r });
    }
    await sleep(1000);
  }
  return log;
}

export async function disburse(caller, lockstepId, planId) {
  return call(caller, lockstepId, 'disburse', { plan_id: planId }, { gas: teraToGas('300') });
}

export { nearToYocto, teraToGas };
