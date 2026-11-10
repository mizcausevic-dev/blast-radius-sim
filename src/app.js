import { buildGraph, blastRadius, criticalityRanking, compositeAvailability, findRisks, layers, validateCatalog, STATUS } from './graph.js';
import { SAMPLE_CATALOG } from './sample-catalog.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_JSON_CHARS = 200_000;

const state = { nodes: null, failed: new Set(), ranking: [], avail: new Map() };

function el(tag, attrs = {}, text) {
  const svg = tag.startsWith('svg:');
  const node = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmtAvail = (a) => (a === null ? 'n/a (cycle)' : `${(a * 100).toFixed(3)}%`);

function load(catalog) {
  state.nodes = buildGraph(catalog);
  state.failed.clear();
  state.ranking = criticalityRanking(state.nodes);
  state.avail = compositeAvailability(state.nodes);
  renderRisks();
  renderRanking();
  render();
}

function render() {
  const r = blastRadius(state.nodes, [...state.failed]);
  renderTiles(r);
  renderGraph(r);
}

function renderTiles(r) {
  const entryAvail = r.entrypoints.map((id) => state.avail.get(id)).filter((a) => a !== null);
  const worstEntry = entryAvail.length ? Math.min(...entryAvail) : null;
  const items = [
    ['Failed', String(state.failed.size), state.failed.size ? [...state.failed].join(', ') : 'click a node'],
    ['Down by cascade', String(r.down.length), `of ${state.nodes.size} services`],
    ['Degraded', String(r.degraded.length), 'soft dependency impact'],
    ['Entrypoints hit', `${r.impactedEntrypoints.length} / ${r.entrypoints.length}`, worstEntry === null ? '' : `worst composite availability ${fmtAvail(worstEntry)}`],
  ];
  const tiles = $('tiles');
  tiles.replaceChildren();
  for (const [k, v, s] of items) {
    const t = el('div', { class: 'tile' });
    t.append(el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), el('div', { class: 's' }, s));
    tiles.append(t);
  }
}

function renderGraph(r) {
  const svg = $('graph');
  svg.replaceChildren();
  const cols = layers(state.nodes);
  const NW = 150, NH = 40, GX = 70, GY = 16, PAD = 16;
  const rows = Math.max(...cols.map((c) => c.length));
  const W = PAD * 2 + cols.length * NW + (cols.length - 1) * GX;
  const H = PAD * 2 + rows * NH + (rows - 1) * GY;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const pos = new Map();
  cols.forEach((col, ci) => {
    const offset = ((rows - col.length) * (NH + GY)) / 2;
    col.forEach((id, ri) => pos.set(id, { x: PAD + ci * (NW + GX), y: PAD + offset + ri * (NH + GY) }));
  });

  const edges = el('svg:g');
  for (const n of state.nodes.values()) {
    const a = pos.get(n.id);
    for (const d of n.deps) {
      const b = pos.get(d.id);
      const backward = b.x <= a.x;
      const x1 = backward ? a.x : a.x + NW, y1 = a.y + NH / 2;
      const x2 = backward ? b.x + NW : b.x, y2 = b.y + NH / 2;
      const c = backward ? -60 : 40;
      const ds = r.status.get(d.id);
      let cls = `edge ${d.kind}`;
      if (ds === STATUS.DOWN) cls += d.kind === 'hard' ? ' hot' : ' warm';
      else if (ds === STATUS.DEGRADED) cls += ' warm';
      edges.append(el('svg:path', { class: cls, d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}` }));
    }
  }
  svg.append(edges);

  for (const n of state.nodes.values()) {
    const p = pos.get(n.id);
    const s = r.status.get(n.id);
    const failed = state.failed.has(n.id);
    const cls = ['node', failed ? 'failed' : s, n.entrypoint ? 'entry' : ''].join(' ').trim();
    const label = `${n.id}, tier ${n.tier}, ${failed ? 'failed' : s}. Press Enter to ${failed ? 'restore' : 'fail'}.`;
    const g = el('svg:g', { class: cls, transform: `translate(${p.x},${p.y})`, tabindex: '0', role: 'button', 'aria-pressed': String(failed), 'aria-label': label });
    g.append(el('svg:rect', { width: NW, height: NH, rx: 8 }));
    g.append(el('svg:text', { x: 10, y: 17 }, n.id.length > 19 ? `${n.id.slice(0, 18)}…` : n.id));
    g.append(el('svg:text', { x: 10, y: 31, class: 'sub' }, `T${n.tier} · ${n.domain}`));
    g.append(el('svg:title', {}, `${n.name}\ntier ${n.tier} · ${n.domain}\nstatus: ${failed ? 'failed' : s}\ncomposite availability: ${fmtAvail(state.avail.get(n.id))}`));
    const toggle = () => {
      if (state.failed.has(n.id)) state.failed.delete(n.id); else state.failed.add(n.id);
      render();
      const again = [...$('graph').querySelectorAll('.node')].find((x) => x.getAttribute('aria-label').startsWith(`${n.id},`));
      again?.focus();
    };
    g.addEventListener('click', toggle);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    svg.append(g);
  }
}

function renderRisks() {
  const box = $('risks');
  box.replaceChildren();
  const risks = findRisks(state.nodes);
  if (!risks.length) {
    box.append(el('p', { class: 'hint' }, 'No tier inversions, cycles or single points of failure found.'));
    return;
  }
  for (const r of risks) {
    const div = el('div', { class: `risk ${r.severity}` });
    div.append(el('span', { class: `pill ${r.severity === 'high' ? 'danger' : 'warn'}` }, r.type), document.createTextNode(` ${r.message}`));
    box.append(div);
  }
}

function renderRanking() {
  const body = $('rank').querySelector('tbody');
  body.replaceChildren();
  for (const row of state.ranking.slice(0, 12)) {
    const tr = el('tr');
    tr.append(
      el('td', {}, row.id),
      el('td', { class: 'num' }, String(row.tier)),
      el('td', { class: 'num' }, String(row.takesDown)),
      el('td', { class: 'num' }, String(row.degrades)),
      el('td', { class: 'num' }, String(row.entrypointsDown)),
      el('td', { class: 'num' }, fmtAvail(state.avail.get(row.id))),
    );
    body.append(tr);
  }
}

function applyJson() {
  const err = $('err');
  err.textContent = '';
  const text = $('json').value;
  if (text.length > MAX_JSON_CHARS) { err.textContent = `Catalog is larger than ${MAX_JSON_CHARS} characters.`; return; }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { err.textContent = `Invalid JSON: ${e.message}`; return; }
  const v = validateCatalog(parsed);
  if (!v.ok) { err.textContent = v.errors.slice(0, 8).join('\n'); return; }
  load(parsed);
}

function init() {
  $('json').value = JSON.stringify(SAMPLE_CATALOG, null, 2);
  $('apply').addEventListener('click', applyJson);
  $('sample').addEventListener('click', () => { $('json').value = JSON.stringify(SAMPLE_CATALOG, null, 2); $('err').textContent = ''; load(SAMPLE_CATALOG); });
  $('reset').addEventListener('click', () => { state.failed.clear(); render(); });
  $('worst').addEventListener('click', () => { state.failed = new Set([state.ranking[0].id]); render(); });
  load(SAMPLE_CATALOG);
}

init();
