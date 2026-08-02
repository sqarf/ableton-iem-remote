# Max for Live integration boundary

## Current status

The real source path is implemented and ready for its first Ableton connection
test:

- `server/bridges/max-bridge.js` validates/correlates the versioned Max
  protocol, owns the active mapping generation, and exposes only confirmed
  values through the normal bridge contract;
- `ableton/node-for-max-adapter.cjs` starts the validated config,
  `MixerService`, HTTP/SSE server, retry/rescan lifecycle, and Max transport
  inside `node.script`;
- `ableton/live-api-controller.js` performs all-or-nothing exact-name mapping,
  installs send-value/topology observers, validates generations, writes only
  known send parameters, and confirms unchanged writes by read-back;
- `ableton/iem-remote-bridge.maxpat` wires that two-way boundary and triggers a
  deferred rescan when `live.thisdevice` becomes ready.

Automated tests exercise configuration, authorization, HTTP/SSE behavior,
bridge validation, stale generations, timeouts, fake-Max resolution, observer
updates, and rescan synchronization. They cannot prove the installed
Ableton/Max `LiveAPI` behavior. No `.amxd` is committed because a trustworthy
device must be opened, saved, frozen, and tested through the target Max for Live
environment.

The checked-in `.maxpat` is currently a **development/source-tree patch**, not
a portable device artifact. Its `node.script` loads the adjacent adapter, and
that adapter derives the application root from its location before importing
code from `server/`, serving assets from `public/`, and loading the selected
file from `config/`. This layout works for the first connection test while Max
loads files from this repository. Max for Live's freeze/resource collection
has not yet been shown to preserve that application layout, so a frozen `.amxd`
must not yet be described as self-contained or portable.

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

The Max-side controller performs a complete transaction before reporting
connected:

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

   The server validates and clamps finite browser writes to the configured
   normalized safety limits before sending a bridge command. As a second line
   of defense, the Max controller validates that every received command is
   already within those limits and rejects an out-of-range command. Do not
   assume all Live/Max versions expose exactly `0..1`.
6. Install a `value` observer for every resolved send. Associate observer
   callbacks with stable `(mixId, sourceId)` IDs—not display names or an array
   position. Read an initial snapshot only after all observers exist.
7. If and only if the entire mapping is valid, atomically publish the snapshot
   and report `connected: true`. A partial mixer is unsafe and must remain
   disconnected.

Names and Live object IDs can become stale after rename, insert/delete,
return-track reorder, undo/redo, Set load, or device reload. The controller
observes topology at low priority and invalidates immediately; the Node runtime
then performs one correlated full stop/resolve/snapshot cycle. The patch also
provides an explicit rescan command. During rebuild, old observers are detached,
the bridge remains disconnected, queued writes fail, and cached IDs are never
reused. Reordering is safe only after fresh exact-name resolution and fresh
send IDs.

## Write and observer responsibilities

For `set-level`:

1. Require the currently connected mapping generation and known stable IDs.
2. Require a finite normalized number already within the configured bounds.
   `MixerService` clamps finite HTTP writes before the bridge boundary; an
   out-of-range Node-to-Max command is a protocol/safety violation and the Max
   controller rejects it instead of silently clamping it again.
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
Every object carries `protocol: "iem-remote"` and `version: 1`.

Node to Max:

```text
iem.command {"protocol":"iem-remote","version":1,"type":"resolve","requestId":"node-1","sources":[{"id":"vocal-1","abletonTrack":"IEM SRC - Vocal 1"}],"mixes":[{"id":"vocalist","abletonTrack":"IEM MIX - Vocalist"}],"levels":{"minimum":0,"maximum":1}}
iem.command {"protocol":"iem-remote","version":1,"type":"set-level","requestId":"node-2","generation":4,"mixId":"vocalist","sourceId":"vocal-1","value":0.61}
iem.command {"protocol":"iem-remote","version":1,"type":"get-snapshot","requestId":"node-3","generation":4}
iem.command {"protocol":"iem-remote","version":1,"type":"stop","requestId":"node-4"}
```

Max to Node:

