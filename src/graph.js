// Pure dependency-graph analysis. No DOM.
//
// Catalog shape:
// { services: [{ id, name?, tier: 0|1|2|3, domain?, availability?: 0.999, entrypoint?: bool,
//                deps: [{ id, kind: 'hard'|'soft' }] }] }
// "A depends on B (hard)": A is DOWN if B is DOWN.
// "A depends on B (soft)": A is DEGRADED if B is DOWN or DEGRADED. A hard dependency that is DEGRADED also degrades A.

export const MAX_SERVICES = 300;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const STATUS = Object.freeze({ UP: 'up', DEGRADED: 'degraded', DOWN: 'down' });

export function validateCatalog(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.services)) {
    return { ok: false, errors: ['catalog must be an object with a "services" array'] };
  }
  if (raw.services.length === 0) errors.push('catalog has no services');
  if (raw.services.length > MAX_SERVICES) errors.push(`catalog exceeds ${MAX_SERVICES} services`);
  const ids = new Set();
  raw.services.forEach((s, i) => {
    if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id)) {
      errors.push(`services[${i}].id must be lowercase kebab-case (a-z, 0-9, -), max 63 chars`);
      return;
    }
    if (ids.has(s.id)) errors.push(`duplicate service id "${s.id}"`);
    ids.add(s.id);
    if (s.tier !== undefined && ![0, 1, 2, 3].includes(s.tier)) errors.push(`${s.id}: tier must be 0-3`);
    if (s.availability !== undefined && !(s.availability > 0 && s.availability <= 1)) {
      errors.push(`${s.id}: availability must be in (0, 1]`);
    }
    if (s.deps !== undefined && !Array.isArray(s.deps)) errors.push(`${s.id}: deps must be an array`);
  });
  for (const s of raw.services) {
    if (!s || !Array.isArray(s.deps)) continue;
    for (const d of s.deps) {
      if (!d || typeof d.id !== 'string') { errors.push(`${s.id}: each dep needs an id`); continue; }
      if (!ids.has(d.id)) errors.push(`${s.id}: unknown dependency "${d.id}"`);
      if (d.id === s.id) errors.push(`${s.id}: depends on itself`);
      if (d.kind !== undefined && d.kind !== 'hard' && d.kind !== 'soft') errors.push(`${s.id} -> ${d.id}: kind must be hard or soft`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Normalizes a validated catalog into a Map keyed by id. */
export function buildGraph(raw) {
  const v = validateCatalog(raw);
  if (!v.ok) throw new Error(v.errors.join('; '));
  const nodes = new Map();
  for (const s of raw.services) {
    nodes.set(s.id, {
      id: s.id,
      name: typeof s.name === 'string' ? s.name.slice(0, 80) : s.id,
      tier: s.tier ?? 2,
      domain: typeof s.domain === 'string' ? s.domain.slice(0, 40) : 'default',
      availability: s.availability ?? 0.999,
      entrypoint: Boolean(s.entrypoint),
      deps: (s.deps ?? []).map((d) => ({ id: d.id, kind: d.kind ?? 'hard' })),
      dependents: [],
    });
  }
  for (const n of nodes.values()) {
    for (const d of n.deps) nodes.get(d.id).dependents.push({ id: n.id, kind: d.kind });
  }
  return nodes;
}

/** Tarjan's strongly connected components; returns cycles (SCCs with >1 node). */
export function findCycles(nodes) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const out = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const d of nodes.get(v).deps) {
      if (!idx.has(d.id)) { strong(d.id); low.set(v, Math.min(low.get(v), low.get(d.id))); }
      else if (onStack.has(d.id)) low.set(v, Math.min(low.get(v), idx.get(d.id)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const id of nodes.keys()) if (!idx.has(id)) strong(id);
  return out;
}

/**
 * Propagates failures to a fixed point. Monotone (statuses only get worse), so it terminates
 * even with cycles. Returns Map id -> status.
 */
export function propagate(nodes, failedIds) {
  const status = new Map();
  for (const id of nodes.keys()) status.set(id, STATUS.UP);
  for (const id of failedIds) if (nodes.has(id)) status.set(id, STATUS.DOWN);
  const rank = { up: 0, degraded: 1, down: 2 };
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values()) {
      let next = status.get(n.id);
      for (const d of n.deps) {
        const ds = status.get(d.id);
        let impact = STATUS.UP;
        if (d.kind === 'hard') impact = ds === STATUS.DOWN ? STATUS.DOWN : ds === STATUS.DEGRADED ? STATUS.DEGRADED : STATUS.UP;
        else impact = ds === STATUS.UP ? STATUS.UP : STATUS.DEGRADED;
        if (rank[impact] > rank[next]) next = impact;
      }
      if (next !== status.get(n.id)) { status.set(n.id, next); changed = true; }
    }
  }
  return status;
}

export function blastRadius(nodes, failedIds) {
  const status = propagate(nodes, failedIds);
  const down = [], degraded = [];
  for (const [id, s] of status) {
    if (failedIds.includes(id)) continue;
    if (s === STATUS.DOWN) down.push(id);
    else if (s === STATUS.DEGRADED) degraded.push(id);
  }
  const entrypoints = [...nodes.values()].filter((n) => n.entrypoint).map((n) => n.id);
  const impactedEntrypoints = entrypoints.filter((id) => status.get(id) !== STATUS.UP);
  return { status, down: down.sort(), degraded: degraded.sort(), entrypoints, impactedEntrypoints };
}

/** Ranks every service by how many others it takes down alone. */
export function criticalityRanking(nodes) {
  const rows = [];
  for (const id of nodes.keys()) {
    const r = blastRadius(nodes, [id]);
    rows.push({
      id,
      tier: nodes.get(id).tier,
      takesDown: r.down.length,
      degrades: r.degraded.length,
      entrypointsDown: r.impactedEntrypoints.filter((e) => r.status.get(e) === STATUS.DOWN || e === id).length,
    });
  }
  return rows.sort((a, b) => b.takesDown - a.takesDown || b.entrypointsDown - a.entrypointsDown || b.degrades - a.degrades || a.id.localeCompare(b.id));
}

/**
 * Composite availability of each service = own availability x product over hard deps
 * (independent-failure assumption). Services in a cycle are reported as null.
 */
export function compositeAvailability(nodes) {
  const cyclic = new Set(findCycles(nodes).flat());
  const memo = new Map();
  const visit = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (cyclic.has(id)) { memo.set(id, null); return null; }
    memo.set(id, null); // guard
    const n = nodes.get(id);
    let a = n.availability;
    for (const d of n.deps) {
      if (d.kind !== 'hard') continue;
      const da = visit(d.id);
      if (da === null) { memo.set(id, null); return null; }
      a *= da;
    }
    memo.set(id, a);
    return a;
  };
  const out = new Map();
  for (const id of nodes.keys()) out.set(id, visit(id));
  return out;
}

