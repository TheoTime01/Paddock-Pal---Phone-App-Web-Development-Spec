# Paddock Pal — Phone App & Web Development Spec

**Date:** 2026-09-15
**Scope:** Everything that runs off-device — the Android capture app, Cloudflare Stream ingest, the viewer page, and the BLE **data contract** to the ESP32.
**Out of scope:** ESP32 firmware. The BLE contract in §5 is normative for both sides; how the firmware honours it is the firmware's business.
**Assumed stack:** vanilla JS + Vite, deployed to Cloudflare Pages, with one Worker for session brokering. No framework — the capture page is a state machine and a render loop, and React buys nothing here.

---

## 1. Shape of the system

Three deployables, one origin.

```
  ┌─────────────────────────┐
  │ /capture   (turret phone)│  camera · tracker · BLE central · WHIP sender
  └───────┬──────────┬───────┘
          │          │ BLE GATT (§5)
          │          └──────────────▶ ESP32-S3
          │ WHIP (H.264)
          ▼
  ┌──────────────────┐        ┌──────────────────────┐
  │ Cloudflare Stream│◀───────┤ Worker /api/session  │ holds the CF API token
  │   Live Input     │        │ creates & deletes    │ client NEVER sees it
  └────────┬─────────┘        │ Live Inputs          │
           │ WHEP             └──────────────────────┘
           ▼
  ┌──────────────────┐
  │ /watch/:id       │  WHEP receiver
  └──────────────────┘
```

**Security rule, non-negotiable:** the Cloudflare Stream API token lives in the Worker only. The capture page calls `POST /api/session`, gets back `{ sessionId, whipUrl, whepUrl }`, and never holds a credential that could create Live Inputs. A token shipped in client JS is a token someone else is streaming on.

### Repo layout

```
src/
  capture/
    main.js              orchestration, session state machine
    camera.js            getUserMedia, constraint locking, wake lock
    tracker.worker.js    detection + ROI + predictor  (isolated)
    control.js           ControlTransport interface + latency tracking
    ble-transport.js     Web Bluetooth implementation
    relay-transport.js   stub — iOS WSS relay, later
    whip.js             WHIP sender + stats + reconnect
    preflight.js        uplink probe
    ui.js
  watch/
    main.js             WHEP receiver
  shared/
    protocol.js         §5 encode/decode — SINGLE SOURCE OF TRUTH
worker/
  index.js              /api/session create + delete
```

`shared/protocol.js` is the only place byte layouts appear. Generate the ESP32 header from it or keep them in lockstep by hand, but do not let two hand-written copies drift.

---

## 2. Capture page

### 2.1 Two independent state machines

This is the architectural requirement from v2, expressed in code: **tracking must not be able to kill the stream.** They share no state and neither awaits the other.

```
SESSION:  IDLE → PREFLIGHT → READY → CALIBRATING → ACQUIRING → TRACKING ⇄ LOST
                                                                    ↓
                                                                 STOPPING → IDLE

STREAM:   OFF → CONNECTING → LIVE ⇄ RECONNECTING → OFF
```

The tracker lives in a Web Worker so a detector exception is structurally incapable of touching the `RTCPeerConnection`. The worker gets restarted by a supervisor in `main.js`; the stream never notices.

### 2.2 Camera acquisition and locking

```js
const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    facingMode: { ideal: 'environment' },
    width:  { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
  audio: false,          // a mic 25 m away records wind, not hooves
});
const track = stream.getVideoTracks()[0];
```

Then **lock exposure, focus and white balance** — AE/AF hunting while panning wrecks detection and looks amateur. Every one of these is optional on Android; feature-detect each independently and carry on without it.

