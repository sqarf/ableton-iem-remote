# Ableton IEM Remote

## Product goal

Build a local-only phone mixer for a five-member band. Ableton Live Suite runs the show on one laptop, which also hosts this web application and initially provides the Wi-Fi hotspot. Phones send control data only; no audio passes through the phones or web server.

Each member chooses their identity and sees only the source sends feeding their dedicated mono in-ear monitor mix. All member names, source tracks, monitor buses, limits, and starting levels are JSON configuration rather than application constants.

## Initial members and sources

The example configuration contains Vocalist, Guitarist 1, Guitarist 2, Bassist, and Drummer, with independent sends from Vocal 1, Vocal 2, Guitar 1, Guitar 2, Bass, Kick, Snare, Backing Tracks, and Click. These are editable examples, not hard-coded requirements.

Recommended exact Ableton names are `IEM SRC - <source>` for source tracks and `IEM MIX - <member>` for return-track monitor buses.

## Functional scope

- A portrait-first member-selection screen and touch-friendly vertical-fader mixer.
- Source labels, useful current values, connection/bridge status, automatic SSE reconnection, actionable errors, and a confirmed reset to configured starting levels.
- Regular HTTP level/reset writes and Server-Sent Events for snapshots, authoritative level changes, and bridge status.
- Server-side validation of member, mix, source, and finite numeric value combinations. A member route can address only the mix assigned to that member.
- Configurable normalized minimum, maximum, and per-member starting values. Out-of-range finite writes are clamped. Rapid changes are coalesced before bridge calls.
- A dependency-free mock bridge supporting multiple browsers, persistent in-process values, and simulated external Ableton changes through the same event contract used by a future Max bridge.
- Detection and clear reporting of bridge disconnection. The Max implementation must also reject missing or duplicate track/bus names and unavailable Live API objects rather than risk controlling the wrong parameter.
- No transport, playback, routing, front-of-house, or global Ableton controls.

The first internal identity mechanism is explicit member selection. It is not authentication: anyone on the isolated band network can choose a member. Authorization still happens on the server by deriving and checking the member's configured mix for every endpoint. The API shape intentionally leaves room for PIN-backed sessions later.

## Architecture

The browser is served from `public/`. `server/http-server.js` owns the HTTP/SSE boundary, while `server/mixer-service.js` owns authorization, range enforcement, write coalescing, authoritative state, and subscriber events. Bridge adapters live under `server/bridges/`; the server depends only on their small event-driven contract.

`config/band.json` is loaded and fully validated at startup. Public API responses omit Ableton mapping names, so the UI consumes stable IDs and display labels.

The current vertical slice runs through `MockBridge`. A future Node-for-Max adapter will resolve exact source and return-track names with Live API objects, observe send parameter values, and emit confirmed normalized changes. It must not change Ableton routing.

## Phased implementation plan

1. Configuration model, validator, bridge contract, mock state, and Node HTTP server.
2. Mobile member selector and mixer.
3. Permission checks, clamping, coalescing, SSE synchronization, reset, and error states.
4. Editable Max patch and Node-for-Max adapter with exact-name resolution and observers.
5. Ableton integration testing, operational hardening, and optional PIN sessions.

## Assumptions and risks

- Normalized `0..1` is the bridge boundary; the UI displays percent until a Live device can provide trustworthy parameter display strings.
- A process restart resets mock values to configured starts. Ableton itself remains authoritative in real mode and retains values when a phone disconnects.
- Member selection is appropriate only on the isolated band network. PINs or another identity provider are required before use on an untrusted LAN.
- Browser SSE reconnects automatically, but laptop sleep, hotspot client isolation, firewall settings, and phone background throttling need rehearsal testing.
- Ableton send parameters and observer timing must be verified in the exact Live/Max versions used for shows. Duplicate track names are a safety error, never a tie to resolve by index.
- Real Max for Live behavior cannot be certified without opening the editable source in Max, saving the device through Max, loading it in the target Live Set, and exercising every configured mapping.

## Definition of the first vertical slice

The mock app must start with `npm start`, pass Node built-in tests with `npm test`, serve the phone UI, reject invalid or cross-mix access, clamp safe values, coalesce drag traffic, synchronize multiple SSE clients from authoritative bridge events, reset one member's mix, and document the remaining manual Max work.
