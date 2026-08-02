# Ableton integration source

This directory contains editable source for the real bridge, not a fabricated
`.amxd` binary:

- `iem-remote-bridge.maxpat` wires the Node-for-Max process to the Max
  `LiveAPI` controller and requests a low-priority rescan when the device is
  ready;
- `node-for-max-adapter.cjs` loads the validated band config, `MaxBridge`,
  `MixerService`, and the same HTTP/SSE server used in mock mode;
- `live-api-controller.js` resolves exact configured source/return names,
  observes their send parameters, applies generation-checked writes, and sends
  confirmed normalized values back to Node.

Normal `npm start` deliberately remains the offline mock workflow. Real mode is
started by `node.script` inside the Max for Live device. The protocol and bridge
states can be tested without Ableton, but the Live API behavior has not passed
the target-machine manual checklist until you perform it.

Source-only checks:

```sh
node --check ableton/node-for-max-adapter.cjs
node --check ableton/live-api-controller.js
node -e "JSON.parse(require('node:fs').readFileSync('ableton/iem-remote-bridge.maxpat', 'utf8'))"
```

Opening/saving a real `.amxd` requires Ableton Live Suite and Max for Live.
Follow the developer test, packaging, and safety steps in
[`../docs/max-for-live-integration.md`](../docs/max-for-live-integration.md).
Keep the `.maxpat` and JavaScript sources as the review source of truth.
