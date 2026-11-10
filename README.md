# Blast Radius Sim

[![CI](https://github.com/mizcausevic-dev/blast-radius-sim/actions/workflows/ci.yml/badge.svg)](https://github.com/mizcausevic-dev/blast-radius-sim/actions/workflows/ci.yml)
[![Pages](https://github.com/mizcausevic-dev/blast-radius-sim/actions/workflows/pages.yml/badge.svg)](https://mizcausevic-dev.github.io/blast-radius-sim/)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-66fcf1)
![License: MIT](https://img.shields.io/badge/license-MIT-45a29e)

**Live demo: https://mizcausevic-dev.github.io/blast-radius-sim/**

"What breaks when this goes down?" Paste a service catalog, click any service to fail it, and watch the failure cascade through hard and soft dependencies. The analyzer ranks every service by blast radius and flags the architecture smells that cause outages: single points of failure, tier inversions and dependency cycles.

## Why this exists

Every platform team keeps a service catalog. Few can answer, in a design review, which single failure takes down checkout or whether a tier-0 path quietly depends on a best-effort service. This tool turns a catalog into those answers in milliseconds, so resilience is checked during design instead of during an incident.

## Features

| Capability | Detail |
|---|---|
| Failure propagation | Fixed-point propagation. Hard deps go **down**, soft deps go **degraded**. Multiple simultaneous failures are supported |
| Criticality ranking | Every service is failed on its own, then ranked by cascade size and entrypoints lost |
| Tier inversions | A tier-N service hard-depending on a less critical tier is flagged with a fix suggestion |
| Cycle detection | Tarjan's strongly connected components |
| Composite availability | Own availability × product of hard dependencies (independent failures assumed) |
| Accessible graph | Nodes are keyboard-focusable buttons with `aria-pressed` and full status labels |
| Bring your own catalog | Validated JSON, up to 300 services, with clear error messages |

## Catalog format

```json
{
  "services": [
    { "id": "checkout", "tier": 0, "domain": "commerce", "availability": 0.9995,
      "deps": [ { "id": "payments", "kind": "hard" }, { "id": "recommendations", "kind": "soft" } ] },
    { "id": "payments", "tier": 0, "entrypoint": false, "deps": [] }
  ]
}
```

`tier` runs from 0 (most critical) to 3. `kind` defaults to `hard`, and `availability` defaults to `0.999`.

## Architecture

```
index.html ── src/app.js            DOM + SVG rendering, keyboard interaction
                 │
                 ├─ src/graph.js     pure analysis, no DOM, unit-tested
                 │    ├─ validateCatalog / buildGraph
                 │    ├─ propagate (monotone fixed point; terminates with cycles)
                 │    ├─ blastRadius / criticalityRanking
                 │    ├─ findCycles (Tarjan SCC) / compositeAvailability
                 │    ├─ findRisks (tier inversion, cycle, SPOF)
                 │    └─ layers (longest-path layering for the layout)
                 └─ src/sample-catalog.js
```

Design decisions:

- **Monotone propagation.** A status can only move up → degraded → down, so the fixed-point loop is guaranteed to terminate even on cyclic graphs, with no need for a DAG.
- **Planted smells as test oracles.** The sample catalog has known defects, and the test suite asserts that the analyzer finds each one. That's a known-positive control, so the detectors are shown to fire and not just to stay quiet.
- **Untrusted input.** Catalog JSON is size-capped, schema-validated, and rendered with `textContent` and SVG attributes only. A strict CSP blocks inline scripts.

## Run locally

```bash
git clone https://github.com/mizcausevic-dev/blast-radius-sim
cd blast-radius-sim
npm test                      # Node 20+, built-in node:test
python3 -m http.server 8080   # open http://localhost:8080
```

## License

MIT © 2026 Mirza Causevic / Kinetic Gain LLC
