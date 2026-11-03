// Funding-gap engine for Lockstep.
//
// A plan has cost lines (key, amount). Funding sources (DAO pledges, escrowed
// top-ups) each have a cap and a list of lines they are allowed to pay for.
// The largest amount the sources can cover is a maximum flow on the bipartite
// graph  source -> pledge (cap) -> line (unbounded) -> sink (line amount).
// The minimum cut of that graph certifies the maximum, so anyone can check the
// gap without trusting this solver (see verifyCertificate).
//
// All amounts are BigInt in the token's smallest unit. Runs in Node and browsers.

const INF = -1n; // marker for an unbounded edge

/**
 * @typedef {{ key: string, amount: bigint }} Line
 * @typedef {{ id: string, cap: bigint, lines: string[] }} Source
 * @typedef {{ source: string, line: string, amount: bigint }} Assignment
 */

function buildGraph(lines, sources) {
  const nodes = ['s', 't'];
  const index = new Map([['s', 0], ['t', 1]]);
  const add = (name) => {
    if (!index.has(name)) { index.set(name, nodes.length); nodes.push(name); }
    return index.get(name);
  };
  const edges = []; // {from, to, cap, flow}
  const adj = [];
  const addEdge = (a, b, cap) => {
    const e = { from: a, to: b, cap, flow: 0n };
    const r = { from: b, to: a, cap: 0n, flow: 0n, rev: true };
    e.twin = r; r.twin = e;
    edges.push(e);
    (adj[a] ||= []).push(e);
    (adj[b] ||= []).push(r);
    return e;
  };
  const lineKeys = new Set();
  for (const l of lines) {
    if (lineKeys.has(l.key)) throw new Error(`duplicate line ${l.key}`);
    lineKeys.add(l.key);
    addEdge(add('l:' + l.key), 1, l.amount);
  }
  const sourceIds = new Set();
  for (const s of sources) {
    if (sourceIds.has(s.id)) throw new Error(`duplicate source ${s.id}`);
    sourceIds.add(s.id);
    const sn = add('p:' + s.id);
    addEdge(0, sn, s.cap);
    for (const k of new Set(s.lines)) {
      if (!lineKeys.has(k)) continue; // a pledge may name lines this plan does not have
      addEdge(sn, index.get('l:' + k), INF);
    }
  }
  for (let i = 0; i < nodes.length; i++) adj[i] ||= [];
  return { nodes, index, edges, adj };
}

const residual = (e) => (e.cap === INF ? INF : e.cap - e.flow);
const positive = (r) => r === INF || r > 0n;
const minR = (a, b) => (a === INF ? b : b === INF ? a : a < b ? a : b);

function maxflow(g) {
  // Edmonds-Karp. Graphs here are tiny (tens of nodes), BigInt-safe.
  let total = 0n;
  for (;;) {
    const prev = new Array(g.nodes.length).fill(null);
    const seen = new Array(g.nodes.length).fill(false);
    seen[0] = true;
    const q = [0];
    while (q.length && !seen[1]) {
      const u = q.shift();
      for (const e of g.adj[u]) {
        const r = e.rev ? e.twin.flow : residual(e);
        if (!seen[e.to] && positive(r)) { seen[e.to] = true; prev[e.to] = e; q.push(e.to); }
      }
    }
    if (!seen[1]) break;
    let push = INF;
    for (let v = 1; v !== 0; v = prev[v].from) {
      const e = prev[v];
      push = minR(push, e.rev ? e.twin.flow : residual(e));
    }
    if (push === INF) throw new Error('unbounded flow'); // impossible: sink edges are bounded
    for (let v = 1; v !== 0; v = prev[v].from) {
      const e = prev[v];
      if (e.rev) e.twin.flow -= push; else e.flow += push;
    }
    total += push;
  }
  return total;
}

function reachable(g) {
  const seen = new Array(g.nodes.length).fill(false);
  seen[0] = true;
  const q = [0];
  while (q.length) {
    const u = q.shift();
    for (const e of g.adj[u]) {
      const r = e.rev ? e.twin.flow : residual(e);
      if (!seen[e.to] && positive(r)) { seen[e.to] = true; q.push(e.to); }
    }
  }
  return seen;
}

/**
 * Solve the plan: how much the current sources can cover, an allocation that
 * achieves it, the gap, and a min-cut certificate.
 * @param {Line[]} lines @param {Source[]} sources
 */
export function solve(lines, sources) {
  const g = buildGraph(lines, sources);
  const funded = maxflow(g);
  const required = lines.reduce((a, l) => a + l.amount, 0n);
  const allocation = [];
  for (const e of g.edges) {
    const a = g.nodes[e.from], b = g.nodes[e.to];
    if (a.startsWith('p:') && b.startsWith('l:') && e.flow > 0n) {
      allocation.push({ source: a.slice(2), line: b.slice(2), amount: e.flow });
    }
  }
  const coveredByLine = Object.fromEntries(lines.map((l) => [l.key, 0n]));
  for (const x of allocation) coveredByLine[x.line] += x.amount;
  const seen = reachable(g);
  const certificate = {
    // Nodes on the source side of a minimum cut. Its capacity equals `funded`.
    sourceSide: g.nodes.filter((n, i) => seen[i] && n !== 's'),
    value: funded,
  };
  return {
    required,
    funded,
    gap: required - funded,
    allocation,
    shortByLine: Object.fromEntries(lines.map((l) => [l.key, l.amount - coveredByLine[l.key]])),
    certificate,
  };
}