```js
const caps = track.getCapabilities();
const advanced = [];
if (caps.exposureMode?.includes('manual'))     advanced.push({ exposureMode: 'manual' });
if (caps.focusMode?.includes('manual'))        advanced.push({ focusMode: 'manual' });
if (caps.whiteBalanceMode?.includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });

// France is 50 Hz mains. Indoor arena lighting bands unless shutter is 1/50 or 1/100.
// exposureTime is in units of 100 microseconds.
if (caps.exposureTime) {
  const target = venue === 'indoor' ? 100 : 200;   // 1/100 s or 1/50 s
  advanced.push({ exposureTime: clamp(target, caps.exposureTime.min, caps.exposureTime.max) });
}
await track.applyConstraints({ advanced });
```

Lock these **after** the rider has framed the arena and **before** ACQUIRING, with the subject roughly mid-frame so exposure meters off the horse and not the sky.

**Screen wake lock** — mandatory. Chrome suspends a backgrounded tab and both tracking and the WHIP stream die with it.

```js
let wakeLock = await navigator.wakeLock.request('screen');
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wakeLock?.released)
    wakeLock = await navigator.wakeLock.request('screen');
});
```

### 2.3 Feeding the tracker

Use `MediaStreamTrackProcessor` — it hands you `VideoFrame`s directly and they transfer to a worker zero-copy. Fall back to `requestVideoFrameCallback` + `OffscreenCanvas` where it's unavailable.

```js
const processor = new MediaStreamTrackProcessor({ track: track.clone() });
const reader = processor.readable.getReader();

let busy = false;
for (;;) {
  const { value: frame, done } = await reader.read();
  if (done) break;
  if (busy || now() - lastDetect < detectIntervalMs) { frame.close(); continue; }
  busy = true;
  worker.postMessage({ type: 'frame', frame, roi, cameraAngleCdeg }, [frame]);
}
```

Note the `track.clone()` — the stream gets the original track, the tracker gets a clone. Independent lifetimes.

`detectIntervalMs` starts at 100 (10 Hz) and is **raised adaptively when WebRTC reports CPU or thermal limitation** (§3.4). Streaming is the product; detection rate is what gives way.

### 2.4 Tracker worker

**Detector:** MediaPipe Tasks Vision `ObjectDetector` with EfficientDet-Lite0, GPU delegate. It carries the COCO classes, which include `horse` and `person`. Filter to `horse`, use `person` only as a confirming signal. Upgrade path later is a fine-tuned YOLOv8n; keep the detector behind a one-function interface so that swap is contained.

**ROI crop is the whole trick.** At 30 m a horse and rider is ~116 px in a 1280-wide frame; downscaled to a full-frame model input it's ~12 px and invisible, but as 18% of a 640 px native crop it's trivial.

```
crop side = clamp(4 × lastBboxHeight, 480, 960)  px, square,
            centred on the PREDICTED position, clamped to frame bounds
```

**Acquisition (no operator input — the rider has walked away).** Tiled sweep across the full frame at 1–2 Hz. Lock when one `horse` detection clears threshold on **3 consecutive passes**. The rider is normally alone in the paddock, so the highest-confidence horse *is* the subject; no re-identification needed.

**Self-calibrating pixels-per-degree.** Don't hard-code a field of view — you can't read it from any API and it changes with digital zoom. Measure it instead. During CALIBRATING, command two small deliberate pans and solve:

```
pxPerDeg = Δpixels_of_tracked_object / Δangle_from_encoder
```

The encoder angle comes back over BLE (§5.3), which is one of the two reasons that notify channel exists. Re-estimate opportunistically during TRACKING whenever a large pan coincides with a confident detection.

**Control law.** Work in world angle, not pixels:

```js
// subject's absolute bearing = where the camera points + where it sits in frame
const offsetDeg   = (bbox.cx - 0.5) * frameWidthPx / pxPerDeg;
const subjectDeg  = cameraAngleDeg + offsetDeg;

// constant-velocity lead — without this the horse sits permanently on the trailing edge
const velDegPerSec = alphaFilter(d(subjectDeg)/dt);
const leadSec      = measuredLoopLatency;     // from seq/seq_echo, §5.6
const commandDeg   = subjectDeg + velDegPerSec * leadSec;

// deadband, so the turret doesn't hunt
if (Math.abs(commandDeg - cameraAngleDeg) < DEADBAND_DEG) return;   // ~4.5°

// rate scales with error: small corrections move slowly and look deliberate
const maxRate = clamp(Math.abs(err) * RATE_GAIN, MIN_RATE, MAX_RATE);  // MAX_RATE 150°/s
```

