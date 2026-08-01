# Configuration reference

The server loads [`config/band.json`](../config/band.json) at startup. Set the
`CONFIG_PATH` environment variable to use another file. Configuration is
validated before the server starts; an invalid file is a hard error rather than
a partially working mixer.

## Shape

```json
{
  "version": 1,
  "server": {
    "host": "0.0.0.0",
    "port": 3000,
    "writeCoalesceMs": 40,
    "requestBodyLimitBytes": 16384
  },
  "levels": {
    "minimum": 0,
    "maximum": 1
  },
  "members": [
    { "id": "vocalist", "name": "Vocalist", "mixId": "vocalist" }
  ],
  "mixes": [
    {
      "id": "vocalist",
      "name": "Vocalist IEM",
      "abletonTrack": "IEM MIX - Vocalist"
    }
  ],
  "sources": [
    {
      "id": "vocal-1",
      "name": "Vocal 1",
      "abletonTrack": "IEM SRC - Vocal 1",
      "startingLevels": { "vocalist": 0.72 }
    }
  ]
}
```

## Fields and invariants

- `version` selects the schema. This release accepts schema version `1`.
- `server.host` is the bind address. `0.0.0.0` permits phones on the local
  network; `127.0.0.1` restricts access to the laptop.
- `server.port` is the local HTTP port. `PORT` can override it at runtime.
- `server.writeCoalesceMs` is the short per-control bridge-write window used
  while dragging a fader.
- `server.requestBodyLimitBytes` caps JSON request bodies.
- `levels.minimum` and `levels.maximum` are finite normalized safety limits and
  must satisfy `0 <= minimum < maximum <= 1`. Incoming finite writes are
  clamped here.
- Every `member.id`, `mix.id`, and `source.id` is a stable, URL-safe API
  identifier of at most 64 characters. It must contain only lowercase letters,
  digits, and single separating hyphens, and be unique within its collection.
  Do not change an ID just to change a display label.
- `name` fields are user-facing, trimmed, non-empty, at most 100 characters,
  contain no control characters, and are unique within their collection.
- Every `member.mixId` must identify exactly one configured mix. Multiple
  members should not share a mix in this first identity model.
- `mix.abletonTrack` is the exact, case-sensitive name of one Ableton return
  track. It is never sent to browsers.
- `source.abletonTrack` is the exact, case-sensitive name of one normal Ableton
  source track. It is never sent to browsers.
- Every source must provide one `startingLevels` entry for every configured mix
  ID, with no unknown mix keys. Each value must be finite and within the global
  level bounds.

The exact-name mapping has two independent kinds of uniqueness: names should be
unique in configuration, and each configured name must resolve to exactly one
Live object. The future real bridge must reject zero or multiple exact matches
in the Live Set. It must not choose the first duplicate or fall back to a saved
track/return index.

## Safe editing workflow

1. Stop the server.
2. Back up the known-good config and Live Set.
3. Edit labels, IDs, mappings, bounds, and starting values intentionally.
4. Make Live source/return names match `abletonTrack` byte-for-byte, including
   capitalization and spaces. The recommended convention is:

   - source tracks: `IEM SRC - <source>`
   - monitor return tracks: `IEM MIX - <member>`

5. Run `npm test` and `npm run check`.
6. Start with `npm start`; startup validation will report the failing field if
   the JSON shape or relationships are invalid.
7. In mock mode, select every member and test a write plus reset. For a future
   real bridge, complete the full manual Ableton checklist before rehearsal.

Changing `levels` or `startingLevels` never changes Ableton routing. A reset is
an explicit member action and writes that member's configured starting values;
server restart alone only resets the in-memory mock.

## Runtime overrides

```sh
CONFIG_PATH=/absolute/path/to/band.json npm start
HOST=127.0.0.1 PORT=3100 npm start
BRIDGE_MODE=mock npm start
```

`BRIDGE_MODE` defaults to `mock`. Treat any future real-mode value as
unsupported until the Max adapter described in the integration guide exists
and passes its manual tests.
