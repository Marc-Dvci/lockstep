// Domain helpers: Sputnik DAO proposals, Lockstep plans, and the funding-gap engine
// wired together. Used by the sandbox tests, the testnet seed script and the demo server.
import { solve, completions, verifyCertificate } from '../../core/gap.js';
import { call, view, b64json, teraToGas, nearToYocto, sleep } from './near.js';

export const ONE_YOCTO = 1n;

// ------------------------------------------------------------------ Sputnik

/**
 * The role a council installs by vote. Lockstep may only approve transfer proposals: it cannot file one, and its
 * code approves only the transfer proposal the DAO itself filed as its pledge.
 */
export function lockstepRoleKind(lockstepId, name = 'lockstep') {
  return {
    ChangePolicyAddOrUpdateRole: {
      role: {
        name,
        kind: { Group: [lockstepId] },
        permissions: ['transfer:VoteApprove'],
        vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } },
      },
    },
  };
}

/** The transfer proposal that is a DAO's pledge: the DAO pays Lockstep its cap, with the plan and lines in msg. */
export function pledgeTransferKind(tokenId, lockstepId, planId, cap, lines) {
  return { Transfer: { token_id: tokenId, receiver_id: lockstepId, amount: String(cap), msg: JSON.stringify({ pledge: { plan_id: planId, lines } }) } };
}

/**
 * What a council votes to pledge: a FunctionCall on the DAO itself that files the pledge transfer proposal, with
 * the DAO's own proposal bond. The DAO is then the proposer, and the bond goes back to the DAO.
 */
export function pledgeKind(daoId, tokenId, lockstepId, planId, cap, lines, bond, description) {
  return {
    FunctionCall: {
      receiver_id: daoId,
      actions: [{
        method_name: 'add_proposal',
        args: b64json({ proposal: { description, kind: pledgeTransferKind(tokenId, lockstepId, planId, cap, lines) } }),
        deposit: String(bond),
        gas: String(teraToGas('30')),
      }],
    },
  };
}

/** The DAO's own pledge proposal for `planId` filed after proposal id `after`, or null. */
export async function findPledgeProposal(rpc, daoId, lockstepId, planId, after) {
  const last = Number(await view(rpc, daoId, 'get_last_proposal_id'));
  for (let id = last - 1; id > after; id--) {
    const q = await view(rpc, daoId, 'get_proposal', { id });
    const t = q.kind?.Transfer;
    if (q.proposer === daoId && t && t.receiver_id === lockstepId && JSON.parse(t.msg || '{}').pledge?.plan_id === planId) return id;
  }
  return null;
}

/**
 * A council pledges: one member proposes, the council votes, and the DAO files its own transfer proposal to
 * Lockstep. Returns the vote's proposal, its transactions and the id of the DAO's pledge proposal.
 */
export async function pledgeByVote(proposer, voters, daoId, { tokenId, lockstepId, planId, cap, lines, description, pledgeDescription }, rpc) {
  const policy = await view(rpc, daoId, 'get_policy');
  const kind = pledgeKind(daoId, tokenId, lockstepId, planId, cap, lines, policy.proposal_bond, pledgeDescription || description);
  const p = await propose(proposer, daoId, description, kind, rpc);
  const { proposal, txs } = await approve(voters, daoId, p.id, rpc);
  const pledgeId = proposal.status === 'Approved' ? await findPledgeProposal(rpc, daoId, lockstepId, planId, p.id) : null;
  return { voteId: p.id, voteHash: p.hash, proposal, txs, pledgeId };
}

/** Anyone may register a DAO's pledge proposal with Lockstep, which reads it back from the DAO. */
export async function registerPledge(caller, lockstepId, planId, daoId, proposalId) {
  return call(caller, lockstepId, 'register_pledge', { plan_id: planId, dao: daoId, proposal_id: proposalId }, { gas: teraToGas('100') });
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
 * Approve every waiting share's pledge proposal, then ask the DAO about any share whose transfer did not arrive.
 * Returns the transactions in order, labelled.
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
