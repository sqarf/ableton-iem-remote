# HTTP and Server-Sent Events API

The browser and server use same-origin plain HTTP on the isolated band network.
There is no CORS API, account/session token, WebSocket, database, or internet
dependency. JSON endpoints use `Cache-Control: no-store`.

This is the shared mock/real contract. Mock-specific external-change simulation
exists only on the in-process `MockBridge` for tests; it is deliberately not an
HTTP endpoint exposed to phones.

All IDs below are stable IDs from `GET /api/config`, not display labels or
Ableton track names. A member-scoped endpoint authorizes the configured
`memberId -> mixId` relationship before reading or changing state.

## Common objects

Bridge status:

```json
{
  "state": "connected",
  "connected": true,
  "message": "Mock Ableton bridge connected"
}
```

`state` is one of `stopped`, `connecting`, `connected`, `disconnected`, or
`error`. Only `connected: true` permits writes.

Member/mix state (also the SSE `snapshot` payload):

```json
{
  "memberId": "vocalist",
  "mixId": "vocalist",
  "revision": 0,
  "levels": {
    "vocal-1": 0.72,
    "vocal-2": 0.48
  },
  "bridge": {
    "state": "connected",
    "connected": true,
    "message": "Mock Ableton bridge connected"
  }
}
```

The real response contains every configured source. `revision` increases per
mix whenever a confirmed value actually changes.

Authoritative level update (the PUT response and SSE `level` payload):

```json
{
  "memberId": "vocalist",
  "mixId": "vocalist",
  "sourceId": "vocal-1",
  "value": 0.61,
  "revision": 1
}
```

## Endpoints

### `GET /api/health`

Returns HTTP `200` while the bridge is connected:

```json
{
  "ok": true,
  "bridge": {
    "state": "connected",
    "connected": true,
    "message": "Mock Ableton bridge connected"
  }
}
```

Returns HTTP `503` with `ok: false` and the current status when the bridge is
not connected. This tests bridge readiness as well as HTTP reachability.

### `GET /api/config`

Returns browser-safe configuration:

```json
{
  "version": 1,
  "levels": { "minimum": 0, "maximum": 1 },
  "members": [
    { "id": "vocalist", "name": "Vocalist", "mixId": "vocalist" }
  ],
  "mixes": [
    { "id": "vocalist", "name": "Vocalist IEM" }
  ],
  "sources": [
    { "id": "vocal-1", "name": "Vocal 1" }
  ],
  "bridge": {
    "state": "connected",
    "connected": true,
    "message": "Mock Ableton bridge connected"
  }
}
```

Arrays contain the full configured set. Ableton names, server settings, and
starting levels are intentionally omitted.

### `GET /api/members/:memberId/mixes/:mixId/state`

Returns the current authoritative member/mix state object. Unknown members and
mixes return `404`; a known member paired with another member's mix returns
`403 MIX_FORBIDDEN`.

### `PUT /api/members/:memberId/mixes/:mixId/sources/:sourceId`

Requires exactly this JSON object and `Content-Type: application/json`:

```json
{ "value": 0.61 }
```

`value` must be a finite JSON number. An out-of-range finite number is clamped
to the configured minimum/maximum. Strings, `null`, arrays, objects, malformed
JSON, an omitted `value`, or extra keys are rejected. The response waits for
write coalescing and bridge confirmation, then returns the authoritative level
update object. A non-connected bridge returns `503 BRIDGE_UNAVAILABLE`.

Rapid concurrent requests to the same mix/source may be coalesced; all
coalesced callers receive the final confirmed update. Other mix/source keys are
handled independently.

### `POST /api/members/:memberId/mixes/:mixId/reset`

Send no body. The server writes every source's configured starting value for
that mix through the same validated/coalesced/authoritative bridge path. The
response is the complete member/mix state after all writes resolve. The reset
does not affect another mix.

### `GET /api/events?memberId=:memberId&mixId=:mixId`

Opens an SSE stream after authorizing the member/mix pair. Missing query values
return `400`; unknown/forbidden IDs use the same errors as the state endpoint.
The response begins with:

```text
retry: 2000

event: snapshot
data: {"memberId":"vocalist","mixId":"vocalist","revision":0,"levels":{...},"bridge":{...}}

```

Subsequent confirmed changes for that exact mix are:

```text
event: level
data: {"memberId":"vocalist","mixId":"vocalist","sourceId":"vocal-1","value":0.61,"revision":1}

```

Bridge lifecycle changes are:

```text
event: status
data: {"bridge":{"state":"disconnected","connected":false,"message":"..."}}

```

The server sends `: keepalive` comments every 15 seconds. Browsers should use
`EventSource`, listen to the three named events, and allow its automatic
reconnect. The advertised retry is 2000 ms. There are no durable event IDs or
event replay; each new connection receives a fresh authoritative snapshot, so
clients should replace local state from that snapshot. An existing stream also
receives a new complete `snapshot` after a real-bridge rescan finishes, so it
can atomically replace values from the previous mapping generation.

## Errors

Errors use one shape:

```json
{
  "error": {
    "code": "MIX_FORBIDDEN",
    "message": "Member \"vocalist\" may only access mix \"vocalist\""
  }
}
```

Some errors may add a `details` field. Clients should branch on `code`, display
a safe `message`, and not parse message prose. Current codes include:

- `INVALID_PATH`, `INVALID_QUERY`, `INVALID_JSON`, `INVALID_REQUEST`, `REQUEST_ABORTED`
- `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `METHOD_NOT_ALLOWED`
- `API_NOT_FOUND`, `NOT_FOUND`, `PATH_FORBIDDEN`
- `MEMBER_NOT_FOUND`, `MIX_NOT_FOUND`, `MIX_FORBIDDEN`, `SOURCE_NOT_FOUND`
- `INVALID_LEVEL`, `BRIDGE_UNAVAILABLE`, `SERVICE_UNAVAILABLE`,
  `SERVICE_STOPPED`
- `INTERNAL_ERROR` for an unexpected server failure

HTTP status meanings are conventional: malformed input `400`, forbidden mix
`403`, unknown resource `404`, wrong method `405`, oversized body `413`, wrong
content type `415`, and unavailable bridge/service `503`.

## Curl examples

```sh
curl -s http://127.0.0.1:3000/api/config

curl -N 'http://127.0.0.1:3000/api/events?memberId=vocalist&mixId=vocalist'

curl -i -X PUT \
  -H 'Content-Type: application/json' \
  --data '{"value":0.61}' \
  http://127.0.0.1:3000/api/members/vocalist/mixes/vocalist/sources/vocal-1

curl -i -X POST \
  http://127.0.0.1:3000/api/members/vocalist/mixes/vocalist/reset
```

See [`operations.md`](operations.md) for a complete mock smoke test, including
a deliberate cross-mix denial and multi-browser synchronization.