/** Architecture smells: tier inversions on hard deps, cycles, single points of failure. */
export function findRisks(nodes) {
  const risks = [];
  for (const n of nodes.values()) {
    for (const d of n.deps) {
      const dep = nodes.get(d.id);
      if (d.kind === 'hard' && dep.tier > n.tier) {
        risks.push({ type: 'tier-inversion', severity: 'high', ids: [n.id, d.id],
          message: `Tier ${n.tier} service ${n.id} hard-depends on tier ${dep.tier} ${d.id}. Make it soft (fallback/cache) or raise ${d.id}'s tier.` });
      }
    }
  }
  for (const c of findCycles(nodes)) {
    risks.push({ type: 'cycle', severity: 'high', ids: c, message: `Dependency cycle: ${c.join(' ↔ ')}. Cycles block independent deploys and cold starts.` });
  }
  const entrypoints = [...nodes.values()].filter((n) => n.entrypoint).length;
  if (entrypoints > 0) {
    for (const row of criticalityRanking(nodes)) {
      if (row.entrypointsDown === entrypoints && !nodes.get(row.id).entrypoint) {
        risks.push({ type: 'spof', severity: 'medium', ids: [row.id],
          message: `${row.id} is a single point of failure: it takes down every entrypoint on its own.` });
      }
    }
  }
  return risks;
}

/** Longest-path layering (depth from leaves) for a left-to-right layout; cycles are cut. */
export function layers(nodes) {
  const depth = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const dep of nodes.get(id).deps) d = Math.max(d, visit(dep.id) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of nodes.keys()) visit(id);
  const max = Math.max(0, ...depth.values());
  const cols = Array.from({ length: max + 1 }, () => []);
  for (const [id, d] of depth) cols[max - d].push(id);
  for (const col of cols) col.sort((a, b) => nodes.get(a).domain.localeCompare(nodes.get(b).domain) || a.localeCompare(b));
  return cols;
}
