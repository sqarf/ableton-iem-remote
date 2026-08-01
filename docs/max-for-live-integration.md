# Max for Live integration boundary

## Current status

The regular Node server and `MockBridge` are the implemented/testable vertical
slice. **Real Max for Live control is not implemented or verified.** The files
under `ableton/` are editable diagnostics/protocol scaffolding only:

- the `.maxpat` opens as source and contains no binary device data;
- the Node-for-Max script loads `max-api`, frames protocol messages, and offers
  ping/status diagnostics;
- it does not start the HTTP server, instantiate a real `MaxBridge`, resolve the
  Live Set, observe parameters, or write a send.

No `.amxd` is committed because a trustworthy device must be opened, completed,
saved, frozen, and tested through the installed Max for Live environment.

## Required Live Set convention

Use these exact, case-sensitive names unless the JSON is deliberately edited:

- source tracks: `IEM SRC - Vocal 1`, `IEM SRC - Vocal 2`,
  `IEM SRC - Guitar 1`, `IEM SRC - Guitar 2`, `IEM SRC - Bass`,
  `IEM SRC - Kick`, `IEM SRC - Snare`, `IEM SRC - Backing Tracks`, and
  `IEM SRC - Click`;
- return tracks: `IEM MIX - Vocalist`, `IEM MIX - Guitarist 1`,
  `IEM MIX - Guitarist 2`, `IEM MIX - Bassist`, and `IEM MIX - Drummer`.

These are values in `source.abletonTrack` and `mix.abletonTrack`, not API IDs.
Source names must resolve among normal tracks; mix names must resolve among
return tracks. A same-named group, master, return, or device is not a substitute.

The recommended device location is a dedicated empty MIDI track named
`IEM REMOTE BRIDGE`. The operator decides and verifies routing manually. The
device must never create tracks, create returns, reorder anything, alter track
input/output, change monitoring, or change audio/MIDI routing.

## Safe name-to-send resolution algorithm

The completed Max-side controller must perform a complete transaction before
reporting connected:

1. Wait for `live.thisdevice`/the Live API to be available, then enter
   `connecting`. Reject writes during this state.
2. Enumerate `live_set tracks`; read each Track `name`. For every configured
   source name, require exactly one exact, case-sensitive match. Zero matches is
   `SOURCE_MISSING`; more than one is `SOURCE_AMBIGUOUS`.
3. Enumerate `live_set return_tracks`; read each return Track `name`. For every
   configured monitor name, require exactly one exact match. Zero matches is
   `MIX_MISSING`; more than one is `MIX_AMBIGUOUS`.
4. For each resolved source Track, resolve its `mixer_device` and current
   `sends` children. Derive the target send using the *currently resolved*
   position of the exact matching return track. This dynamically derived
   position is not a stored/fallback mapping.
5. Require the resulting send to be one valid, available DeviceParameter.
   Read `min`, `max`, and `value`; require finite numbers with `max > min`.
   Convert between the server's normalized value and the parameter range:

   ```text
   liveValue = min + normalized * (max - min)
   normalized = (liveValue - min) / (max - min)
   ```

   Apply configured normalized safety limits before writes as a second line of
   defense. Do not assume all Live/Max versions expose exactly `0..1`.
6. Install a `value` observer for every resolved send. Associate observer
   callbacks with stable `(mixId, sourceId)` IDs—not display names or an array
   position. Read an initial snapshot only after all observers exist.
7. If and only if the entire mapping is valid, atomically publish the snapshot
   and report `connected: true`. A partial mixer is unsafe and must remain
   disconnected.

Names and Live object IDs can become stale after rename, insert/delete,
return-track reorder, undo/redo, Set load, or device reload. Observe topology
where the Live API version permits it and schedule a low-priority full re-scan;
also provide an explicit re-scan command. During rebuild, detach old observers,
mark disconnected, discard queued writes, and never use cached IDs. Reordering
is safe only after fresh exact-name resolution and fresh send IDs.

## Write and observer responsibilities

For `set-level`:

1. Require the currently connected mapping generation and known stable IDs.
2. Require a finite normalized number; clamp to configured bounds.
3. Convert against the parameter's current finite `min`/`max` and set only its
   `value` through `live.object`/the equivalent Live API wrapper.
4. Wait for the `live.observer value` callback. Convert and emit the observed
   value as authoritative.
5. If no observer callback arrives because the value is unchanged, perform an
   explicit read-back after the set and emit that confirmed value exactly once.
6. On unavailable object/error/timeout, invalidate the whole mapping generation
   and report non-connected. Never tell browsers the requested value was
   accepted when Live did not confirm it.

