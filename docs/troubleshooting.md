# Troubleshooting

## Server does not start

- Run `node --version`; Node.js 20 or newer is required.
- Run `npm run check` and `npm test` to separate syntax/test failures from an
  operating-system network issue.
- A configuration error is intentional fail-closed behavior. Read the reported
  field, compare it with [`configuration.md`](configuration.md), and fix the
  JSON rather than bypassing validation.
- `EADDRINUSE` means another process is using the port. Stop the intended old
  server or choose another port, for example `PORT=3100 npm start`.
- `EACCES` normally means the chosen port/interface is not permitted. Use an
  unprivileged port such as `3000` and check local security software.

## Laptop works but a phone cannot connect

- Use the laptop's hotspot-interface IP, not `127.0.0.1`, `0.0.0.0`, or an IP
  from an inactive interface.
- Confirm the phone and laptop are on the same SSID/subnet and the server says
  it is listening on `0.0.0.0`, not only `127.0.0.1`.
- Try `http://<laptop-ip>:<port>/api/health` from the phone.
- Allow incoming TCP connections to that port in the laptop firewall. macOS may
  associate the prompt with Terminal, Node, Max, or Ableton depending on how
  the server is hosted.
- Disable VPN/private relay temporarily and check for access-point client
  isolation. Phones may label an offline hotspot as unusable and switch to
  mobile data; tell the phone to stay connected.
- Re-check the IP after restarting Internet Sharing/hotspot.

## UI says disconnected or stops updating

- Check `/api/health`. If it fails, restart the Node server and inspect its
  terminal output.
- SSE reconnect is automatic, but mobile browsers throttle background tabs.
  Foreground the page; it should receive a fresh snapshot.
- A connected HTTP server and a disconnected bridge are different states. In
  mock mode the bridge should normally be connected. In real mode,
  missing/duplicate names or stale Live objects deliberately make the bridge
  unavailable.
- If only one browser looks stale, reload it. If every browser is stale, inspect
  the server/bridge status before changing any Live mapping.

## A request is rejected

- Confirm IDs using `GET /api/config`; use IDs, not display names or Ableton
  names, in URLs.
- A member may only use its configured `mixId`. A cross-mix route is expected to
  fail even if the source exists.
- Level writes require `Content-Type: application/json` and a body shaped as
  `{"value": 0.5}`. The value must be a JSON number and finite.
- An unknown route, extra path segment, unsupported method, oversized body, or
  malformed JSON is rejected intentionally.

## Reset or faders appear surprising

- Reset values come from each source's `startingLevels` entry for the selected
  mix; they are not copied from Ableton and not a global default.
- Mock values are process-local and return to starts after server restart.
- Rapid drag requests are coalesced, so the bridge may not process every
  intermediate value. The last confirmed SSE value is authoritative.
- Out-of-range finite values are clamped to global configured bounds. Invalid
  value types are rejected rather than coerced.

## Max for Live bridge will not connect

The shipped Max files implement the real source path, but mock/fake-transport
tests cannot prove the installed Live API environment. Follow the status gates,
development connection steps, and exact-name resolution details in
[`max-for-live-integration.md`](max-for-live-integration.md). In particular:

- Each configured source name must match exactly one normal Live track.
- Each configured monitor name must match exactly one return track.
- Duplicate exact names are a hard safety error.
- Reordering is allowed only if the adapter re-resolves names and derives fresh
  send IDs; stale indices/IDs must never be used.
- Deleted, unavailable, disabled, or out-of-range send parameters must make the
  mapping unavailable.
- Confirm `npm start` is not already occupying the configured port. The real
  HTTP server runs inside `node.script`, not in a second terminal process.
- In a development device, confirm Max can find `node-for-max-adapter.cjs` and
  `live-api-controller.js` through the repository `ableton/` search path. In a
  frozen device, inspect collected dependencies instead of adding absolute
  machine paths.
- Use the patch's **status** and **rescan** messages and inspect Max Console
  `iem-adapter-status`/`iem-event` output. A rescan must rebuild the whole
  mapping; it is not permission to reuse an old Live object ID.

Never “fix” a mapping error by choosing the first same-named track, using a
remembered index, or changing audio routing automatically.
