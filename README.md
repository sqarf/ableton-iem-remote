# Ableton IEM Remote

Ableton IEM Remote is a local, offline phone mixer for a five-member band. A
plain Node.js server hosts the phone UI, validates which monitor mix a selected
member may control, and synchronizes authoritative send values over
Server-Sent Events (SSE). Audio remains entirely inside Ableton Live.

The current vertical slice is fully usable in **mock mode**. It simulates the
Ableton send state, so the UI, authorization, validation, reset behavior, and
multi-browser synchronization can be tested without Live or Max for Live.
Real Ableton control is not implemented or verified yet; editable integration
scaffolding and the exact remaining work are documented in
[`docs/max-for-live-integration.md`](docs/max-for-live-integration.md).

## Quick start

Requirements: Node.js 20 or newer. There are no production dependencies and no
internet connection is required.

```sh
npm start
```

On the laptop, open <http://127.0.0.1:3000>. To use a phone, connect it to the
same Wi-Fi/hotspot and open `http://<laptop-ip>:3000`. The default server binds
to all local interfaces (`0.0.0.0`) but is not intended to be exposed to the
internet.

Mock state is in memory. Stopping and restarting the server restores every
source to its configured starting level.

## Verify

```sh
npm test
npm run check
```

For an end-to-end curl and two-browser check, follow
[`docs/operations.md`](docs/operations.md). The API and SSE payloads are listed
in [`docs/api.md`](docs/api.md).

## Project map

- `config/band.json` — members, mixes, exact Ableton names, limits, starts, and
  server settings.
- `server/` — dependency-free HTTP server, mixer service, validation, and
  interchangeable bridges.
- `public/` — portrait-first plain HTML/CSS/JavaScript interface.
- `test/` — tests using Node's built-in test runner.
- `ableton/` — editable Max/Node-for-Max integration scaffold; no fabricated
  `.amxd` binary.
- `docs/` — API, configuration, network operations, architecture,
  troubleshooting, and Ableton integration runbooks.
- `PROJECT.md` — product scope and assumptions.
- `AGENTS.md` — concise durable development rules and verification commands.

## Important operating limits

Member selection is identity, not authentication. Anyone on the band network
can select any configured member, although the server still prevents a member
route from controlling a different mix. Use only on a trusted, isolated band
network until PIN-backed sessions or real accounts are added.

The mock bridge proves the web control path, not Live API correctness. Do not
use a future real bridge in a show until every mapping and failure case in the
[manual Ableton checklist](docs/max-for-live-integration.md#manual-integration-test-checklist)
has passed against the exact Live Set and Ableton/Max versions used on stage.

## Further documentation

- [Architecture and bridge contract](docs/architecture.md)
- [Configuration reference](docs/configuration.md)
- [HTTP and SSE API](docs/api.md)
- [Offline operation and smoke test](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Max for Live integration and packaging](docs/max-for-live-integration.md)