Observer callbacks also report edits made directly in Ableton. Coalesce noisy
duplicate observer readings without suppressing a changed final value. Detach
all observers on device disable, bridge stop, or Set topology invalidation.
Avoid blocking work on Ableton's main thread; use low-priority/deferred Max
scheduling and let the server's per-control write coalescing absorb drag traffic.

## Node-for-Max message protocol

Use one selector plus one JSON object so Max atoms do not become a second API.
Protocol version `1` is scaffolded in `ableton/node-for-max-adapter.cjs`.

Node to Max:

```text
iem.command {"protocolVersion":1,"type":"resolve","requestId":"n-1","sources":[{"id":"vocal-1","abletonTrack":"IEM SRC - Vocal 1"}],"mixes":[{"id":"vocalist","abletonTrack":"IEM MIX - Vocalist"}],"minimum":0,"maximum":1}
iem.command {"protocolVersion":1,"type":"set-level","requestId":"n-2","generation":4,"mixId":"vocalist","sourceId":"vocal-1","value":0.61}
iem.command {"protocolVersion":1,"type":"get-snapshot","requestId":"n-3","generation":4,"mixId":"vocalist"}
iem.command {"protocolVersion":1,"type":"stop","requestId":"n-4"}
```

Max to Node:

```text
iem.event {"protocolVersion":1,"type":"status","state":"connecting","connected":false}
iem.event {"protocolVersion":1,"type":"resolved","requestId":"n-1","generation":4,"snapshot":{"vocalist":{"vocal-1":0.72}}}
iem.event {"protocolVersion":1,"type":"level","requestId":"n-2","generation":4,"mixId":"vocalist","sourceId":"vocal-1","value":0.61}
iem.event {"protocolVersion":1,"type":"error","requestId":"n-2","generation":4,"code":"LIVE_OBJECT_UNAVAILABLE","message":"..."}
```

Requirements for the adapter:

- validate protocol version, message type, ID membership, generation, and
  finite values on both sides;
- use monotonically unique request IDs and timeouts; correlate a response with
  the request but accept unsolicited observer `level` events;
- discard events from an old mapping generation after a re-scan;
- never include Ableton mappings in browser/SSE payloads or echo raw Max errors
  containing unrelated Set/device data;
- serialize all messages as one JSON object; do not use `eval` or build Max
  object paths from unescaped browser input;
- bound pending requests and message sizes, and fail pending promises when the
  Max device stops;
- expose sanitized bridge statuses through the existing server bridge contract.

The protocol is an internal boundary and may be adjusted during implementation,
but the server-facing contract in [`architecture.md`](architecture.md) must stay
the same for `MockBridge` and `MaxBridge`.

## Implementation TODOs

The following work is required before `BRIDGE_MODE=max` may exist:

1. Add a server-side `MaxBridge` implementing `start`, `stop`, `setLevel`,
   `getSnapshot`, and the documented `status`/authoritative `level` events.
2. Make Node for Max bootstrap the same config loader, mixer service, static
   HTTP/SSE server, and `MaxBridge` used by mock mode. Resolve filesystem paths
   from the device/project location, not the terminal's working directory.
3. Replace the scaffold's print sink with a Max-side controller/abstraction that
   implements the all-or-nothing Live API mapping and observer lifecycle above.
4. Implement request correlation, mapping generations, timeouts, startup/shutdown,
   rescan, safe error serialization, and unchanged-value read-back.
5. Add pure tests for message validation and `MaxBridge` state transitions using
   a fake Max transport. Ableton-dependent behavior remains a manual integration
   test.
6. Add an explicit real-mode startup switch. Unknown bridge modes must fail at
   startup; real mode must never silently fall back to mock.
7. Re-run normal server tests unchanged to prove the bridge substitution did
   not weaken authorization, clamping, or SSE semantics.

## Manual `.amxd` packaging steps

Do this only after the TODOs above are implemented and reviewed:

1. Work in a copy of the target Live Set with playback stopped, master output
   safely controlled, and no audience/performer monitoring connected.
2. Open Ableton Live Suite and confirm Max for Live is installed. Create an
   empty MIDI track named `IEM REMOTE BRIDGE`; choose its routing manually.
3. From Live's browser, drag a blank **Max MIDI Effect** onto that track and
   press its **Edit** button to open the device patcher in Max.
4. In Max, open `ableton/iem-remote-bridge-scaffold.maxpat` as a second patcher.
   Copy its boxes into the blank device patcher. Keep the red scaffold warning
   until the print sink has been replaced by the reviewed Live API controller.
