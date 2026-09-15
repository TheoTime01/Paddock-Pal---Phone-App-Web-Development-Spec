/**
 * Tracker worker — README §2.1, §2.4.
 *
 * Runs the detector, the ROI crop, the predictor and the control law. It lives
 * in a Web Worker so a detector exception is STRUCTURALLY INCAPABLE of touching
 * the RTCPeerConnection. If this file throws, main.js restarts it and the
 * stream never notices.
 *
 * Messages in:  {type:'init'|'frame'|'config'|'reset'|'calibrate'}
 * Messages out: {type:'ready'|'track'|'lost'|'calibration'|'error'|'log'}
 */

import { createMediaPipeDetector } from './detector.js';
import { DisplayState } from '../shared/protocol.js';
import {
  AcquisitionLock,
  LossEscalator,
  PxPerDegEstimator,
  TrackingController,
  computeRoi,
  sweepTiles,
} from '../shared/tracking.js';

const state = {
  detector: null,
  controller: new TrackingController(),
  acquisition: new AcquisitionLock(),
  loss: new LossEscalator(),
  pxPerDeg: new PxPerDegEstimator(),
  /** Last confident detection, full-frame pixels. */
  last: null,
  lastCameraAngleDeg: null,
  sweepIndex: 0,
  phase: 'IDLE', // IDLE | CALIBRATING | ACQUIRING | TRACKING | LOST
  frameSize: { width: 1280, height: 720 },
  /** Loss log — how you tune thresholds after a real session (§2.4). */
  transitions: [],
};

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await onInit(msg);
        break;
      case 'frame':
        await onFrame(msg);
        break;
      case 'calibrate':
        setPhase('CALIBRATING');
        state.pxPerDeg.reset();
        break;
      case 'reset':
        onReset();
        break;
      default:
        break;
    }
  } catch (err) {
    // Report and keep going. The supervisor decides whether to restart us;
    // either way the stream is untouched.
    post({ type: 'error', message: String(err?.message ?? err), stack: err?.stack });
  }
};

async function onInit({ frameSize, thresholds }) {
  if (frameSize) state.frameSize = frameSize;
  if (thresholds?.acquireScore) state.acquisition.threshold = thresholds.acquireScore;
  state.detector = await createMediaPipeDetector({ scoreThreshold: thresholds?.detectScore ?? 0.3 });
  setPhase('ACQUIRING');
  post({ type: 'ready' });
}

function onReset() {
  state.controller.reset();
  state.acquisition.reset();
  state.loss.onDetection();
  state.last = null;
  state.sweepIndex = 0;
  setPhase('ACQUIRING');
}

/**
 * @param {{frame:any, roi:object, cameraAngleCdeg:number, leadSec:number,
 *          tMs:number, atLimitCw:boolean, atLimitCcw:boolean}} msg
 */