Send **targets, never steps.** The ESP32 owns the trajectory; the phone says where, not how.

**Loss handling.** Widen progressively — ROI → 2×ROI → full-frame sweep — while holding the last angle. Set `display_state = LOST`. **Never stop the stream.** Log every transition with a timestamp; the loss log is how you tune thresholds after a real session.

---

## 3. Cloudflare Stream

### 3.1 Session brokering (Worker)

```
POST /api/session   → { sessionId, whipUrl, whepUrl, expiresAt }
DELETE /api/session/:id
```

The Worker creates a Live Input with `mode: 'webRTC'`, returns `webRTC.url` as `whipUrl` and `webRTCPlayback.url` as `whepUrl`. Store the session in KV with a TTL so orphaned inputs get reaped.

**Know what you're handing out:** the WHEP playback URL is public. Anyone with the link can watch. If sessions need to be private, gate `/watch/:id` behind your own auth and have the Worker hand out the WHEP URL only after that check — do not rely on the URL being unguessable.

### 3.2 WHIP sender

```js
const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
const tx = pc.addTransceiver(videoTrack, { direction: 'sendonly' });

// Cloudflare WHIP accepts H.264 Constrained Baseline 3.1, VP8, VP9.
// Prefer H.264: it's the hardware encoder on Android, which means less heat.
const caps = RTCRtpSender.getCapabilities('video');
const preferred = [
  ...caps.codecs.filter(c => c.mimeType === 'video/H264'
        && c.sdpFmtpLine?.includes('profile-level-id=42e01f')),   // CB 3.1
  ...caps.codecs.filter(c => c.mimeType !== 'video/H264'),
];
tx.setCodecPreferences(preferred);

await pc.setLocalDescription(await pc.createOffer());
await iceGatheringComplete(pc);                    // or trickle; CF supports both

const res = await fetch(whipUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: pc.localDescription.sdp,
});
const resourceUrl = res.headers.get('Location');   // keep it — DELETE on stop
await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
```

Then set the encoding envelope:

```js
const p = tx.sender.getParameters();
p.encodings[0].maxBitrate   = 2_500_000;
p.encodings[0].maxFramerate = 30;
p.degradationPreference     = 'maintain-framerate';  // motion smoothness > detail
await tx.sender.setParameters(p);
```

`maintain-framerate` is deliberate: a rider reviewing a canter transition needs temporal smoothness far more than pixel detail.

**On stop, send `DELETE resourceUrl`.** Skip it and you leave Live Inputs open, which costs money and eventually hits account limits.

### 3.3 Reconnect

Watch `pc.connectionstate`. On `disconnected` for >3 s or `failed`, tear down and re-POST with exponential backoff (1, 2, 4, 8 s, cap 15 s). Reuse the same Live Input — the WHIP URL stays valid. Tracking continues untouched throughout, so when the stream comes back the horse is still framed.

### 3.4 Stats loop — this is your adaptive controller

Poll `pc.getStats()` at 1 Hz, read the `outbound-rtp` report:

```js
const { bytesSent, framesPerSecond, qualityLimitationReason } = report;
```

`qualityLimitationReason` is the most useful field in the whole app:

| Value | Meaning | Response |
|---|---|---|
| `none` | healthy | if detector rate was reduced, restore it |
| `bandwidth` | uplink is the limit | let WebRTC adapt; surface amber to the viewer |
| `cpu` | phone is compute-bound | **raise `detectIntervalMs`** (drop detection Hz) |
| `thermal` | phone is throttling | raise `detectIntervalMs` further, then drop `maxBitrate` |

