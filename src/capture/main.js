/**
 * Capture orchestration — README §2.1.
 *
 * TWO INDEPENDENT STATE MACHINES. This is the architectural requirement from
 * v2, expressed in code: tracking must not be able to kill the stream.
 *
 *   SESSION: IDLE -> PREFLIGHT -> READY -> CALIBRATING -> ACQUIRING
 *                                       -> TRACKING <-> LOST -> STOPPING -> IDLE
 *   STREAM:  OFF -> CONNECTING -> LIVE <-> RECONNECTING -> OFF   (whip.js)
 *
 * They share no state and neither awaits the other. Everything in this file
 * that touches the tracker is wrapped so a tracker failure can only ever
 * degrade tracking.
 */

import { createFrameSource, createWakeLock, lockExposure, openCamera } from './camera.js';
import { ControlLink } from './control.js';
import { BleTransport, bluetoothAvailable, explainBluetoothError } from './ble-transport.js';
import { FakeTurretTransport } from './fake-transport.js';
import { StreamState, WhipSender } from './whip.js';
import { describeUplink, runPreflight } from './preflight.js';
import { createUi } from './ui.js';
import { DisplayState, EventId } from '../shared/protocol.js';
import { DETECT_INTERVAL_BASE_MS } from '../shared/adaptive.js';

export const SessionState = Object.freeze({
  IDLE: 'IDLE',
  PREFLIGHT: 'PREFLIGHT',
  READY: 'READY',
  CALIBRATING: 'CALIBRATING',
  ACQUIRING: 'ACQUIRING',
  TRACKING: 'TRACKING',
  LOST: 'LOST',
  STOPPING: 'STOPPING',
});

const CALIBRATION_PANS_DEG = [-8, 8]; // two small deliberate pans (§2.4)
const WORKER_RESTART_LIMIT = 5;

const app = {
  session: SessionState.IDLE,
  ui: null,
  camera: null,
  wakeLock: null,
  frames: null,
  worker: null,
  workerRestarts: 0,
  control: null,
  sender: null,
  sessionInfo: null,
  venue: 'outdoor',
  detectIntervalMs: DETECT_INTERVAL_BASE_MS,
  lastDetectAt: 0,
  busy: false,
  frameSize: { width: 1280, height: 720 },
};

// ------------------------------------------------------------------ session

function setSession(next, detail = '') {
  if (app.session === next) return;
  app.session = next;
  app.ui.setSessionState(next);
  if (detail) app.ui.setDetail(detail);
  app.ui.log(`session → ${next}${detail ? ` (${detail})` : ''}`);
  app.control?.setDisplayState(displayStateFor(next));
}

function displayStateFor(sessionState) {
  switch (sessionState) {
    case SessionState.ACQUIRING:
    case SessionState.CALIBRATING:
      return DisplayState.SEARCHING;
    case SessionState.TRACKING:
      return DisplayState.LOCKED;
    case SessionState.LOST:
      return DisplayState.LOST;
    default:
      return DisplayState.IDLE;
  }
}

// ------------------------------------------------------------------- broker

async function createStreamSession() {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Paddock Pal ${new Date().toLocaleString()}` }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Could not start a session: ${body.error ?? res.status}`);
  }
  return res.json();
}