async function onFrame({ frame, cameraAngleCdeg = 0, leadSec = 0, tMs, atLimitCw, atLimitCcw }) {
  const now = tMs ?? performance.now();
  const cameraAngleDeg = cameraAngleCdeg / 100;

  if (!state.detector) {
    frame.close?.();
    return;
  }

  const crop = chooseCrop(now);
  let detections = [];
  try {
    detections = await detectIn(frame, crop, now);
  } finally {
    frame.close?.();
  }

  // The rider is normally alone in the paddock, so the highest-confidence
  // horse IS the subject; `person` is only a confirming signal.
  const { locked, best, consecutive } = state.acquisition.push(detections);
  const hasPerson = detections.some((d) => d.category === 'person' && d.score >= 0.3);

  if (!best) {
    state.loss.onMiss(now);
    if (state.phase === 'TRACKING') setPhase('LOST');
    post({
      type: 'lost',
      displayState: state.phase === 'ACQUIRING' ? DisplayState.SEARCHING : DisplayState.LOST,
      stage: state.loss.stage(now),
      roi: crop,
    });
    return;
  }

  if (state.phase === 'ACQUIRING' && !locked) {
    post({ type: 'lost', displayState: DisplayState.SEARCHING, consecutive, roi: crop });
    return;
  }

  state.loss.onDetection();
  if (state.phase !== 'TRACKING') setPhase('TRACKING');

  const bbox = { cx: best.x + best.w / 2, cy: best.y + best.h / 2, w: best.w, h: best.h };

  // Opportunistic px/deg re-estimation: a large pan coinciding with a
  // confident detection is a free calibration sample (§2.4).
  updateCalibration(bbox, cameraAngleDeg, best.score);
  state.last = { ...bbox, tMs: now };
  state.lastCameraAngleDeg = cameraAngleDeg;

  const pxPerDeg = state.pxPerDeg.value;
  if (!pxPerDeg) {
    // Not calibrated yet: report the lock so the UI and the face are right,
    // but do not command a bearing we cannot compute.
    post({ type: 'track', move: false, displayState: DisplayState.LOCKED, bbox, roi: crop, reason: 'uncalibrated' });
    return;
  }

  const out = state.controller.update({
    bboxCx: bbox.cx / state.frameSize.width,
    frameWidthPx: state.frameSize.width,
    pxPerDeg,
    cameraAngleDeg,
    leadSec,
    tSec: now / 1000,
    atLimitCw,
    atLimitCcw,
  });

  post({
    type: 'track',
    move: out.move,
    commandDeg: out.commandDeg,
    maxRateDps: out.maxRateDps,
    subjectDeg: out.subjectDeg,
    velDegPerSec: out.velDegPerSec,
    errorDeg: out.errorDeg,
    reason: out.reason,
    displayState: DisplayState.LOCKED,
    score: best.score,
    confirmedByPerson: hasPerson,
    pxPerDeg,
    bbox,
    roi: crop,
  });
}

/**
 * ROI crop is the whole trick (§2.4). At 30 m a horse and rider is ~116 px in
 * a 1280-wide frame; downscaled to a full-frame model input it's ~12 px and
 * invisible, but as 18% of a 640 px native crop it's trivial.
 */
function chooseCrop(now) {
  const widen = state.loss.widen(now);
  const sweeping = state.phase === 'ACQUIRING' || state.loss.stage(now) === 2;

  if (sweeping || !state.last) {
    const tiles = sweepTiles(state.frameSize);
    const tile = tiles[state.sweepIndex % tiles.length];
    state.sweepIndex++;
    return tile;
  }

  // Centred on the PREDICTED position, not the last one.
  const dtSec = Math.max(0, (now - state.last.tMs) / 1000);
  const predictedCx = state.last.cx + (state.controller.velocity.value ?? 0) * dtSec * (state.pxPerDeg.value ?? 0);
  return computeRoi({ cx: predictedCx, cy: state.last.cy, h: state.last.h }, state.frameSize, widen);
}

async function detectIn(frame, crop, now) {
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return state.detector.detect(canvas, {
    timestampMs: Math.round(now),
    offsetX: crop.x,
    offsetY: crop.y,
    scale: 1,
  });
}

function updateCalibration(bbox, cameraAngleDeg, score) {
  if (state.last === null || state.lastCameraAngleDeg === null || score < 0.5) return;
  const deltaDeg = cameraAngleDeg - state.lastCameraAngleDeg;
  // The subject moves across the frame opposite the camera's own motion, so
  // the pixel delta must be corrected for the subject's own travel — over one
  // detection interval that travel is small next to a deliberate pan.
  const deltaPx = state.last.cx - bbox.cx;
  const estimate = state.pxPerDeg.addSample(deltaPx, deltaDeg);
  if (estimate !== null) {
    post({ type: 'calibration', pxPerDeg: estimate, samples: state.pxPerDeg.sampleCount });
  }
}

function setPhase(phase) {
  if (state.phase === phase) return;
  // Log every transition with a timestamp; the loss log is how you tune
  // thresholds after a real session (§2.4).
  const entry = { from: state.phase, to: phase, tMs: Math.round(performance.now()) };
  state.transitions.push(entry);
  state.phase = phase;
  post({ type: 'phase', ...entry });
}

function post(msg) {
  self.postMessage(msg);
}