/**
 * Check, without any optimizer, that `allocation` is feasible and that the cut
 * proves no allocation can cover more. Returns {ok, funded, reasons[]}.
 */
export function verifyCertificate(lines, sources, allocation, certificate) {
  const reasons = [];
  const lineAmt = new Map(lines.map((l) => [l.key, l.amount]));
  const src = new Map(sources.map((s) => [s.id, s]));
  const usedBySource = new Map();
  const coveredByLine = new Map();
  for (const a of allocation) {
    const s = src.get(a.source);
    if (!s) { reasons.push(`unknown source ${a.source}`); continue; }
    if (!lineAmt.has(a.line)) { reasons.push(`unknown line ${a.line}`); continue; }
    if (!s.lines.includes(a.line)) reasons.push(`${a.source} may not pay for ${a.line}`);
    if (a.amount <= 0n) reasons.push(`non-positive amount ${a.source}->${a.line}`);
    usedBySource.set(a.source, (usedBySource.get(a.source) || 0n) + a.amount);
    coveredByLine.set(a.line, (coveredByLine.get(a.line) || 0n) + a.amount);
  }
  for (const [id, used] of usedBySource) if (used > src.get(id).cap) reasons.push(`${id} over its cap`);
  for (const [k, c] of coveredByLine) if (c > lineAmt.get(k)) reasons.push(`${k} over-covered`);
  const funded = [...coveredByLine.values()].reduce((a, b) => a + b, 0n);

  // Cut capacity: s->pledge edges crossing (pledge on sink side), line->t edges
  // crossing (line on source side), and no unbounded pledge->line edge may cross.
  const S = new Set(certificate.sourceSide);
  let cut = 0n;
  for (const s of sources) {
    const pin = S.has('p:' + s.id);
    if (!pin) cut += s.cap;
    else for (const k of s.lines) if (lineAmt.has(k) && !S.has('l:' + k)) reasons.push(`cut crosses unbounded edge ${s.id}->${k}`);
  }
  for (const l of lines) if (S.has('l:' + l.key)) cut += l.amount;
  if (cut !== funded) reasons.push(`cut ${cut} != allocated ${funded}`);
  if (certificate.value !== undefined && BigInt(certificate.value) !== funded) reasons.push('certificate value mismatch');
  return { ok: reasons.length === 0, funded, cut, reasons };
}

/**
 * What would complete the plan: the smallest unrestricted top-up, and for each
 * line the smallest top-up restricted to that line alone (null when a top-up on
 * that line alone cannot complete the plan).
 */
export function completions(lines, sources) {
  const base = solve(lines, sources);
  const out = { gap: base.gap, anyLine: base.gap, byLine: {} };
  if (base.gap === 0n) return out;
  for (const l of lines) {
    const fundedWith = (x) => solve(lines, [...sources, { id: '__topup', cap: x, lines: [l.key] }]).funded;
    if (fundedWith(base.gap + l.amount) < base.required) { out.byLine[l.key] = null; continue; }
    let lo = base.gap, hi = base.gap + l.amount; // gap <= answer <= gap + line
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (fundedWith(mid) >= base.required) hi = mid; else lo = mid + 1n;
    }
    out.byLine[l.key] = lo;
  }
  return out;
}

/** Effect of a proposed top-up before anyone sends it. */
export function previewTopup(lines, sources, amount, topupLines) {
  const before = solve(lines, sources);
  const after = solve(lines, [...sources, { id: '__topup', cap: amount, lines: topupLines }]);
  return {
    gapBefore: before.gap,
    gapAfter: after.gap,
    completes: after.gap === 0n,
    used: after.allocation.filter((a) => a.source === '__topup').reduce((s, a) => s + a.amount, 0n),
  };
}

/** Exhaustive minimum cut, for cross-checking on small instances only. */
export function bruteForceFunded(lines, sources) {
  const n = sources.length + lines.length;
  if (n > 16) throw new Error('too large for brute force');
  let best = null;
  for (let mask = 0; mask < 1 << n; mask++) {
    // bit i set => node i on the source side
    const inS = (i) => (mask >> i) & 1;
    let cut = 0n, valid = true;
    sources.forEach((s, i) => {
      if (!inS(i)) cut += s.cap;
      else for (const k of s.lines) {
        const j = lines.findIndex((l) => l.key === k);
        if (j >= 0 && !inS(sources.length + j)) valid = false;
      }
    });
    if (!valid) continue;
    lines.forEach((l, j) => { if (inS(sources.length + j)) cut += l.amount; });
    if (best === null || cut < best) best = cut;
  }
  return best;
}
