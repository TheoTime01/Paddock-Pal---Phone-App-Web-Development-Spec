# Development

Implementation of the spec in [README.md](./README.md). Section numbers below refer to it.

## Running it

```bash
npm install
npm test                 # 67 tests: protocol, tracking, adaptive, worker, failure domains
npm run dev              # Vite on :5173, proxying /api to :8787
npm run worker:dev       # the session broker, in a second terminal
npm run build            # -> dist/, deployable to Cloudflare Pages
```

The capture page needs **Chrome on Android over HTTPS** (camera, wake lock, Web Bluetooth).
`npm run dev` binds to the LAN so the turret phone can reach your laptop; for Web Bluetooth
and the wake lock you need a secure context, so use a tunnel or a Pages preview deployment
rather than plain `http://192.168.x.x`.

### Configuring the broker

The Cloudflare Stream API token lives in the Worker only (§1). Never in `.env`, never in
client JS, never in a `VITE_` variable — anything prefixed `VITE_` is compiled into the
bundle and is therefore public.

```bash
wrangler kv namespace create SESSIONS          # put the id in wrangler.toml
wrangler secret put CF_STREAM_TOKEN            # needs Stream:Edit
# set CF_ACCOUNT_ID in wrangler.toml [vars]
```

`tests/worker.test.js` asserts the token and the Live Input uid never appear in a response body.

## What is built

| Build order (§7) | State |
|---|---|
| 1. Worker + `/api/session`, WHIP page, `/watch/:id` | done — `worker/index.js`, `src/capture/whip.js`, `src/watch/main.js` |
| 2. Preflight screen | done — `src/capture/preflight.js`, runs the real path for 15 s |
| 3. Tracker worker offline | done — `src/capture/tracker.worker.js`; `createScriptedDetector` replays fixtures without a camera |
| 4. `shared/protocol.js` + fake transport | done — `src/shared/protocol.js`, `src/capture/fake-transport.js` |
| 5. `ble-transport.js` | done — `src/capture/ble-transport.js` |
| 6. Failure-domain tests | done as a suite — `tests/failure-domains.test.js`; the field test is still owed |

Steps 1–4 need no turret at all, which is why **"Use fake turret (dev)"** on the capture page
attaches a simulated ESP32 that honours §5.6: it clamps the requested rate against its own
maximum, generates its own trajectory from the targets it receives, and holds position (never
returns home) after a 1000 ms command timeout.

## Layout

```
src/
  shared/protocol.js     §5 encode/decode — SINGLE SOURCE OF TRUTH for byte layouts
  shared/tracking.js     §2.4 ROI, px/deg calibration, control law, loss escalation
  shared/adaptive.js     §3.4 the one place the degradation policy lives
  capture/               camera, WHIP, transports, tracker worker, orchestration
  watch/main.js          §4 WHEP receiver
worker/index.js          §3.1 session broker — holds the CF token
tools/gen-esp32-header.js  generates the firmware header from protocol.js
tests/                   vitest, no browser required
```

`src/shared/protocol.js` is the only place byte layouts appear. The ESP32 header is generated
from it rather than hand-written twice:

```bash
npm run protocol:header -- ../firmware/include/paddock_protocol.h
```

The generated header carries `_Static_assert`s on every packet size, so a drift between the
two sides fails the firmware build instead of the field test.

## The two rules that shape the code

**Tracking must not be able to kill the stream (§2.1).** The tracker runs in a Web Worker;
`main.js` supervises and restarts it. Nothing on the tracking path — worker messages, BLE
callbacks, detector exceptions — can reach the `RTCPeerConnection`. `tests/failure-domains.test.js`
mechanises the bench test the README demands before any field test.

**Streaming is the product; detection rate is what gives way (§3.4).** `adapt()` in
`shared/adaptive.js` is the only function that decides this. On `cpu` it raises
`detectIntervalMs`; on `thermal` it raises it further and only drops `maxBitrate` once
detection is already at its 2 Hz floor.

## Still owed

- Field tests at real venues, starting with the preflight screen (§7 step 2 — the highest-risk
  unknown, and it needs no hardware).
- Detection thresholds and ROI sizing tuned against recorded arena footage, indoor and outdoor
  as separate test sets. The scripted detector and the pure tracking module make this a test
  fixture rather than a rebuild.
- `relay-transport.js` for iOS — the interface is fixed, the implementation is not written.
- Auth on `/watch/:id` if sessions need to be private. The WHEP playback URL is public: anyone
  with the link can watch, and the URL being unguessable is not a control (§3.1).
