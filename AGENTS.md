# Development rules

`PROJECT.md` is the source of truth for product scope. Keep this repository understandable to a band member who knows basic JavaScript.

- Use plain Node.js, HTML, CSS, browser JavaScript, and JSON. Prefer Node built-ins and do not add runtime dependencies without documenting the concrete need.
- Keep all audio in Ableton. This application only reads and changes configured send parameters.
- Treat configured IDs as stable API identifiers and configured Ableton names as exact, case-sensitive mappings. Never fall back to a track index or silently choose an ambiguous match.
- Enforce member-to-mix permissions in server code on every read or write. Browser visibility is not authorization.
- Validate and clamp level writes before they reach a bridge. Coalesce rapid writes, and broadcast only bridge-confirmed authoritative values.
- Keep Ableton communication behind the bridge contract in `server/bridges/`. Mock and Max for Live modes must use the same server-facing contract.
- Do not generate a fake `.amxd`. Store editable Max/Node-for-Max sources and document the manual Max packaging step.
- Add or update tests for configuration, authorization, validation, synchronization, and bridge behavior whenever those areas change.

Verification commands:

```sh
npm test
npm run check
npm start
```

The default `npm start` mode is the offline mock bridge. Before handing off a change, run the relevant tests and a local HTTP/SSE smoke check.
