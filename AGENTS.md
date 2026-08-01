Build an initial working version of this entire project.

# Project

Repository name: `ableton-iem-remote`

This is a local web application for our five-member band. Ableton Live runs the live show from one laptop. Each band member should be able to open a web interface on their phone and adjust only the Ableton send levels belonging to their own in-ear monitor mix.

The system must work locally without internet. Initially, the Ableton laptop will create a Wi-Fi hotspot and all phones will connect to it.

Audio never passes through the phones or web server. The phones only control Ableton mixer parameters.

# Technical direction

Keep the project as vanilla and understandable as reasonably possible.

Use:

* Plain HTML
* Plain CSS
* Plain browser JavaScript
* Plain Node.js
* Node built-in modules wherever practical
* Max for Live for communication with Ableton
* JSON configuration
* One GitHub repository

Avoid unless absolutely necessary:

* React
* Vue
* TypeScript
* Tailwind
* Laravel or PHP
* Next.js
* Databases
* Cloud services
* Native mobile apps
* Complicated build tooling
* Unnecessary npm dependencies

Use regular HTTP requests from browser to server for parameter changes. Use Server-Sent Events for server-to-browser updates unless testing proves WebSockets materially simpler or more reliable.

Node for Max may run the local HTTP server. It should communicate with the Max patch through the provided `max-api` module. The Max for Live side should use Live API objects such as `live.path`, `live.object`, and observers to control and read Ableton mixer send parameters.

# Repository structure

Use an approximately similar structure, changing it if there is a concrete technical reason:

* `ableton/` — editable Max for Live source and device-related files
* `server/` — local Node server
* `public/` — phone interface
* `config/` or `config.json` — band, source and monitor mappings
* `test/` — tests
* `docs/` — architecture and Ableton setup documentation
* `AGENTS.md` — durable repository development instructions
* `README.md`

Do not fabricate an invalid binary `.amxd` file. Keep the Max patch in an editable source format if creating the final device requires opening or saving it through Max. Document the exact manual packaging step.

# Functional requirements

## Members and monitor mixes

Support five members initially:

* Vocalist
* Guitarist 1
* Guitarist 2
* Bassist
* Drummer

The names must be configurable rather than permanently hard-coded.

Each member has one dedicated mono IEM mix represented by an Ableton return track or another clearly documented monitor bus.

Every source track can have an independent send level to every member’s monitor bus.

Potential sources include:

* Vocal 1
* Vocal 2
* Guitar 1
* Guitar 2
* Bass
* Kick
* Snare
* Backing tracks
* Click

All sources and mappings must come from configuration.

## Phone interface

The interface must be designed primarily for phones in portrait mode.

It should provide:

* A simple member-selection screen for the first version
* A mixer screen showing only the selected member’s controls
* Large touch-friendly vertical faders
* Source names
* Current level values
* A visible connected/disconnected indicator
* Automatic reconnection
* A reset-to-starting-mix button with confirmation
* Clear errors when Ableton or the bridge is unavailable

Do not expose:

* Ableton transport
* Playback controls
* Other members’ monitor mixes
* Track routing
* Front-of-house output controls
* Global Ableton settings

## Permissions

Permissions must be enforced by the server, not only hidden in the interface.

A member may only change the monitor mix assigned to them. Invalid member, source, mix and value combinations must be rejected.

The first internal version does not require real user accounts. Member-specific URLs, selections or simple PINs are acceptable. Keep the identity mechanism easy to replace later.

## Synchronization

When one client changes a fader:

1. The server validates the request.
2. The Max for Live bridge changes the corresponding Ableton parameter.
3. The resulting authoritative value is broadcast to connected clients.
4. Any other browser showing that mix updates accordingly.

If a phone disconnects, Ableton must retain the last valid value.

The server should also receive changes made directly inside Ableton and broadcast those changes to the browsers.

## Ableton mapping

Prefer resolving tracks and monitor buses from configured names rather than permanently relying on track indices.

Detect and report:

* Missing configured tracks
* Missing monitor buses
* Duplicate ambiguous names
* Unavailable Live API objects
* Bridge disconnection

Do not silently control the wrong parameter.

Document a recommended Ableton naming convention, for example:

* Source tracks: `IEM SRC - Vocal 1`
* Monitor buses: `IEM MIX - Vocalist`

The user has Ableton Live Suite, so Max for Live is available.

## Level handling and safety

Use normalized values internally where appropriate, but show useful level values in the UI.

Implement configurable minimum, maximum and starting levels. Do not let a malformed request exceed configured limits.

Throttle or coalesce rapid fader changes so dragging a fader does not flood Ableton’s main thread.

Do not change audio routing automatically.

## Mock mode

The web application must be independently testable before the Max for Live bridge is complete.

Provide a mock mode that:

* Runs with a normal Node command
* Simulates Ableton send values
* Supports multiple browser connections
* Demonstrates real-time synchronization
* Uses the same API contract as the real bridge

## Testing

Use Node’s built-in test runner when practical.

At minimum, test:

* Configuration validation
* Permission enforcement
* Level clamping
* Invalid request handling
* State synchronization logic
* Mock bridge behaviour

Provide commands for running and testing the project.

# Expected workflow

First:

1. Inspect the repository.
2. Create `PROJECT.md` summarizing this specification.
3. Create a concise `AGENTS.md` containing durable development rules and verification commands.
4. Produce a short phased implementation plan.
5. Identify assumptions or technical risks.

Then implement the project rather than stopping after the plan.

Suggested phases:

1. Configuration model and mock server
2. Mobile web interface
3. Synchronization and validation
4. Max for Live bridge
5. Documentation and tests

Complete everything that can be implemented and tested without access to a running Ableton installation. Clearly mark the point where I must open Ableton or Max and perform a manual integration test.

Do not add frameworks or production dependencies without explaining why they are needed. Run relevant tests after changes and report what works, what remains unverified, and the exact next manual Ableton testing steps.