async function destroyStreamSession(sessionId) {
  if (!sessionId) return;
  await fetch(`/api/session/${sessionId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}

// ------------------------------------------------------------- tracker (§2.1)

/**
 * Supervisor. The worker gets restarted from here; the stream never notices,
 * because nothing in this function can reach the RTCPeerConnection.
 */
function startTracker() {
  const worker = new Worker(new URL('./tracker.worker.js', import.meta.url), { type: 'module' });
  app.worker = worker;

  worker.onmessage = (e) => onTrackerMessage(e.data);
  worker.onerror = (err) => {
    app.ui.log(`tracker crashed: ${err.message}`, 'error');
    // Park at the last angle and show the LOST face; the stream carries on (§6).
    app.control?.hold();
    app.control?.setDisplayState(DisplayState.LOST);
    setSession(SessionState.LOST, 'tracker restarting');
    restartTracker();
  };

  worker.postMessage({
    type: 'init',
    frameSize: app.frameSize,
    thresholds: { detectScore: 0.3, acquireScore: 0.4 },
  });
  return worker;
}

function restartTracker() {
  if (app.workerRestarts >= WORKER_RESTART_LIMIT) {
    app.ui.log('tracker restart limit reached — streaming continues without tracking', 'error');
    app.control?.setDisplayState(DisplayState.ERROR);
    return;
  }
  app.workerRestarts++;
  try {
    app.worker?.terminate();
  } catch {
    /* already gone */
  }
  app.worker = null;
  setTimeout(() => {
    if (app.session === SessionState.IDLE || app.session === SessionState.STOPPING) return;
    startTracker();
    app.ui.log(`tracker restarted (${app.workerRestarts}/${WORKER_RESTART_LIMIT})`, 'warn');
  }, 500);
}

function onTrackerMessage(msg) {
  switch (msg.type) {
    case 'ready':
      app.ui.log('tracker ready');
      setSession(SessionState.ACQUIRING);
      break;

    case 'track': {
      app.busy = false;
      if (app.session !== SessionState.TRACKING) setSession(SessionState.TRACKING);
      app.ui.drawOverlay({ roi: msg.roi, bbox: msg.bbox, frameSize: app.frameSize });
      if (msg.move) app.control?.trackTo(msg.commandDeg, msg.maxRateDps);
      else app.control?.hold();
      app.control?.setDisplayState(DisplayState.LOCKED);
      app.ui.setDetail(
        `lock ${(msg.score * 100).toFixed(0)}% · err ${msg.errorDeg?.toFixed(1)}° · ` +
          `${msg.pxPerDeg?.toFixed(1)} px/° · lead ${(app.control?.leadSec ?? 0).toFixed(3)} s`,
      );
      break;
    }

    case 'lost':
      app.busy = false;
      app.ui.drawOverlay({ roi: msg.roi, bbox: null, frameSize: app.frameSize });
      // Hold the last angle. NEVER stop the stream (§2.4).
      app.control?.hold();
      app.control?.setDisplayState(msg.displayState ?? DisplayState.LOST);
      if (app.session === SessionState.TRACKING) setSession(SessionState.LOST);
      break;

    case 'calibration':
      app.ui.log(`px/deg ≈ ${msg.pxPerDeg.toFixed(1)} (${msg.samples} samples)`);
      if (app.session === SessionState.CALIBRATING) setSession(SessionState.ACQUIRING);
      break;

    case 'phase':
      app.ui.log(`tracker ${msg.from} → ${msg.to}`);
      break;

    case 'error':
      app.busy = false;
      app.ui.log(`tracker error: ${msg.message}`, 'error');
      break;

    default:
      break;
  }
}

// --------------------------------------------------------------- frame pump

function startFramePump(track) {
  const settings = track.getSettings?.() ?? {};
  app.frameSize = { width: settings.width ?? 1280, height: settings.height ?? 720 };

  app.frames = createFrameSource(track, (frame) => {
    const now = performance.now();
    // detectIntervalMs is raised adaptively when WebRTC reports CPU or thermal
    // limitation (§3.4). Streaming is the product; detection rate gives way.
    if (app.busy || now - app.lastDetectAt < app.detectIntervalMs || !app.worker) return false;
    app.busy = true;
    app.lastDetectAt = now;

    const state = app.control?.lastState;
    app.worker.postMessage(
      {
        type: 'frame',
        frame,
        tMs: now,
        cameraAngleCdeg: state?.angleCdeg ?? 0,
        leadSec: app.control?.leadSec ?? 0,
        atLimitCw: state?.atLimitCw ?? false,
        atLimitCcw: state?.atLimitCcw ?? false,
      },
      [frame],
    );
    return true; // consumed — transferred to the worker
  });
  app.ui.log(`frame source: ${app.frames.kind}`);
}

// ------------------------------------------------------------------ turret

function attachControl(transport, label) {
  const link = new ControlLink(transport);
  app.control = link;

  link.addEventListener('state', (e) => {
    const { state, medianRttMs } = e.detail;
    app.ui.setTurretState(
      `${label} · ${state.angleDeg.toFixed(1)}° · ${state.battPct}% · ${state.tempC}°C` +
        (medianRttMs ? ` · ${Math.round(medianRttMs)} ms` : ''),
      !state.fault,
    );
  });

  link.addEventListener('event', (e) => onTurretEvent(e.detail));
  link.addEventListener('disconnected', (d) =>
    // BLE drops do not touch the stream: the ESP32 holds after 1 s and we
    // reconnect with backoff (§6).
    app.ui.log(`turret disconnected${d.detail?.willRetry ? ' — reconnecting' : ''}`, 'warn'),
  );
  link.addEventListener('error', (e) => app.ui.log(`turret: ${e.detail?.message}`, 'warn'));

  return link;
}

function onTurretEvent({ eventId, arg }) {
  switch (eventId) {
    case EventId.FOB_START_STOP:
      app.ui.log('fob: start/stop');
      if (app.session === SessionState.IDLE || app.session === SessionState.READY) start();
      else stop();
      break;
    case EventId.FOB_REACQUIRE:
    case EventId.BUTTON_TOP:
      // The ESP32 acts on re-centre locally and immediately; we just reset the
      // tracker's lock state (§5.4).
      reacquire();
      break;
    case EventId.LIMIT_HIT:
      app.ui.log(`turret hit the ${arg === 1 ? 'CW' : 'CCW'} limit`, 'warn');
      break;
    case EventId.FAULT:
      app.ui.log(`turret fault ${arg}`, 'error');
      app.control?.setDisplayState(DisplayState.ERROR);
      break;
    case EventId.LOW_BATTERY:
      app.ui.log(`turret battery ${arg}%`, 'warn');
      break;
    default:
      break;
  }
}

/**
 * Two small deliberate pans, solving pxPerDeg = Δpixels / Δangle (§2.4).
 * The encoder angle comes back over BLE (§5.3).
 */
async function calibrate() {
  if (!app.control?.connected) return;
  setSession(SessionState.CALIBRATING);
  app.worker?.postMessage({ type: 'calibrate' });
  const home = app.control.cameraAngleDeg;
  for (const delta of CALIBRATION_PANS_DEG) {
    app.control.calibrate(home + delta, 25);
    await sleep(1600);
  }
  app.control.goTo(home, 25);
  await sleep(1200);
}

// ------------------------------------------------------------------ actions

async function ensureCamera() {
  if (app.camera) return app.camera;
  app.camera = await openCamera();
  app.ui.els.video.srcObject = app.camera.stream;
  await app.ui.els.video.play().catch(() => {});
  return app.camera;
}

async function onPreflight() {
  try {
    setSession(SessionState.PREFLIGHT);
    const { track } = await ensureCamera();
    const uplink = describeUplink();
    app.ui.log(`preflight over ${uplink.label}`);

    const info = await createStreamSession();
    try {
      const result = await runPreflight({
        whipUrl: info.whipUrl,
        track: track.clone(),
        onProgress: ({ elapsed, total, bitrateBps }) =>
          app.ui.setDetail(`probing ${elapsed}/${total}s · ${(bitrateBps / 1e6).toFixed(2)} Mbps`),
      });
      app.ui.setPreflight(result);
      app.ui.log(`preflight ${result.verdict} over ${uplink.label}`);
    } finally {
      await destroyStreamSession(info.sessionId);
    }
    setSession(SessionState.READY);
  } catch (err) {
    app.ui.log(`preflight failed: ${err.message}`, 'error');
    setSession(SessionState.IDLE);
  }
}

async function onConnectTurret() {
  try {
    if (!bluetoothAvailable()) {
      app.ui.log('Web Bluetooth unavailable — use the fake turret or an Android phone.', 'warn');
      return;
    }
    const link = attachControl(new BleTransport(), 'turret');
    await link.connect();
    app.ui.log('turret connected');
  } catch (err) {
    app.ui.log(explainBluetoothError(err), 'error');
  }
}

/** Build order step 4: develop the whole control loop before the ESP32 exists. */
async function onFakeTurret() {
  const link = attachControl(new FakeTurretTransport({ log: true }), 'fake turret');
  await link.connect();
  app.ui.log('fake turret attached — control loop is live, no hardware involved');
}

async function start() {
  try {
    const { track } = await ensureCamera();

    // Lock AFTER framing, BEFORE acquiring, with the subject mid-frame (§2.2).
    const lock = await lockExposure(track, app.venue);
    app.ui.log(`camera locked: ${lock.applied.join(', ') || 'nothing supported'}`);
    if (lock.error) app.ui.log(`constraint lock refused: ${lock.error}`, 'warn');

    // Wake lock is mandatory — warn loudly if refused (§6).
    app.wakeLock = createWakeLock(({ held, error }) => {
      if (!held && error) app.ui.log(`WAKE LOCK REFUSED: ${error} — keep the screen on by hand`, 'error');
    });
    await app.wakeLock.request();

    // STREAM machine first and independently: the stream is the product.
    app.sessionInfo = await createStreamSession();
    app.ui.setViewerUrl(new URL(`/watch/${app.sessionInfo.sessionId}`, location.origin).toString());

    app.sender = new WhipSender({ whipUrl: app.sessionInfo.whipUrl, track });
    app.sender.addEventListener('state', (e) => {
      app.ui.setStreamState(e.detail.state);
      if (e.detail.reason) app.ui.log(`stream: ${e.detail.reason}`, 'warn');
    });
    app.sender.addEventListener('stats', (e) => app.ui.setStats(e.detail));
    app.sender.addEventListener('detect-interval', (e) => {
      app.detectIntervalMs = e.detail.detectIntervalMs;
      app.ui.log(`detection rate → ${(1000 / app.detectIntervalMs).toFixed(1)} Hz (${e.detail.reason})`, 'warn');
    });
    await app.sender.start();

    // SESSION machine second. If any of this throws, the stream stays up.
    setSession(SessionState.READY);
    try {
      startTracker();
      startFramePump(track);
      app.control?.setMotorEnabled(true);
      await calibrate();
    } catch (err) {
      app.ui.log(`tracking unavailable: ${err.message} — streaming continues`, 'error');
    }
  } catch (err) {
    app.ui.log(`start failed: ${err.message}`, 'error');
    setSession(SessionState.IDLE);
  }
}

async function stop() {
  setSession(SessionState.STOPPING);
  app.frames?.stop();
  app.frames = null;
  app.worker?.terminate();
  app.worker = null;
  app.workerRestarts = 0;

  app.control?.setDisplayState(DisplayState.IDLE);
  app.control?.hold();
  app.control?.setMotorEnabled(false);

  await app.sender?.stop();
  app.sender = null;
  await destroyStreamSession(app.sessionInfo?.sessionId);
  app.sessionInfo = null;

  await app.wakeLock?.release();
  app.ui.setStreamState(StreamState.OFF);
  setSession(SessionState.IDLE);
}

function reacquire() {
  app.worker?.postMessage({ type: 'reset' });
  setSession(SessionState.ACQUIRING, 'reacquire requested');
}

// --------------------------------------------------------------------- boot

function boot() {
  app.ui = createUi({
    onPreflight,
    onConnectTurret,
    onFakeTurret,
    onStart: start,
    onStop: stop,
    onReacquire: reacquire,
    onVenueChange: (e) => {
      app.venue = e.target.value;
      app.ui.log(`venue profile: ${app.venue}`);
    },
  });
  app.ui.setSessionState(SessionState.IDLE);
  app.ui.setStreamState(StreamState.OFF);
  app.ui.log(`uplink: ${describeUplink().label}`);

  // A closed tab must not leave a Live Input open (§3.2).
  window.addEventListener('pagehide', () => {
    if (app.sessionInfo) destroyStreamSession(app.sessionInfo.sessionId);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof document !== 'undefined') boot();

export { app, start, stop, reacquire, calibrate, onTrackerMessage };
