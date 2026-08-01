# Ableton source status

This directory intentionally contains editable source, not an `.amxd` binary.
The repository's working vertical slice uses the mock bridge; the files here do
**not** yet control Ableton sends.

- `iem-remote-bridge-scaffold.maxpat` is a plain-text Max patcher scaffold. It
  starts the Node-for-Max transport, provides start/stop/ping controls, and
  exposes diagnostic `live.path`, `live.object`, and `live.observer` objects.
  It does not resolve configured names or issue send writes.
- `node-for-max-adapter.cjs` is a syntax-valid Node-for-Max message/protocol
  scaffold using Max's provided `max-api`. It is not loaded by normal
  `npm start`, and it does not start the HTTP server or implement `MaxBridge`.

Do not put the scaffold on a show machine expecting real control. The complete
resolution algorithm, protocol responsibilities, remaining implementation,
manual device packaging steps, and test checklist are in
[`../docs/max-for-live-integration.md`](../docs/max-for-live-integration.md).

The scaffold JSON can be inspected without Max:

```sh
node -e "JSON.parse(require('node:fs').readFileSync('ableton/iem-remote-bridge-scaffold.maxpat', 'utf8'))"
node --check ableton/node-for-max-adapter.cjs
```

Opening/saving a real `.amxd` requires Ableton Live Suite and Max for Live. The
generated device should remain uncommitted unless it is intentionally treated
as a release artifact; the editable `.maxpat`/JavaScript sources are the review
source of truth.