5. Add `ableton/node-for-max-adapter.cjs` and every completed controller/
   abstraction to the Max project/device dependencies. Ensure `node.script`
   resolves the adapter by its packaged relative name; remove absolute developer
   machine paths.
6. Save the editable patch source separately as `.maxpat`. From the patcher that
   belongs to the Live device, choose **Save As**, name the device
   `Ableton IEM Remote.amxd`, and save it under the User Library's Max MIDI
   Effect area (or the band's versioned device directory).
7. Use Max for Live's **Freeze Device** command/snowflake control so JavaScript
   and other dependencies are collected with the device, then save again.
   Command placement differs slightly by Max version; verify the dependency
   list shows no path into this repository or another user's home directory.
8. Close the editor, remove the device from the test track, and load the saved
   `.amxd` fresh from the Live browser. Confirm the Node script and every
   abstraction load without missing-file errors.
9. Disconnect internet access and restart Live. Confirm the device, server,
   phone assets, configuration, and Max resources still load completely offline.
10. Keep the `.maxpat`/JavaScript as source control truth. If distributing the
    tested `.amxd`, label it with the matching commit/config/version and retain
    a checksum so the show laptop receives the tested artifact.

Packaging proves resource collection, not mapping correctness. Continue with
the full checklist below.

## Manual integration test checklist

Run against the exact Ableton Live, Max, operating system, audio interface, and
show Set versions intended for use. Record the date/version/result for every
item.

### Safe setup and baseline

- [ ] Use a copied test Set, stopped transport, safely muted/controlled outputs,
  and backed-up show config.
- [ ] Run `npm test` and `npm run check` on the packaged source revision.
- [ ] Confirm every configured normal source and return exists exactly once and
  uses exact case/spacing.
- [ ] Confirm the device changed no routing, track order, return order, monitor
  mode, track volume, transport state, or front-of-house parameter.
- [ ] Start the packaged device offline; confirm it reports connecting, resolves
  all sends, publishes one initial snapshot, then reports connected.
- [ ] Compare every browser value with the corresponding Live send manually.

### Writes, observers, and isolation

- [ ] For every member and every source, move the phone fader to minimum, a
  middle value, and maximum; verify only that source-to-member send changes.
- [ ] Verify the adjacent return send, another member's same source, track
  volume, and master/FOH paths do not move.
- [ ] Make a direct Live send edit and verify all browsers viewing that mix
  receive the authoritative normalized value.
- [ ] Open two clients on one mix, drag rapidly in each direction, and verify
  both settle on Live's final value without freezing Live's UI/audio engine.
- [ ] Set a fader to its existing value and verify the request completes through
  read-back even if no observer callback fires.
- [ ] Reset each member separately; compare every result with that member's
  configured starts and verify no other mix changes.
- [ ] Try cross-mix, unknown source/member/mix, malformed JSON, non-number, and
  out-of-range writes; verify rejection/clamping occurs before Live control.

### Mapping failure safety

- [ ] Rename one configured source; verify the entire bridge becomes
  disconnected with a clear missing-source error and all writes stop.
- [ ] Duplicate one configured source name; verify a hard ambiguous-source
  error. Confirm it never chooses the first/lowest-index track.
- [ ] Repeat missing and duplicate tests for a configured return track.
- [ ] Reorder source tracks and returns; verify a disconnect/re-scan derives
  fresh send objects by exact names and never changes the wrong send.
- [ ] Insert/delete a return, undo/redo it, delete/recreate a source, and reload
  the Set; verify stale object IDs/generations are rejected.
- [ ] Disable/remove the device or make a send parameter unavailable during a
  write; verify no optimistic level is broadcast as authoritative.
- [ ] Restore valid names and invoke/rely on re-scan; verify connection returns
  only after a complete fresh snapshot.

### Network and lifecycle

- [ ] Disconnect and reconnect one phone; Live retains the last value and the
  phone receives a fresh snapshot.
- [ ] Background/lock a phone long enough for SSE to pause; foreground it and
  verify automatic reconnection/convergence.
- [ ] Stop/restart the Node-for-Max process/device while phones remain open;
  verify explicit bridge status and no writes while unavailable.
- [ ] Restart Live and reload the Set; verify observer cleanup (no duplicate
  events) and exact fresh mapping.
- [ ] Exercise the actual hotspot with all five phones for a rehearsal-length
  run while watching CPU, Live's audio performance, errors, and reconnects.
- [ ] Confirm laptop sleep, firewall, VPN, phone Wi-Fi/mobile-data behavior, and
  port/IP runbook settings are show-safe.

Real mode is ready for rehearsal only when all checks pass. It is ready for a
show only after a full-band rehearsal on the production hardware and Set.
