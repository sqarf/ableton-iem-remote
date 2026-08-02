# Ableton IEM Remote

Ableton IEM Remote is a local, offline phone mixer for a five-member band. A
plain Node.js server hosts the phone UI, validates which monitor mix a selected
member may control, and synchronizes authoritative send values over
Server-Sent Events (SSE). Audio remains entirely inside Ableton Live.

The app is fully usable in **mock mode** for testing without Live. The
repository also contains the complete editable real bridge path: a tested
server-side `MaxBridge`, a Node-for-Max server bootstrap, a Max `LiveAPI`
controller, and a wired `.maxpat` source. That real path is ready for its first
Ableton connection test, but it cannot be certified by automated tests alone;
it still needs packaging and the manual safety checklist on the target
Live/Max versions. See
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

## First Ableton connection

You can begin the Live ↔ web test now. Use a muted copied Set, create the exact
configured source/return names, and copy
`ableton/iem-remote-bridge.maxpat` into a blank Max MIDI Effect. The device's
`node.script` starts the real HTTP server; do not run `npm start` at the same
time. Follow the complete
[development connection procedure](docs/max-for-live-integration.md#first-development-connection-test)
before moving any send.

## Project map

- `config/band.json` — members, mixes, exact Ableton names, limits, starts, and
  server settings.
- `server/` — dependency-free HTTP server, mixer service, validation, and
  interchangeable bridges.
- `public/` — portrait-first plain HTML/CSS/JavaScript interface.
- `test/` — tests using Node's built-in test runner.
- `ableton/` — editable Max patch, LiveAPI controller, and Node-for-Max real
  server entry point; no fabricated `.amxd` binary.
- `docs/` — API, configuration, network operations, architecture,
  troubleshooting, and Ableton integration runbooks.
- `PROJECT.md` — product scope and assumptions.
- `AGENTS.md` — concise durable development rules and verification commands.

## Important operating limits

Member selection is identity, not authentication. Anyone on the band network
can select any configured member, although the server still prevents a member
route from controlling a different mix. Use only on a trusted, isolated band
network until PIN-backed sessions or real accounts are added.

The mock bridge and fake-Max tests prove the web/protocol path, not behavior of
the installed Live Object Model. Do not use the real bridge in a show until
every mapping and failure case in the
[manual Ableton checklist](docs/max-for-live-integration.md#manual-integration-test-checklist)
has passed against the exact Live Set and Ableton/Max versions used on stage.

## Further documentation

- [Architecture and bridge contract](docs/architecture.md)
- [Configuration reference](docs/configuration.md)
- [HTTP and SSE API](docs/api.md)
- [Offline operation and smoke test](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Max for Live integration and packaging](docs/max-for-live-integration.md)
