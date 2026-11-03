import { solve, verifyCertificate, previewTopup, completions } from '/core/gap.js';

const $ = (id) => document.getElementById(id);
const UNIT = 1_000_000n;
const fmt = (v) => {
  const b = BigInt(v);
  const whole = b / UNIT, frac = b % UNIT;
  const s = whole.toLocaleString('en-US');
  return frac ? `${s}.${String(frac).padStart(6, '0').replace(/0+$/, '')}` : s;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (id) => (id.length > 28 ? id.split('.')[0] : id);

let world = null;
let planId = null;
let view = null;
let job = null;

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function graph(plan) {
  const now = BigInt(Date.now()) * 1_000_000n;
  return {
    lines: plan.lines.map((l) => ({ key: l.key, amount: BigInt(l.amount) })),
    sources: [
      ...plan.pledges.filter((p) => BigInt(p.expires_at) > now).map((p) => ({ id: 'pledge:' + p.funder, cap: BigInt(p.cap), lines: p.lines })),
      ...plan.topups.map((t) => ({ id: 'topup:' + t.id, cap: BigInt(t.amount), lines: t.lines })),
    ],
  };
}

function sourceStyle(id) {
  if (id.startsWith('topup:')) return { color: 'var(--s3)', name: 'Donor top-up' };
  const funder = id.slice('pledge:'.length);
  const i = world.daos.findIndex((d) => d.id === funder);
  return { color: `var(--s${Math.max(0, i) % 3})`, name: world.daos[i]?.name || funder };
}
const labelOf = (plan, key) => plan.lines.find((l) => l.key === key)?.label || key;

// --------------------------------------------------------------------- render

function render() {
  const { plan, analysis, daos } = view;
  const g = graph(plan);
  const live = solve(g.lines, g.sources);
  const allocation = plan.status === 'Open' ? live.allocation.map((a) => ({ ...a, amount: BigInt(a.amount) })) : plan.allocation.map((a) => ({ source: a.source, line: a.line, amount: BigInt(a.amount) }));
  const pledged = g.sources.filter((s) => s.id.startsWith('pledge:')).reduce((a, s) => a + s.cap, 0n);
  const required = live.required;
  const gap = live.gap;

  // headline
  const pill = $('statusPill');
  const failed = plan.shares.find((s) => s.state === 'Failed' && s.note && !s.note.startsWith('not collected'));
  const paid = plan.claims.length && plan.claims.every((c) => c.state === 'Paid');
  const H = {
    Open: gap > 0n
      ? [`Open · ${plan.pledges.length} pledges`, '', `${fmt(pledged)} tUSD pledged for a ${fmt(required)} plan, and still ${fmt(gap)} short.`, shortExplanation(plan, g, live)]
      : ['Open · fully covered', 'go', 'Fully covered on paper. Ready to activate.', 'No money has moved yet: pledges are still in each DAO treasury and top-ups are held in escrow.'],
    Collecting: ['Collecting', 'go', 'Collecting each DAO\'s share…', 'Each share arrives through an ordinary transfer proposal on the DAO itself.'],
    Settled: ['Settled', 'ok', paid ? 'Funded and paid. Every line of the plan.' : 'Every share arrived. The plan is settled.', paid ? 'Each DAO paid exactly its share through its own transfer proposal, and each payee received its line.' : 'Payout claims are assigned to the payees. Step 3 sends them.'],
    RolledBack: ['Rolled back', 'bad', 'Rolled back. Nobody paid for part of a plan.', failed ? `${failed.note.replace(/^the DAO's/, sourceStyle('pledge:' + failed.funder).name + "'s").replace(/^the DAO/, sourceStyle('pledge:' + failed.funder).name).replace(/^./, (c) => c.toUpperCase())}. ${paid ? 'Every token that had arrived went back where it came from.' : 'Every token that arrived is owed back. Step 3 sends the refunds.'}` : 'A share could not be collected.'],
    Expired: ['Expired', 'bad', 'This plan expired before activation.', 'Top-ups are owed back to their donors.'],
  }[plan.status];
  pill.textContent = `Plan #${plan.id} · ${H[0]}`;
  pill.className = 'status ' + H[1];
  $('headline').textContent = H[2];
  $('subline').textContent = H[3];

  // cost lines
  const byLine = {};
  for (const a of allocation) (byLine[a.line] ||= []).push(a);
  $('lines').innerHTML = plan.lines.map((l) => {
    const amt = BigInt(l.amount);
    const segs = (byLine[l.key] || []).map((a) => {
      const st = sourceStyle(a.source);
      const pct = Number((a.amount * 10000n) / amt) / 100;
      return `<div class="seg" style="width:${pct}%;background:${st.color}" title="${esc(st.name)}: ${fmt(a.amount)}">${pct > 12 ? fmt(a.amount) : ''}</div>`;
    }).join('');
    const covered = (byLine[l.key] || []).reduce((s, a) => s + a.amount, 0n);
    const missing = amt - covered;
    const gapSeg = missing > 0n ? `<div class="seg gap" style="width:${Number((missing * 10000n) / amt) / 100}%">${fmt(missing)} short</div>` : '';
    return `<div class="line"><div class="name">${esc(l.label)}<small>pays ${esc(short(l.payee))}</small></div><div class="track">${segs}${gapSeg}</div><div class="amt">${fmt(amt)}${missing > 0n ? `<small style="color:var(--gap)">−${fmt(missing)}</small>` : ''}</div></div>`;
  }).join('');
  $('linesNote').textContent = plan.status === 'Open'
    ? 'Bars show the best possible use of the pledges, computed in this browser. A pledge may only pay for the lines its DAO voted for.'
    : 'Bars show the allocation the contract accepted at activation.';
  const used = [...new Set(allocation.map((a) => a.source))];
  $('legend').innerHTML = [...world.daos.map((d) => 'pledge:' + d.id), ...used.filter((s) => s.startsWith('topup:')).slice(0, 1)]
    .map((s) => sourceStyle(s)).map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') + (gap > 0n && plan.status === 'Open' ? '<span><i style="background:var(--gap)"></i>Missing</span>' : '');

  // DAOs
  $('daos').innerHTML = world.daos.map((d, i) => {
    const p = plan.pledges.find((x) => x.funder === d.id);
    const s = plan.shares.find((x) => x.funder === d.id);
    const live = daos.find((x) => x.id === d.id);
    const prop = view.proposals[d.id];
    const state = s ? s.state : p ? 'Pledged' : 'No pledge';
    const stateLabel = { Waiting: 'Share allocated', Requested: 'Transfer proposed', Arrived: 'Share arrived', Failed: 'Share failed', Pledged: 'Pledged', 'No pledge': 'No pledge' }[state];
    return `<li><span class="sw" style="background:var(--s${i % 3})"></span>
      <span class="who">${esc(d.name)}</span><span class="state ${state}">${stateLabel}</span>
      <span class="what">${p ? `Up to <b>${fmt(p.cap)}</b> for ${p.lines.map((k) => `<span class="chip">${esc(labelOf(plan, k))}</span>`).join('')}` : 'Has not pledged to this plan.'}${s ? ` · share <b>${fmt(s.amount)}</b>` : ''}</span>
      <span class="meta">Treasury now ${fmt(live.balance)} tUSD · Lockstep role ${live.role ? 'installed' : 'missing'}${prop ? ` · its proposal #${s.proposal_id} is ${prop}` : ''} · <span class="mono">${esc(d.id)}</span></span></li>`;
  }).join('');

  // complete it
  const open = plan.status === 'Open';
  $('completeSec').style.display = open ? '' : 'none';
  if (open) {
    const c = completions(g.lines, g.sources);
    if (gap === 0n) {
      $('answer').innerHTML = 'Nothing is missing. Activate the plan, or add a top-up anyway.';
    } else {
      const fits = Object.entries(c.byLine).filter(([, v]) => v !== null);
      const nots = Object.entries(c.byLine).filter(([, v]) => v === null);
      $('answer').innerHTML = (fits.length
        ? fits.map(([k, v]) => `<b>${fmt(v)} tUSD for ${esc(labelOf(plan, k))}</b> completes it.`).join(' ')
        : `<b>${fmt(c.anyLine)} tUSD</b> spread across lines completes it.`)
        + (nots.length ? ` The same amount for ${nots.map(([k]) => esc(labelOf(plan, k).toLowerCase())).join(' or ')} would not.` : '');
      $('completeNote').textContent = `Minimum unrestricted top-up: ${fmt(c.anyLine)} tUSD, the difference between the plan (${fmt(required)}) and the most the pledges can legally cover (${fmt(live.funded)}).`;
    }
    const sel = $('line');
    if (!sel.options.length) {
      sel.innerHTML = plan.lines.map((l) => `<option value="${l.key}">${esc(l.label)}</option>`).join('');
      const best = Object.entries(c.byLine).find(([, v]) => v !== null);
      if (best) { sel.value = best[0]; $('amt').value = Number(best[1] / UNIT) || 50; }
    }
    updatePreview();
    const community = daos.find((x) => x.id === world.daos[2]?.id);
    $('spendBox').style.display = community && BigInt(community.balance) >= 250n * UNIT ? '' : 'none';
  }

  // steps
  const busy = !!job;
  $('activateBtn').disabled = busy || !(open && gap === 0n);
  $('collectBtn').disabled = busy || plan.status !== 'Collecting';
  $('payBtn').disabled = busy || !(['Settled', 'RolledBack', 'Expired'].includes(plan.status) && plan.claims.some((c) => c.state === 'Pending'));
  $('st-activate').className = plan.status !== 'Open' ? 'done' : '';
  $('st-collect').className = ['Settled', 'RolledBack'].includes(plan.status) ? 'done' : '';
  $('st-pay').className = paid ? 'done' : '';
  $('topupBtn').disabled = busy || !open;
  $('spendBtn').disabled = busy || !open;
  $('newPlan').disabled = busy;

  $('outcome').innerHTML = plan.claims.length
    ? `<h2>${plan.status === 'Settled' ? 'Payouts' : 'Refunds'}</h2><ul class="claims">${plan.claims.map((c) => `<li><span>${c.kind === 'Payout' ? 'Pay' : 'Refund'} <b>${fmt(c.amount)} tUSD</b> to ${esc(nameOf(c.to))}</span><span class="${c.state}">${{ Paid: 'Paid', Pending: 'Owed', InFlight: 'Sending' }[c.state]}</span></li>`).join('')}</ul>`
    : '';

  renderChecks(plan, g, live);
  renderLog();
}

function nameOf(id) {
  const d = world.daos.find((x) => x.id === id);
  if (d) return d.name;
  if (id === world.donor) return 'the donor';
  return short(id);
}

function shortExplanation(plan, g, live) {
  const parts = [];
  for (const [k, miss] of Object.entries(live.shortByLine)) {
    if (miss <= 0n) continue;
    const allowed = g.sources.filter((s) => s.lines.includes(k));
    const label = labelOf(plan, k);
    if (!allowed.length) parts.push(`Nobody pledged to ${label.toLowerCase()}.`);
    else if (allowed.length === 1) parts.push(`Only ${sourceStyle(allowed[0].id).name} may pay for ${label.toLowerCase()}, and it pledged ${fmt(allowed[0].cap)} of the ${fmt(g.lines.find((l) => l.key === k).amount)}.`);
    else parts.push(`${allowed.map((s) => sourceStyle(s.id).name).join(' and ')} may pay for ${label.toLowerCase()}, and their pledges are used elsewhere.`);
  }
  return parts.join(' ') + ' Pledges for other lines cannot be moved.';
}

function updatePreview() {
  if (!view || view.plan.status !== 'Open') return;
  const g = graph(view.plan);
  const amt = Number($('amt').value);
  const el = $('preview');
  if (!(amt > 0)) { el.textContent = ''; return; }
  const p = previewTopup(g.lines, g.sources, BigInt(Math.round(amt * 1e6)), [$('line').value]);
  if (p.gapBefore === 0n) { el.textContent = 'The plan is already covered; the unused part of a top-up is returned at settlement.'; el.className = 'preview'; return; }
  el.textContent = p.completes
    ? `This completes the plan.${p.used < BigInt(Math.round(amt * 1e6)) ? ` ${fmt(BigInt(Math.round(amt * 1e6)) - p.used)} of it would be returned at settlement.` : ''}`
    : p.used === 0n ? 'This would not help: that line is already covered.' : `Still ${fmt(p.gapAfter)} short after this.`;
  el.className = 'preview ' + (p.completes ? 'ok' : 'bad');
}

function renderChecks(plan, g, live) {
  const items = [];
  const v = verifyCertificate(g.lines, g.sources, live.allocation, live.certificate);
  if (plan.status === 'Open') {
    items.push([v.ok ? 'pass' : 'fail', `Most the current pledges and top-ups can legally cover: ${fmt(live.funded)} of ${fmt(live.required)} tUSD. Proof: a cut of capacity ${fmt(v.cut)} separates them from the plan, so no allocation can do better.`]);
  }
  if (plan.status !== 'Open') {
    const lineSum = {}, srcSum = {};
    let ok = true;
    for (const a of plan.allocation) {
      lineSum[a.line] = (lineSum[a.line] || 0n) + BigInt(a.amount);
      srcSum[a.source] = (srcSum[a.source] || 0n) + BigInt(a.amount);
      const src = a.source.startsWith('pledge:') ? plan.pledges.find((p) => 'pledge:' + p.funder === a.source) : plan.topups.find((t) => 'topup:' + t.id === a.source);
      if (!src || !src.lines.includes(a.line)) ok = false;
    }
    for (const l of plan.lines) if (lineSum[l.key] !== BigInt(l.amount)) ok = false;
    for (const p of plan.pledges) if ((srcSum['pledge:' + p.funder] || 0n) > BigInt(p.cap)) ok = false;
    items.push([ok ? 'pass' : 'fail', 'The accepted allocation covers every line exactly, within each pledge\'s cap and permitted lines.']);
    for (const s of plan.shares) {
      const st = view.proposals[s.funder];
      if (!st) continue;
      const agree = (s.state === 'Arrived' && st === 'Approved') || (s.state === 'Failed' && st === 'Failed') || (s.state === 'Requested');
      items.push([agree ? 'pass' : 'info', `${nameOf(s.funder)}: Lockstep says the share ${s.state.toLowerCase()}; the DAO says its proposal #${s.proposal_id} is ${st}.`]);
    }
  }
  if (plan.claims.length) {
    const owed = plan.claims.reduce((a, c) => a + BigInt(c.amount), 0n);
    const unpaid = plan.claims.filter((c) => c.state !== 'Paid').reduce((a, c) => a + BigInt(c.amount), 0n);
    const inflow = plan.shares.filter((s) => s.state === 'Arrived').reduce((a, s) => a + BigInt(s.amount), 0n) + plan.topups.reduce((a, t) => a + BigInt(t.amount), 0n);
    items.push([owed === inflow ? 'pass' : 'fail', `Everything that came in (${fmt(inflow)}) is owed out (${fmt(owed)}): ${plan.status === 'Settled' ? 'payouts plus unused top-ups' : 'refunds to each source'}.`]);
    items.push([BigInt(plan.escrow) === unpaid ? 'pass' : 'fail', `Escrow still held for this plan (${fmt(plan.escrow)}) equals what is still owed (${fmt(unpaid)}).`]);
  }
  $('checks').innerHTML = items.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('');
}

function renderLog() {
  const entries = [...(view?.log || [])];
  if (job) for (const s of job.steps) if (!entries.some((e) => e.at === s.at && e.label === s.label)) entries.push(s);
  entries.sort((a, b) => (a.at < b.at ? 1 : -1));
  $('logNote').textContent = world.explorer ? 'Each link opens the transaction on the testnet explorer.' : 'Local sandbox: there is no public explorer. Hover a hash to see it in full.';
  $('log').innerHTML = entries.map((e) => {
    const t = new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const link = e.url ? `<a href="${e.url}" target="_blank" rel="noopener">${e.hash.slice(0, 8)}…</a>` : e.hash ? `<span class="mono muted" title="${e.hash}">${e.hash.slice(0, 8)}…</span>` : '';
    return `<li><time>${t}</time><span class="${e.ok ? '' : 'bad'}">${esc(e.label)}${e.failure ? `<span class="fail">${esc(e.failure)}</span>` : ''}</span>${link}</li>`;
  }).join('') || '<li><span></span><span class="muted">No transactions yet for this plan.</span></li>';
}

// ---------------------------------------------------------------------- flow

async function load() {
  if (planId === null) return;
  view = await api(`/api/plan/${planId}`);
  render();
}

async function run(path, payload, label) {
  try {
    const { job: id } = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
    job = { id, steps: [] };
    $('busy').hidden = false;
    $('busyText').textContent = label;
    if (view) render();
    let lastSteps = -1;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      job = await api(`/api/job/${id}`);
      if (job.planId !== null && job.planId !== undefined && job.planId !== planId) { planId = job.planId; await refreshPlans(); }
      // Re-read the plan only when a step landed on chain.
      if (planId !== null && job.steps.length !== lastSteps) { lastSteps = job.steps.length; await load().catch(() => {}); } else if (view) renderLog();
      if (job.status === 'done' || job.status === 'failed') break;
    }
    if (job.status === 'failed') alert(job.error);
  } catch (e) {
    alert(e.message);
  } finally {
    job = null;
    $('busy').hidden = true;
    await refreshPlans();
    await load();
  }
}

