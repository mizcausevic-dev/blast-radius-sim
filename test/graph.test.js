import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, buildGraph, propagate, blastRadius, findCycles, criticalityRanking, compositeAvailability, findRisks, layers, STATUS } from '../src/graph.js';
import { SAMPLE_CATALOG } from '../src/sample-catalog.js';

const chain = { services: [
  { id: 'a', entrypoint: true, deps: [{ id: 'b', kind: 'hard' }, { id: 'c', kind: 'soft' }] },
  { id: 'b', deps: [{ id: 'd', kind: 'hard' }] },
  { id: 'c', deps: [] },
  { id: 'd', availability: 0.99, deps: [] },
] };

test('sample catalog is valid', () => assert.deepEqual(validateCatalog(SAMPLE_CATALOG), { ok: true, errors: [] }));

test('validation rejects bad input (known-positive controls)', () => {
  assert.equal(validateCatalog(null).ok, false);
  assert.equal(validateCatalog({ services: [{ id: 'A b' }] }).ok, false);
  assert.match(validateCatalog({ services: [{ id: 'a', deps: [{ id: 'zz' }] }] }).errors[0], /unknown dependency/);
  assert.match(validateCatalog({ services: [{ id: 'a' }, { id: 'a' }] }).errors.join(), /duplicate/);
  assert.match(validateCatalog({ services: [{ id: 'a', deps: [{ id: 'a' }] }] }).errors.join(), /itself/);
  assert.equal(validateCatalog({ services: Array.from({ length: 301 }, (_, i) => ({ id: `s${i}` })) }).ok, false);
});

test('hard failure propagates transitively, soft failure degrades', () => {
  const g = buildGraph(chain);
  const s = propagate(g, ['d']);
  assert.equal(s.get('b'), STATUS.DOWN);
  assert.equal(s.get('a'), STATUS.DOWN);
  const s2 = propagate(g, ['c']);
  assert.equal(s2.get('a'), STATUS.DEGRADED);
  assert.equal(s2.get('b'), STATUS.UP);
});

test('blast radius excludes the failed node itself and lists impacted entrypoints', () => {
  const r = blastRadius(buildGraph(chain), ['b']);
  assert.deepEqual(r.down, ['a']);
  assert.deepEqual(r.impactedEntrypoints, ['a']);
});

test('cycles are detected and propagation still terminates', () => {
  const g = buildGraph({ services: [
    { id: 'x', deps: [{ id: 'y' }] }, { id: 'y', deps: [{ id: 'x' }] }, { id: 'z', deps: [] },
  ] });
  assert.deepEqual(findCycles(g), [['x', 'y']]);
  const s = propagate(g, ['x']);
  assert.equal(s.get('y'), STATUS.DOWN);
  assert.equal(s.get('z'), STATUS.UP);
});

test('composite availability multiplies hard deps only', () => {
  const a = compositeAvailability(buildGraph(chain));
  assert.ok(Math.abs(a.get('b') - 0.999 * 0.99) < 1e-12);
  assert.ok(Math.abs(a.get('a') - 0.999 * 0.999 * 0.99) < 1e-12);
});

test('sample catalog: finds the planted tier inversion, cycle and SPOF', () => {
  const g = buildGraph(SAMPLE_CATALOG);
  const risks = findRisks(g);
  assert.ok(risks.some((r) => r.type === 'tier-inversion' && r.ids.join() === 'checkout,fraud-scoring'));
  assert.ok(risks.some((r) => r.type === 'cycle' && r.ids.join() === 'catalog,inventory'));
  assert.ok(risks.some((r) => r.type === 'spof' && r.ids[0] === 'auth'));
  assert.equal(compositeAvailability(g).get('catalog'), null);
});

test('criticality ranking puts shared infra above leaf services', () => {
  const rank = criticalityRanking(buildGraph(SAMPLE_CATALOG));
  const pos = (id) => rank.findIndex((r) => r.id === id);
  assert.ok(pos('catalog-db') < pos('search-index'));
  assert.ok(pos('session-cache') < pos('notifications'));
});

test('layers put entrypoints left of their dependencies', () => {
  const g = buildGraph(chain);
  const cols = layers(g);
  const col = (id) => cols.findIndex((c) => c.includes(id));
  assert.ok(col('a') < col('b') && col('b') < col('d'));
});
