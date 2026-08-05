# Architecture and bridge contract

## Implemented bridge paths

The application has three boundaries:

```text
phone browser  --HTTP/SSE-->  HTTP server + MixerService  --bridge calls/events-->  MockBridge
```

The browser never sees Ableton mapping names. It works with stable member,
mix, and source IDs from the public configuration. The HTTP layer parses and
limits requests. `MixerService` owns member-to-mix authorization, range
enforcement, write coalescing, authoritative state, resets, and subscriber
events. The mock bridge stores values in process memory and emits the same
authoritative events expected from a real bridge.

The implemented real path replaces only the final component:

```text
phone browser  --HTTP/SSE-->  HTTP server + MixerService
                                      |
                               MaxBridge
                                      |
                        Node for Max message adapter
                                      |
                     Max Live API resolver/observers
                                      |
                          configured Ableton send parameters
```

No component in either path carries audio.

## Server-facing bridge contract

A bridge is an `EventEmitter`-compatible object with these asynchronous
operations:

```js
await bridge.start();
await bridge.stop();
await bridge.setLevel(mixId, sourceId, normalizedValue);
const snapshot = await bridge.getSnapshot(mixId);
```

It emits:

```js
bridge.emit('status', {
  state: 'stopped' | 'connecting' | 'connected' | 'disconnected' | 'error',
  connected: Boolean,
  message: 'optional human-readable context'
});

bridge.emit('level', {
  mixId: 'vocalist',
  sourceId: 'main-vocals',
  value: 0.72
});
```

Contract requirements:

- Values at this boundary are finite normalized numbers within the validated
  configured minimum and maximum.
- `getSnapshot(mixId)` returns an object keyed by every configured source ID;
  startup fails if any value is absent, non-finite, or outside configured bounds.
- `setLevel` requests a change; it does not itself make the requested value
  authoritative. A bridge must emit `level` only after its backing system
  confirms/read-backs the resulting parameter value.
- A request that rounds to the existing Live value still needs an authoritative
  read-back, because an observer may not fire for an unchanged parameter.
- The real bridge must emit direct edits made in Live through the same `level`
  event.
- `connected: true` means mappings are resolved, unambiguous, observed, and
  writable—not merely that a Node process or Max device exists.
- On any lost, missing, ambiguous, disabled, or stale Live object, stop writes
  and emit a non-connected status. Never keep using an old object ID.
- `start` and `stop` must be safe to call during normal lifecycle cleanup.
  `stop` must remove observers/listeners and reject or drain pending work.

The mock bridge follows this contract but deliberately cannot validate Live
track names, return ordering, parameter ranges, or observer timing.

The HTTP/static server remains available when initial bridge startup fails and
reports the bridge error through health/config responses. It retries bridge
startup in the background, allowing open phones to recover through their normal
SSE behavior once an authoritative snapshot becomes available. Existing SSE
streams receive a fresh complete snapshot after a successful real-bridge
rescan; they do not retain a partial previous generation.
It also exposes `simulateExternalChange(mixId, sourceId, value)` to tests and
in-process development harnesses so a direct-Ableton-style observer change can
be exercised. There is intentionally no mock-only HTTP endpoint; mock and real
modes keep the same browser API.

## Write and synchronization flow

1. A client sends a member-scoped HTTP write.
2. The server validates route IDs, verifies that the member owns that exact
   mix, checks JSON/value shape, and clamps a finite value to configured bounds.
3. Rapid writes to the same `(mixId, sourceId)` are coalesced before the bridge
   call. Different controls remain independent.
4. The bridge changes its backing value and emits the confirmed `level` event.
5. `MixerService` records that authoritative value and broadcasts it to SSE
   clients viewing that member/mix.

The UI may move optimistically while a finger is dragging, but SSE/read-back is
the final truth. Disconnecting a browser never resets values. Mock values live
until the server exits; in real mode Ableton retains the parameter value.

## Trust and safety boundaries

- The browser is untrusted. Hiding a mix is never authorization.
- A URL contains both `memberId` and `mixId`; the server checks their configured
  relationship on every state read, event subscription, level write, and reset.
- Ableton names are private mapping data and are omitted from the public config.
- There is no account authentication in this iteration. Network isolation is
  part of the operating model.
- The bridge may control only the configured source-to-monitor send parameter.
  Transport, routing, track volume, devices, front-of-house levels, and global
  Live settings are outside the bridge contract.

## Real-bridge validation boundary

The Node-for-Max adapter loads the same validated configuration and HTTP stack,
while the Max-side controller performs all-or-nothing exact-name resolution and
installs send-value observers before reporting connected. Fake-transport tests
cover the server boundary; Live API timing and object behavior still require
the packaging and manual tests in
[`max-for-live-integration.md`](max-for-live-integration.md).