Degrading detection before degrading video is the policy that falls out of "live streaming is the product." Encode it here, in one function, so it can't drift.

### 3.5 Preflight

Don't synthesise a speed test — **run the real path**. Open the WHIP session, stream for 15 s, read the stats, tear down. Then show the rider a verdict before they mount:

| Verdict | Sustained bitrate | Loss |
|---|---|---|
| Green | ≥ 2.0 Mbps | < 2% |
| Amber | 0.8 – 2.0 Mbps | 2–5% |
| Red | < 0.8 Mbps | > 5% |

Also display the selected uplink (venue WiFi or cellular) and let them switch and re-test. Indoor arenas are steel-clad and often cellular-hostile; this screen is what stops a 50-minute session being wasted.

---

## 4. Viewer page (`/watch/:id`)

```js
const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
pc.addTransceiver('video', { direction: 'recvonly' });
pc.ontrack = e => { videoEl.srcObject = e.streams[0]; };

await pc.setLocalDescription(await pc.createOffer());
const res = await fetch(whepUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: pc.localDescription.sdp,
});
await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
```

`<video autoplay muted playsinline>` — muted is required for autoplay and there's no audio track anyway.

States the page must handle explicitly, because an equestrian viewer is often a parent on a phone in a car park: **waiting for the rider to start**, **live**, **reconnecting**, **session ended**. A blank black rectangle is the most common failure of homemade WHEP pages.

Reconnect on `failed`/`disconnected` with the same backoff as §3.3. Show connection quality from `inbound-rtp` (`packetsLost`, `jitter`) as a simple three-bar indicator.

**Do not use the Cloudflare Stream Player here.** It's an HLS player and a WHIP input has no HLS rendition. This hand-rolled WHEP page is the only playback path.

---

## 5. BLE data contract

Normative for both the phone (central) and the ESP32 (peripheral). All multi-byte fields are **little-endian**. All angles are **centidegrees** (1/100°), signed, relative to the `home` position established at power-on or calibration.

### 5.1 GATT profile

```
Service  e7a10000-9d3c-4b21-b0f5-2c7a6d18e4f1   "Paddock Pal Turret"
  ├── e7a10001-…  Control   write-without-response   8 bytes   phone → ESP32
  ├── e7a10002-…  State     notify                  12 bytes   ESP32 → phone
  ├── e7a10003-…  Event     notify                   2 bytes   ESP32 → phone
  └── e7a10004-…  Config    read / write             8 bytes   bidirectional
```

Advertise the service UUID in the advertising packet so `requestDevice` can filter on it. Device name `PaddockPal-XXXX` where XXXX is the last two bytes of the MAC.

Requested connection interval **15–30 ms**. Default 23-byte MTU is sufficient — no extended packets needed.

### 5.2 Control — phone → ESP32, 8 bytes, ≤ 20 Hz (nominal 10 Hz)

| Off | Type | Name | Notes |
|---|---|---|---|
| 0 | `uint8` | `seq` | increments, wraps at 255. Echoed in State for latency measurement |
| 1 | `uint8` | `mode` | `0` IDLE (hold) · `1` TRACK · `2` GOTO · `3` CALIBRATE |
| 2 | `int16` | `target_cdeg` | target pan angle. Range ±18000 (±180.00°) |
| 4 | `uint16` | `max_rate_cds` | rate cap, centideg/s. `0` = use Config default |
| 6 | `uint8` | `flags` | bit0 `motor_enable` · bit1 `home_request` · bits 2–7 reserved (0) |
| 7 | `uint8` | `display_state` | `0` IDLE · `1` SEARCHING · `2` LOCKED · `3` LOST · `4` ERROR |

`display_state` rides along on every control packet rather than having its own characteristic. It drives the GC9A01 GIF state machine, and piggybacking guarantees the face on the turret always matches what the tracker is actually doing.