```text
iem.event {"protocol":"iem-remote","version":1,"type":"status","state":"connecting","connected":false}
iem.event {"protocol":"iem-remote","version":1,"type":"resolved","requestId":"node-1","generation":4,"levels":{"vocalist":{"vocal-1":0.72}}}
iem.event {"protocol":"iem-remote","version":1,"type":"level","requestId":"node-2","generation":4,"mixId":"vocalist","sourceId":"vocal-1","value":0.61}
iem.event {"protocol":"iem-remote","version":1,"type":"error","requestId":"node-2","generation":4,"code":"LIVE_OBJECT_UNAVAILABLE","message":"Send parameter became unavailable"}
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

## What remains before rehearsal

`npm start` remains explicitly mock-only. The current real development entry
point is loading `ableton/node-for-max-adapter.cjs` through `node.script` while
the editable patch resolves files from this repository. It never falls back to
mock.

Code work for the source-tree bridge path is complete for this iteration. The
next gate is environmental validation: load the development patch in a copied
Set, verify every configured exact name/send, and exercise invalidation and
direct Live edits. Portable packaging remains separate work: choose and
implement a frozen resource layout for the adapter plus `server/`, `public/`,
and `config/`; update resource resolution if Max relocates or flattens those
files; and prove the result from a fresh offline load outside the repository.
Only then should the device proceed to the production
laptop/hotspot/audio-interface rehearsal. Any difference found in the target
Live/Max versions should be fixed in the editable sources and covered by a
fake/protocol regression test where possible.

## First development connection test

This is the shortest route to testing Live ↔ web now, before producing a
distributable frozen device:

1. Work in a copied test Set with transport stopped, outputs safely muted or
   disconnected, and `npm start` stopped so port `3000` is free.
2. Use Ableton Live Suite with Max for Live and Max 8.6 or newer (the
   Node-for-Max bootstrap dynamically imports the repository's ES modules).
   Run `npm test` and `npm run check` in this repository.
3. Create the configured normal source tracks and return tracks with the exact,
   case-sensitive names above. Do not substitute ordinary tracks for returns.
4. In Max **File Preferences**, temporarily add this repository's `ableton/`
   directory to the search path. This lets the test device find the adjacent
   controller and Node adapter while the adapter imports `../server`,
   `../public`, and `../config` from the working tree.
5. In Live, create an empty MIDI track named `IEM REMOTE BRIDGE`, add a blank
   **Max MIDI Effect**, and click **Edit**. Open
   `ableton/iem-remote-bridge.maxpat` in Max and copy its boxes/patch cords into
   the blank device patcher.
6. Save that device as a development-only `.amxd`, reload it once, and open the
   Max Console. `node.script` supplies `max-api`; do not install it with npm.
7. Wait for `iem-adapter-status`/`iem-event` logs. Open
   <http://127.0.0.1:3000/api/health>. It must return `200` and
   `connected: true` only after the entire mapping resolves. Then open
   <http://127.0.0.1:3000>.
8. With outputs still controlled, move one browser fader and verify only the
   matching source-to-return send moves. Move that send directly in Live and
   verify the browser follows it. Test one unchanged-value write as well.
9. Rename one configured source temporarily. Health must become unavailable and
   writes must stop. Restore the exact name or press **rescan** in the patch;
   health and a fresh browser snapshot should recover.

If the Max Console reports a missing JavaScript file, fix Max's temporary search
path before changing code. If health stays unavailable, use the controller's
error code to check exact names and duplicate names; never work around it with
track indices.

## Manual `.amxd` packaging steps

These are the remaining packaging acceptance steps, not a claim that the
current patch can already be frozen into a portable device unchanged. In
particular, the Node adapter currently expects the repository/application
directory layout described above. Max may collect device dependencies into a
different frozen layout; if it does, resource discovery in the adapter must be
changed and tested before distribution.

Do this after the source-tree Live connection test succeeds and before
rehearsal:

1. Work in a copy of the target Live Set with playback stopped, master output
   safely controlled, and no audience/performer monitoring connected.
2. Open Ableton Live Suite and confirm Max for Live is installed. Create an
   empty MIDI track named `IEM REMOTE BRIDGE`; choose its routing manually.
3. From Live's browser, drag a blank **Max MIDI Effect** onto that track and
   press its **Edit** button to open the device patcher in Max.
4. In Max, open `ableton/iem-remote-bridge.maxpat` as a second patcher and copy
   its boxes/patch cords into the blank device patcher.
5. Define a packaged application layout containing
   `ableton/node-for-max-adapter.cjs`, `ableton/live-api-controller.js`,
   `server/`, `public/`, and the selected validated config. Add the resources to
   the Max project/device dependencies, then inspect where Max actually places
   them when frozen. Ensure `node.script` resolves the adapter by its packaged
   relative name and that the adapter can resolve every application directory
   from that frozen location; update the adapter's base-path/resource discovery
   if the source-tree `../server`, `../public`, and `../config` relationship is
   not retained. Remove absolute developer-machine paths.
6. Save the editable patch source separately as `.maxpat`. From the patcher that
   belongs to the Live device, choose **Save As**, name the device
   `Ableton IEM Remote.amxd`, and save it under the User Library's Max MIDI
   Effect area (or the band's versioned device directory).
7. Use Max for Live's **Freeze Device** command/snowflake control so JavaScript
   and other dependencies are collected with the device, then save again.
   Command placement differs slightly by Max version; verify the dependency
   list shows no path into this repository or another user's home directory.
   Freezing alone is not proof of portability: confirm the Node process can
   import the server modules and load the static/config resources from the
   frozen locations.
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
  out-of-range writes. Verify invalid/non-finite input is rejected, finite HTTP
  values are clamped by `MixerService`, and a deliberately out-of-range
  Node-to-Max protocol command is rejected by the Max controller, all before
  Live control.

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
