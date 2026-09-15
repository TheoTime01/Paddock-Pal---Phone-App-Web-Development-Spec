# Testing process

The automated suite proves the logic. This document covers everything it cannot: real
devices, real uplinks, real Cloudflare, and eventually real hardware. Section numbers
refer to [README.md](./README.md).

Work the phases in order. Each one unblocks the next, and each is cheap to abandon if it
fails — which is the point of the ordering. **Do not skip to a field test.**

## How to report results back

Copy the [results template](#results-template) at the bottom, fill in what you ran, and
paste it back. For each test record **PASS**, **FAIL** or **SKIP** plus the observed
values — the numbers matter more than the verdict, because several of these tests exist
to discover a value nobody knows yet, not to confirm one.

When something fails, send:

1. The test ID (e.g. `T3.2`).
2. What you saw, verbatim where possible — the on-page log lines, the console error.
3. Device and browser: phone model, Android version, Chrome version.

The capture page's log panel is the primary instrument. It records every state
transition, every adaptive change and every turret event with a timestamp. Screenshot it
or copy it out.

### Collecting WebRTC stats

Connect the phone to a laptop, open `chrome://inspect`, and inspect the capture page.
Paste this into the console while streaming to get the fields the tests ask for:

```js
// window.__paddockPal is a debug handle the capture page exposes for this.
const stats = await window.__paddockPal.sender.pc.getStats();
const out = [];
stats.forEach((r) => {
  if (r.type === 'codec') out.push(r);
  if (r.type === 'outbound-rtp' && r.kind === 'video') out.push(r);
  if (r.type === 'remote-inbound-rtp') out.push(r);
});
copy(JSON.stringify(out, null, 2));
```

The same handle answers most questions directly:

```js
__paddockPal.session            // the SESSION state machine's current state
__paddockPal.sender.state       // the STREAM state machine — they are independent
__paddockPal.sender.lastStats   // bitrate, fps, qualityLimitationReason
__paddockPal.detectIntervalMs   // current detection period, raised under load
__paddockPal.control.lastState  // decoded turret State (§5.3): angle, battery, limits
__paddockPal.control.leadSec    // measured loop latency feeding the predictor
```

`chrome://webrtc-internals` gives the same data as graphs if you prefer to screenshot it.

---

## Phase 0 — Automated baseline

Runs anywhere, needs nothing. Do this first every time, so a later failure is never
ambiguous about whether the logic still holds.

### T0.1 Suite passes

```bash
npm install
npm test
```

**Pass:** 69/69 passing. Record the count — if it differs from 69, say so, because that
means the branch moved.

### T0.2 Build is clean

```bash
npm run build
```

**Pass:** builds with no errors, `dist/_redirects` present (that file is what makes
`/watch/:id` resolve).

### T0.3 Generated firmware header

```bash
npm run protocol:header > /tmp/pp.h
printf '#include "/tmp/pp.h"\nint main(void){return 0;}\n' > /tmp/t.c
gcc -std=c11 -c /tmp/t.c -o /tmp/t.o && echo OK
```

**Pass:** compiles. The `_Static_assert`s confirm the packet sizes, so this is the check
that the phone and the firmware agree on §5.

---

## Phase 1 — Session broker against real Cloudflare

Needs a Cloudflare account with Stream enabled. No phone, no turret.

Put credentials in `.dev.vars` (gitignored, never committed):

```
CF_ACCOUNT_ID = "..."
CF_STREAM_TOKEN = "..."
```

Then `npm run worker:dev`.

### T1.1 Health

```bash
curl -s localhost:8787/api/health
```

**Pass:** `{"ok":true,"configured":true}`. `configured:false` means the vars did not load.

### T1.2 Create a session

```bash
curl -sX POST localhost:8787/api/session -H 'content-type: application/json' -d '{}'
```

**Pass:** HTTP 201 with exactly `sessionId`, `whipUrl`, `whepUrl`, `expiresAt`.

**Record the shape of the two URLs** (redact the account id). The tests mock these; nobody
has seen the real ones, and the viewer's behaviour depends on what Cloudflare serves from
them.

### T1.3 The token never leaves the Worker

Search the response body and headers for your token and for any Live Input uid.

**Pass:** neither appears. This is the §1 security rule and it is non-negotiable.

### T1.4 Viewer lookup withholds the WHIP URL

```bash
curl -s localhost:8787/api/session/<sessionId>
```

**Pass:** `whepUrl` present, `whipUrl` absent. A viewer holding the WHIP URL could publish
over the rider's session.

### T1.5 Delete reaps the Live Input

```bash
curl -sX DELETE localhost:8787/api/session/<sessionId>
```

Then open the Cloudflare Stream dashboard.

**Pass:** the Live Input is gone. The suite can only prove the call is made; only the
dashboard proves it worked. Orphans cost money and eventually hit account limits.

### T1.6 Abandoned session

Create a session and do not delete it. Note the time.

**Pass:** the KV record expires per its TTL. **Record whether the Live Input itself is
still present afterwards** — if KV expiry alone does not reap it, we need a scheduled
cleanup Worker, which does not exist yet.

---

## Phase 2 — Laptop browser smoke test

```bash
npm run worker:dev   # terminal 1
npm run dev          # terminal 2
```

Open `http://localhost:5173/capture/`.

### T2.1 Fake turret attaches

Click **Use fake turret (dev)**.

**Pass:** the turret chip shows a live angle, battery and round-trip time, updating about
ten times a second. This exercises the whole §5 path — encode, notify, decode, latency
tracking — with no hardware.

### T2.2 Session starts

Click **Start session** (needs Phase 1 credentials).

**Pass:** a viewer link appears, the stream chip reaches LIVE, and the stats line shows a
bitrate. **Record the time from click to LIVE.**

### T2.3 Viewer page

Open the viewer link in a second browser.

**Pass:** video appears within a few seconds and the quality bars show three bars.

### T2.4 Viewer before the rider starts

Open a viewer link for a session whose capture side is **not** streaming.

**Pass:** the page says *"Waiting for the rider"* and then connects on its own once you
start. **Fail:** a black rectangle, or *"Session ended"*.

> This test matters more than it looks. The WAITING state depends on my assumption that
> Cloudflare answers a WHEP request with 404/405 before a publisher exists. If it answers
> some other way, the logic needs changing — **record the exact status code** from the
> Network tab either way.

### T2.5 Stop cleans up

Click **Stop**, then check the dashboard.

**Pass:** no Live Input left behind, viewer page moves to *"Session ended"*.

---

## Phase 3 — Phone capability report

**This phase is discovery, not verification.** Several values here are unknown to
everyone, and the answers change what gets built next. Needs an Android phone on HTTPS:

```bash
cloudflared tunnel --url http://localhost:5173
```

or deploy a Pages preview. Record phone model, Android version and Chrome version.

### T3.1 Camera constraint locking (§2.2)

Start a session and read the log line beginning `camera locked:`.

**Record verbatim** which of `exposure`, `focus`, `whiteBalance`, `exposureTime` the phone
accepted. Every one is optional on Android. There is no pass/fail — but if the phone
accepts none of them, AE/AF hunting while panning will hurt detection and we need a
different approach.

### T3.2 Frame source

Read the log line `frame source:`.

**Record:** `track-processor` (zero-copy, the good path) or `canvas-fallback` (never yet
executed on any device — if you get this, say so, it needs review).

### T3.3 Negotiated codec

From `getStats()`, find the `codec` report for the outbound video.

**Pass:** `video/H264` with `profile-level-id=42e01f`. **Fail:** VP8 or VP9 — that means
a software encoder, which means heat, which means thermal throttling within the hour.

### T3.4 Wake lock (§2.2)

Start a session, then leave the phone untouched past its screen timeout.

**Pass:** the screen stays on and the stream keeps running. Also try: pull down the
notification shade; receive a call; switch apps briefly and return. **Record what
survives and what does not** — if the wake lock is refused the log says so loudly.

### T3.5 Thermal reporting

Run a session for **50 minutes** — a real lesson length, not a demo.

**Record** every `detection rate →` line from the log, and whether
`qualityLimitationReason` ever reports `cpu` or `thermal` in the stats line.

> If `thermal` never appears, the entire thermal branch of §3.4 is dead code on this
> device and we should drive degradation off something observable instead (frame rate
> collapse, or the Compute Pressure API). This is the most valuable single measurement in
> this document.

### T3.6 Battery and heat

Record battery percentage at start and end of the 50 minutes, and whether the phone
becomes too hot to hold. A turret phone is clamped in the sun.

---

## Phase 4 — Venue preflight (§3.5)

Needs a phone and a venue. **No turret required** — this is the highest-risk unknown in
the project and it needs no hardware, which is why it comes before anything mechanical.

For each venue, run the 15 s preflight on each available uplink.

### T4.1 Uplink matrix

| Venue | Uplink | Verdict | Sustained Mbps | Loss % | fps |
|---|---|---|---|---|---|
| Indoor arena | Venue WiFi | | | | |
| Indoor arena | Cellular | | | | |
| Outdoor | Venue WiFi | | | | |
| Outdoor | Cellular | | | | |

Indoor arenas are steel-clad and often cellular-hostile. A red verdict indoors is a
finding, not a failure.

### T4.2 Sustained vs sampled

Where preflight says green, then run a **full 50-minute** session at that venue.

**Record** whether the bitrate holds. A green 15-second probe that collapses at minute
thirty means the probe duration is wrong and needs raising.

---

## Phase 5 — Failure domains (§6)

**The README requires this before any field test.** Every row of the §6 table is a test;
`tests/failure-domains.test.js` proves the logic, and this proves the isolation is real on
a device.

Run each while **actively streaming**, and watch the viewer page throughout.

### T5.1 Detector throws

Temporarily add to the top of `onFrame` in `src/capture/tracker.worker.js`:

```js
if (Math.random() < 0.01) throw new Error('bench test');
```

**Pass:** video never stops. The log shows `tracker crashed` then `tracker restarted`. The
turret parks at its last angle and shows the LOST face.
**Fail:** any interruption to the video. If this fails, the isolation is not real and
nothing else in this phase matters.

Remove the line afterwards.

### T5.2 BLE drops

Switch the turret off at the wall mid-session.

**Pass:** video unaffected; the turret **holds its position and does not swing home**; the
app logs a disconnect and retries with backoff. The hold is safety-critical — a turret
that snaps around next to a horse is a safety event, not a recovery.

### T5.3 Uplink dies

Turn off WiFi mid-session (or walk out of range).

**Pass:** the stream chip goes RECONNECTING and recovers when the uplink returns.
**Tracking must continue throughout**, so the horse is still framed when video resumes.
**Record the recovery time.**

### T5.4 Tab backgrounded

Switch to another app for 30 seconds and come back.

**Pass:** the wake lock re-acquires and the session survives, or the log warns loudly.

### T5.5 Worker restart limit

Force repeated crashes (raise the probability in T5.1).

**Pass:** after 5 restarts the app gives up on tracking, says so, and **keeps streaming**.

---

## Phase 6 — Tracker accuracy

Needs recorded arena footage, not a live camera — you want a file you can replay while
changing thresholds. Record **separate indoor and outdoor sets**, each with a horse at
roughly 30 m.

### T6.1 Does the detector see a horse at all

The core product risk. At 30 m a horse and rider is about 116 px in a 1280-wide frame;
the ROI crop is what makes that detectable.

**Record** the confidence scores EfficientDet-Lite0 returns for `horse` on your footage.
If they sit below threshold at realistic distances, the model needs replacing with the
fine-tuned YOLOv8n the spec anticipates — better to learn that from a file than from a
paddock.

### T6.2 Acquisition

**Record** how long the tiled sweep takes to lock, and any false locks. Test with
spectators, a second horse, and a horse partly behind a jump.

### T6.3 Calibration

**Record** the `px/deg ≈` values from the log and whether they converge to a stable
number.

### T6.4 Tracking quality

**Record** how often the horse leaves frame at walk, trot and canter, and whether it sits
centred or on the trailing edge. Trailing edge means the lead term is too small.

---

## Phase 7 — Hardware in the loop

Once the ESP32 exists. Out of scope for this repo, but these are the contract's tests.

### T7.1 Packet agreement

Generate the header, build the firmware, confirm the `_Static_assert`s pass and that a
Control packet sent by the phone decodes identically on the ESP32.

### T7.2 Command timeout (§5.6)

Stop the phone mid-motion.

**Pass:** the turret holds after 1000 ms. It must **not** return home.

### T7.3 Firmware clamps the rate

Command 400 deg/s.

**Pass:** the turret moves at its own configured maximum, not the requested rate. Never
trust the phone.

### T7.4 Sustained GATT writes

Run 10 Hz control for a full session.

**Record** any `InvalidStateError` and whether the latest-wins policy holds. Also record
whether `writeValueWithoutResponse` exists on this phone.

### T7.5 Limits and fob

Drive into each software limit; press each fob button.

**Pass:** `at_limit_*` stops the tracker commanding further; fob events reach the app and
re-acquire works from horseback.

### T7.6 Reconnect

Reboot the ESP32 mid-session.

**Pass:** the app reconnects with backoff and **the stream never notices**.

---

## Results template

```
## Test run
Date:
Phone:                        (model / Android / Chrome version)
Venue:
Branch / commit:

### Phase 0 — automated
T0.1 suite            [PASS/FAIL]  tests passing: __/69
T0.2 build            [PASS/FAIL]
T0.3 header compiles  [PASS/FAIL]

### Phase 1 — broker
T1.1 health           [PASS/FAIL/SKIP]
T1.2 create           [PASS/FAIL/SKIP]  whipUrl shape:
                                        whepUrl shape:
T1.3 no token leak    [PASS/FAIL/SKIP]
T1.4 whep only        [PASS/FAIL/SKIP]
T1.5 delete reaps     [PASS/FAIL/SKIP]
T1.6 abandoned        [PASS/FAIL/SKIP]  live input still present after TTL? Y/N

### Phase 2 — laptop
T2.1 fake turret      [PASS/FAIL/SKIP]
T2.2 session starts   [PASS/FAIL/SKIP]  time to LIVE: __ s
T2.3 viewer           [PASS/FAIL/SKIP]
T2.4 waiting state    [PASS/FAIL/SKIP]  WHEP status before publisher: ___
T2.5 stop cleans up   [PASS/FAIL/SKIP]

### Phase 3 — phone
T3.1 constraints accepted:
T3.2 frame source:
T3.3 codec:
T3.4 wake lock        [PASS/FAIL/SKIP]  survived: timeout? shade? call? app switch?
T3.5 thermal          qualityLimitationReason values seen:
                      detection rate changes:
T3.6 battery __% -> __%   too hot to hold? Y/N

### Phase 4 — venue
(uplink matrix)
T4.2 50-min hold      [PASS/FAIL/SKIP]

### Phase 5 — failure domains
T5.1 detector throws  [PASS/FAIL/SKIP]
T5.2 BLE drops        [PASS/FAIL/SKIP]  turret held position? Y/N
T5.3 uplink dies      [PASS/FAIL/SKIP]  recovery: __ s
T5.4 backgrounded     [PASS/FAIL/SKIP]
T5.5 restart limit    [PASS/FAIL/SKIP]

### Phase 6 — tracker
T6.1 horse scores at ~30 m:
T6.2 lock time:                    false locks:
T6.3 px/deg values:
T6.4 frame exits per gait:

### Notes / log excerpts
```

---

## What each failure changes

So you know what is worth reporting urgently rather than at the end of a session:

| Fails | Consequence |
|---|---|
| T1.5 | Live Inputs leak and cost money — stop and fix before any long testing |
| T2.4 | The viewer's WAITING state is wrong; viewers get a black rectangle |
| T3.3 | Software encoding; heat and thermal throttling are inevitable |
| T3.5 (never fires) | The thermal policy is dead code; degradation needs a different trigger |
| T5.1 or T5.2 | The §2.1 isolation is not real — this blocks the field test entirely |
| T6.1 | The detector cannot do the job; the model must change before anything else |
