# Offline operation and mock smoke test

## Start on the laptop

Install Node.js 20 or newer before going offline. This repository has no
runtime package dependencies, CDN assets, database, or cloud service.

```sh
npm test
npm run check
npm start
```

Leave the terminal open. By default the server listens on port `3000`, binds to
`0.0.0.0`, and uses the mock bridge. On the laptop, open
<http://127.0.0.1:3000>.

Useful explicit overrides:

```sh
HOST=127.0.0.1 PORT=3100 BRIDGE_MODE=mock npm start
CONFIG_PATH=/absolute/path/to/band.json npm start
```

## Connect phones over the hotspot

1. On the Ableton laptop, create/enable the intended Wi-Fi hotspot or Internet
   Sharing network. Use a strong password and do not bridge it to a public LAN
   unless necessary.
2. Connect every phone to that SSID. Disable mobile-data/VPN behavior that
   automatically abandons Wi-Fi networks without internet.
3. Find the laptop's IP address on the hotspot interface in the operating
   system's Network settings. Do not assume it remains the same after recreating
   the hotspot.
4. On each phone open `http://<laptop-ip>:3000`, select only that member, and
   keep the page available during rehearsal.
5. If macOS asks whether Node/Terminal/Max/Ableton may accept incoming
   connections, allow it on the trusted band network. A restrictive firewall
   must permit inbound TCP to the configured port.

Do not publish or router-forward this port. Member selection is not a password.
Some managed access points enable client isolation, which can prevent phones
from reaching the laptop or one another; disable isolation for this private
network or use a suitable dedicated router.

For show use, power the laptop, disable automatic sleep, prevent the hotspot
from being suspended, and rehearse phone screen-lock/background behavior.
Mobile browsers can pause network activity while backgrounded; returning to the
page should reconnect SSE and receive a fresh authoritative snapshot.

## API smoke test

With `npm start` running in another terminal:

```sh
curl -i http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/config
curl -s http://127.0.0.1:3000/api/members/vocalist/mixes/vocalist/state
```

Keep an SSE stream open in another terminal:

```sh
curl -N 'http://127.0.0.1:3000/api/events?memberId=vocalist&mixId=vocalist'
```

Then request a level and a reset:

```sh
curl -i -X PUT \
  -H 'Content-Type: application/json' \
  --data '{"value":0.61}' \
  http://127.0.0.1:3000/api/members/vocalist/mixes/vocalist/sources/main-vocals

curl -i -X POST \
  http://127.0.0.1:3000/api/members/vocalist/mixes/vocalist/reset
```

The SSE terminal should show named `level` events for confirmed values. The
reset should produce one confirmed update for each source whose value changes.

Verify server-side permission enforcement by deliberately pairing a member
with someone else's mix:

```sh
curl -i -X PUT \
  -H 'Content-Type: application/json' \
  --data '{"value":0.5}' \
  http://127.0.0.1:3000/api/members/vocalist/mixes/drummer/sources/main-vocals
```

That request must return an authorization/client error and must not emit a
drummer level event. Values such as `2` or `-1` are finite and are clamped to
the configured bounds; strings, `null`, malformed JSON, and non-finite numbers
must be rejected.

## Multi-browser synchronization test

1. Open the same member/mix in two browser windows or phones.
2. Move one fader repeatedly in the first browser.
3. Confirm the second browser converges to the authoritative value without a
   reload and the server remains responsive.
4. Disconnect/reconnect Wi-Fi on the second phone. Its status should show the
   interruption, reconnect automatically, and refresh from a snapshot.
5. Trigger reset, confirm it, and verify both browsers update.
6. Select another member in a third client. Writes for the first member must not
   alter that other member's mix.

Stopping the mock server discards its in-memory state. It does not touch any
Live Set.

## Real bridge operation

Do not run `npm start` beside the real device on the same port. In real mode,
the Max for Live device's `node.script` starts this same HTTP/SSE application
inside Node for Max. The browser URL and API smoke commands remain unchanged.

The patch exposes explicit server start, stop, rescan, and status messages. A
rescan stops writes, discards the old mapping generation, resolves every exact
name/send again, installs fresh observers, reloads authoritative snapshots, and
then allows existing SSE clients to converge. The server may remain reachable
while health is `503`; that means the web process is alive but the complete Live
mapping is intentionally unavailable.

For the first connection and the show-device packaging procedure, follow
[`max-for-live-integration.md`](max-for-live-integration.md). Normal mock mode
is still the fastest way to test phones and networking without Live.