```js
export function encodeControl({ seq, mode, targetCdeg, maxRateCds, flags, displayState }) {
  const v = new DataView(new ArrayBuffer(8));
  v.setUint8 (0, seq & 0xff);
  v.setUint8 (1, mode);
  v.setInt16 (2, targetCdeg, true);
  v.setUint16(4, maxRateCds, true);
  v.setUint8 (6, flags);
  v.setUint8 (7, displayState);
  return v.buffer;
}
```

### 5.3 State — ESP32 → phone, 12 bytes, notify @ 10 Hz

| Off | Type | Name | Notes |
|---|---|---|---|
| 0 | `uint8` | `seq_echo` | last `seq` received → round-trip latency |
| 1 | `uint8` | `status` | bit0 `motor_enabled` · bit1 `at_limit_cw` · bit2 `at_limit_ccw` · bit3 `calibrated` · bit4 `fault` · bit5 `charging` |
| 2 | `int16` | `angle_cdeg` | **actual encoder angle** — the predictor and the px/deg calibration both depend on this |
| 4 | `int16` | `rate_cds` | measured angular rate |
| 6 | `uint16` | `vbat_mv` | pack voltage, millivolts |
| 8 | `uint8` | `batt_pct` | 0–100 |
| 9 | `uint8` | `temp_c` | internal temperature, **offset +40** (value 40 = 0 °C) |
| 10 | `uint8` | `fault_code` | 0 = none |
| 11 | `uint8` | `reserved` | 0 |

`angle_cdeg` is the single most important field in the protocol. Without it the phone cannot dead-reckon between detections, cannot compensate for its own ego-motion, and cannot self-calibrate pixels-per-degree.

### 5.4 Event — ESP32 → phone, 2 bytes, notify on change

| Off | Type | Name |
|---|---|---|
| 0 | `uint8` | `event_id` |
| 1 | `uint8` | `arg` |

| `event_id` | Meaning |
|---|---|
| `1` | `FOB_START_STOP` — rider pressed start/stop on the ESP-NOW fob |
| `2` | `FOB_REACQUIRE` — rider asked for re-acquire from horseback |
| `3` | `BUTTON_TOP` — the puck's own top button |
| `4` | `LIMIT_HIT` — `arg`: 0 = CCW, 1 = CW |
| `5` | `FAULT` — `arg` = fault code |
| `6` | `LOW_BATTERY` — `arg` = percent |

This is how the rider's fob reaches the app. The ESP32 acts on re-centre locally and immediately, then reports the press here so the tracker can reset its lock state.

### 5.5 Config — read/write, 8 bytes, set once during setup

| Off | Type | Name |
|---|---|---|
| 0 | `int16` | `limit_cw_cdeg` |
| 2 | `int16` | `limit_ccw_cdeg` |
| 4 | `uint16` | `default_rate_cds` |
| 6 | `uint8` | `accel_profile` — `0` smooth · `1` responsive |
| 7 | `uint8` | `reserved` |

### 5.6 Normative behaviours

These belong to the contract even though the ESP32 implements them.

- **Command timeout.** No Control write for **1000 ms** → the ESP32 **holds its current position** and shows the LOST face. It must **not** return to home. A turret that snaps around next to a horse is a safety event, not a recovery.
- **The ESP32 clamps, the phone requests.** `max_rate_cds` is an upper bound the firmware clamps against its own Config maximum. Never trust the phone not to command 400°/s.
- **Targets, never steps.** The phone sends a destination angle; the firmware generates the trajectory. This is what keeps motion smooth when BLE jitters.
- **Latency is measured, not assumed.** `seq` / `seq_echo` gives round-trip time for free; feed it into `leadSec` in the predictor (§2.4) so the lead term self-tunes to the actual link.
- **Software limits are authoritative.** `at_limit_*` in `status` tells the tracker to stop asking; the tracker should widen its search rather than keep commanding into a stop.

### 5.7 Web Bluetooth central — the practical gotchas