async function refreshPlans() {
  world = await api('/api/world');
  const sel = $('planSel');
  sel.innerHTML = world.plans.slice().reverse().map((p) => `<option value="${p.id}">#${p.id} · ${esc(p.title)}</option>`).join('');
  if (planId !== null) sel.value = String(planId);
}

async function init() {
  await refreshPlans();
  const net = world.network === 'testnet' ? 'NEAR testnet' : 'local NEAR sandbox';
  $('net').innerHTML = `<b>${net}</b> · tUSD is a test token with no value`;
  $('donorId').textContent = world.donor;
  $('ids').textContent = `Lockstep ${world.lockstep} · token ${world.token} · DAO factory ${world.factory}`;
  const fromHash = Number(new URLSearchParams(location.search).get('plan'));
  planId = Number.isInteger(fromHash) && fromHash >= 0 && world.plans.some((p) => p.id === fromHash) ? fromHash : world.current;
  if (planId === null || planId === undefined) {
    $('headline').textContent = 'No plan yet.';
    $('subline').textContent = 'Start a new plan: the coordinator proposes it and three DAO councils vote their pledges on chain.';
    return;
  }
  await load();
}

$('planSel').addEventListener('change', async (e) => { planId = Number(e.target.value); $('line').innerHTML = ''; history.replaceState(null, '', `?plan=${planId}`); await load(); });
$('newPlan').addEventListener('click', () => { $('line').innerHTML = ''; run('/api/plans', {}, 'Proposing a plan and voting three DAO pledges on chain…'); });
$('amt').addEventListener('input', updatePreview);
$('line').addEventListener('change', updatePreview);
$('topupForm').addEventListener('submit', (e) => { e.preventDefault(); run(`/api/plan/${planId}/topup`, { amount: Number($('amt').value), line: $('line').value }, 'Sending the top-up…'); });
$('spendBtn').addEventListener('click', () => run(`/api/plan/${planId}/spend`, { dao: 'community' }, 'Community DAO council votes an unrelated payment…'));
$('activateBtn').addEventListener('click', () => run(`/api/plan/${planId}/activate`, {}, 'Activating…'));
$('collectBtn').addEventListener('click', () => run(`/api/plan/${planId}/collect`, {}, 'Collecting each DAO\'s share…'));
$('payBtn').addEventListener('click', () => run(`/api/plan/${planId}/disburse`, {}, 'Sending tokens…'));

init().catch((e) => { $('headline').textContent = 'Could not reach the demo server.'; $('subline').textContent = e.message; });