**Connect, first time:**

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: [SERVICE_UUID] }],
});
localStorage.setItem('turretId', device.id);
```

**Reconnect without the picker** — matters because the rider sets up alone, in boots:

```js
const known = await navigator.bluetooth.getDevices();          // feature-detect
const dev = known.find(d => d.id === localStorage.getItem('turretId'));
if (dev) {
  await dev.watchAdvertisements();
  dev.addEventListener('advertisementreceived', () => dev.gatt.connect(), { once: true });
}
```

`getDevices()` / `watchAdvertisements()` availability varies by Chrome version — feature-detect and fall back to `requestDevice`.

**Serialize GATT writes.** Web Bluetooth throws `InvalidStateError` if you start a GATT operation while another is pending. At 10 Hz this *will* bite. Use single-flight with **latest-wins**, never a queue:

```js
let inFlight = false, pending = null;
async function send(buf) {
  if (inFlight) { pending = buf; return; }          // drop stale, keep newest
  inFlight = true;
  try { await controlChar.writeValueWithoutResponse(buf); }
  catch (e) { onBleError(e); }
  finally {
    inFlight = false;
    if (pending) { const b = pending; pending = null; send(b); }
  }
}
```

Queueing stale commands is worse than dropping them — a servo chasing a 300 ms-old target oscillates.

**Other Android realities:**
- Android 12+ needs `BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN`; older Android needs Location enabled for BLE scanning. Detect the failure and explain it in plain language, don't fail silently.
- Web Bluetooth requires a secure context and a **user gesture** for `requestDevice`. Put it behind the setup wizard's "Connect turret" button.
- `writeValueWithoutResponse` may be absent on older implementations; fall back to `writeValue`. 10 Hz survives either way.
- Handle `gattserverdisconnected` — it fires on range loss and on the ESP32 rebooting. Reconnect with backoff; **keep streaming throughout**.

---

## 6. Failure domains

The table the implementation has to satisfy. Every row is a test.

| Failure | Stream | Tracking | Behaviour |
|---|---|---|---|
| Detector throws | unaffected | stops | park at last angle, `display_state=LOST`, supervisor restarts worker |
| BLE drops | unaffected | commands stop | ESP32 holds after 1 s; app reconnects with backoff |
| WHIP fails | reconnect loop | unaffected | keep tracking so it resumes correctly framed |
| Uplink dies | reconnect loop | unaffected | as above |
| Phone thermal-throttles | drop bitrate **second** | drop detect Hz **first** | driven by `qualityLimitationReason` |
| Tab backgrounded | dies | dies | wake lock prevents it; warn loudly if the lock is refused |

**Bench test before any field test:** throw an exception inside the tracker worker mid-stream and confirm the stream survives. Then kill BLE and confirm the same. If either takes down the stream, the isolation isn't real.

---

## 7. Build order

1. **Worker + `/api/session`** and a hardcoded WHIP page. Confirm you can go live from a phone and watch on `/watch/:id`. No tracking, no BLE. *This is also the v0 product from architecture-v2 — shippable on its own.*
2. **Preflight screen.** Take it to the real venues. This is the highest-risk unknown and it needs no hardware.
3. **Tracker worker offline.** Feed it recorded arena footage, not a live camera. Tune detection thresholds and the ROI sizing against a file you can replay, with the indoor and outdoor profiles as separate test sets.
4. **`shared/protocol.js` + a fake transport.** Implement §5 against a mock that just logs and echoes plausible State packets. The whole control loop can be developed and tuned before the ESP32 exists.
5. **Swap in `ble-transport.js`.** By this point only the transport is new.
6. **Failure-domain tests** (§6), then field test.

Steps 1–4 need no turret at all.

## Sources

- [Ultra-low Latency with WebRTC — Cloudflare Stream docs](https://developers.cloudflare.com/stream/webrtc-beta/)
- [First WebRTC broadcast in the browser — Cloudflare Stream docs](https://developers.cloudflare.com/stream/examples/browser-based-webrtc/)
