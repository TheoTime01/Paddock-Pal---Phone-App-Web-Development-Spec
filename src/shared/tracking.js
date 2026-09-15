/**
 * Tracking maths — README §2.4.
 *
 * Deliberately pure and DOM-free: the worker imports it, and the test suite
 * runs the whole control loop in Node with no camera and no turret.
 */

import { clamp } from './protocol.js';

// ---------------------------------------------------------------- constants

export const DEADBAND_DEG = 4.5; // §2.4 — below this the turret does not move
export const RATE_GAIN = 3.0; // deg/s of rate cap per deg of error
export const MIN_RATE_DPS = 8;
export const MAX_RATE_DPS = 150; // §2.4 — hard ceiling the phone may request

export const ROI_BBOX_MULTIPLIER = 4;
export const ROI_MIN_PX = 480;
export const ROI_MAX_PX = 960;

export const ACQUIRE_CONSECUTIVE_PASSES = 3; // §2.4 — lock after 3 clean passes

// ------------------------------------------------------------- small filters

/** Exponential (alpha) filter. alpha near 1 = trusts the newest sample more. */
export class AlphaFilter {
  constructor(alpha = 0.35, initial = null) {
    this.alpha = alpha;
    this.value = initial;
  }

  push(sample) {
    if (!Number.isFinite(sample)) return this.value;
    this.value = this.value === null ? sample : this.alpha * sample + (1 - this.alpha) * this.value;
    return this.value;
  }

  reset(initial = null) {
    this.value = initial;
  }
}

// --------------------------------------------------------------------- ROI

/**
 * ROI crop (§2.4):
 *   side = clamp(4 x lastBboxHeight, 480, 960), square, centred on the
 *   PREDICTED position, clamped to frame bounds.
 *
 * @param {{cx:number, cy:number, h:number}} predicted  pixels, frame space
 * @param {{width:number, height:number}} frame
 * @param {number} widen  1 = ROI, 2 = 2xROI during loss recovery
 */
export function computeRoi(predicted, frame, widen = 1) {
  const side = clamp(ROI_BBOX_MULTIPLIER * predicted.h * widen, ROI_MIN_PX, ROI_MAX_PX);
  const clamped = Math.min(side, frame.width, frame.height);
  const x = clamp(predicted.cx - clamped / 2, 0, Math.max(0, frame.width - clamped));
  const y = clamp(predicted.cy - clamped / 2, 0, Math.max(0, frame.height - clamped));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(clamped), height: Math.round(clamped) };
}

/**
 * Tiled sweep for acquisition (§2.4) — full-frame coverage in overlapping
 * squares, walked one tile per pass at 1-2 Hz.
 */
export function sweepTiles(frame, tileSide = ROI_MAX_PX, overlap = 0.25) {
  const side = Math.min(tileSide, frame.width, frame.height);
  const step = Math.max(1, Math.round(side * (1 - overlap)));
  const tiles = [];
  for (let y = 0; y + side <= frame.height + step; y += step) {
    for (let x = 0; x + side <= frame.width + step; x += step) {
      tiles.push({
        x: clamp(x, 0, frame.width - side),
        y: clamp(y, 0, frame.height - side),
        width: side,
        height: side,
      });
    }
  }
  return tiles;
}

// ------------------------------------------------------- px/deg calibration

/**
 * Self-calibrating pixels-per-degree (§2.4). Never hard-code a field of view:
 * measure it from tracked pixel motion against the encoder angle.
 *
 *   pxPerDeg = dPixels / dAngleFromEncoder
 *
 * Samples with a tiny angle delta are rejected — dividing by a near-zero
 * denominator turns encoder noise into a wild estimate.
 */
export class PxPerDegEstimator {
  constructor({ minDeltaDeg = 2, alpha = 0.3, initial = null } = {}) {
    this.minDeltaDeg = minDeltaDeg;
    this.filter = new AlphaFilter(alpha, initial);
    this.sampleCount = 0;
  }

  /** @returns {number|null} the current estimate, px per degree. */
  get value() {
    return this.filter.value;
  }

  get calibrated() {
    return this.filter.value !== null && this.sampleCount >= 2;
  }

  /**
   * @param {number} deltaPx     pixel displacement of the tracked object
   * @param {number} deltaDeg    encoder angle change over the same interval
   * @returns {number|null} updated estimate, or null if the sample was rejected
   */
  addSample(deltaPx, deltaDeg) {
    if (!Number.isFinite(deltaPx) || !Number.isFinite(deltaDeg)) return null;
    if (Math.abs(deltaDeg) < this.minDeltaDeg) return null;
    // The object moves across the frame opposite to the camera's own motion.
    const estimate = Math.abs(deltaPx / deltaDeg);
    if (!Number.isFinite(estimate) || estimate <= 0) return null;
    this.sampleCount++;
    return this.filter.push(estimate);
  }

  reset() {
    this.filter.reset(null);
    this.sampleCount = 0;
  }
}

// ---------------------------------------------------------- the control law

/**
 * Turns "where the bbox sits in frame" into "what absolute bearing to command".
 * Works in world angle, not pixels (§2.4), so a detection that arrives after
 * the turret has already moved is still interpreted correctly.
 */
export class TrackingController {
  constructor({
    deadbandDeg = DEADBAND_DEG,
    rateGain = RATE_GAIN,
    minRateDps = MIN_RATE_DPS,
    maxRateDps = MAX_RATE_DPS,
    velocityAlpha = 0.35,
  } = {}) {
    this.deadbandDeg = deadbandDeg;
    this.rateGain = rateGain;
    this.minRateDps = minRateDps;
    this.maxRateDps = maxRateDps;
    this.velocity = new AlphaFilter(velocityAlpha);
    this.lastSubjectDeg = null;
    this.lastT = null;
  }

  reset() {
    this.velocity.reset();
    this.lastSubjectDeg = null;
    this.lastT = null;
  }

  /** Subject's absolute bearing = where the camera points + where it sits in frame. */
  subjectBearingDeg({ bboxCx, frameWidthPx, pxPerDeg, cameraAngleDeg }) {
    const offsetDeg = ((bboxCx - 0.5) * frameWidthPx) / pxPerDeg;
    return cameraAngleDeg + offsetDeg;
  }

  /**
   * @param {object} p
   * @param {number} p.bboxCx           bbox centre, 0..1 of frame width
   * @param {number} p.frameWidthPx
   * @param {number} p.pxPerDeg         from PxPerDegEstimator
   * @param {number} p.cameraAngleDeg   encoder angle (§5.3) — not the last command
   * @param {number} p.leadSec          measured loop latency (§5.6)
   * @param {number} p.tSec             timestamp of this detection, seconds
   * @param {boolean} [p.atLimitCw]     §5.6 — stop asking once the turret is at a stop
   * @param {boolean} [p.atLimitCcw]
   * @returns {{move:boolean, commandDeg:number, subjectDeg:number,
   *            velDegPerSec:number, errorDeg:number, maxRateDps:number,
   *            reason:string}}
   */
  update({
    bboxCx,
    frameWidthPx,
    pxPerDeg,
    cameraAngleDeg,
    leadSec = 0,
    tSec,
    atLimitCw = false,
    atLimitCcw = false,
  }) {
    const subjectDeg = this.subjectBearingDeg({ bboxCx, frameWidthPx, pxPerDeg, cameraAngleDeg });

    // Constant-velocity lead. Without it the horse sits on the trailing edge.
    let velDegPerSec = this.velocity.value ?? 0;
    if (this.lastSubjectDeg !== null && this.lastT !== null) {
      const dt = tSec - this.lastT;
      if (dt > 0) velDegPerSec = this.velocity.push((subjectDeg - this.lastSubjectDeg) / dt) ?? 0;
    }
    this.lastSubjectDeg = subjectDeg;
    this.lastT = tSec;

    const commandDeg = subjectDeg + velDegPerSec * leadSec;
    const errorDeg = commandDeg - cameraAngleDeg;

    // Deadband, so the turret doesn't hunt.
    if (Math.abs(errorDeg) < this.deadbandDeg) {
      return {
        move: false,
        commandDeg,
        subjectDeg,
        velDegPerSec,
        errorDeg,
        maxRateDps: this.minRateDps,
        reason: 'deadband',
      };
    }

    // Software limits are authoritative (§5.6): don't command into a stop.
    if ((errorDeg > 0 && atLimitCw) || (errorDeg < 0 && atLimitCcw)) {
      return {
        move: false,
        commandDeg,
        subjectDeg,
        velDegPerSec,
        errorDeg,
        maxRateDps: this.minRateDps,
        reason: 'at-limit',
      };
    }

    // Rate scales with error: small corrections move slowly and look deliberate.
    const maxRate = clamp(Math.abs(errorDeg) * this.rateGain, this.minRateDps, this.maxRateDps);
    return {
      move: true,
      commandDeg,
      subjectDeg,
      velDegPerSec,
      errorDeg,
      maxRateDps: maxRate,
      reason: 'track',
    };
  }
}

// ---------------------------------------------------------- loss escalation

/**
 * Loss handling (§2.4): widen progressively ROI -> 2xROI -> full-frame sweep
 * while holding the last angle. Never stops the stream; only the search widens.
 */
export const LossStage = Object.freeze({
  ROI: 0,
  WIDE: 1,
  SWEEP: 2,
});

export class LossEscalator {
  constructor({ roiMs = 600, wideMs = 1500 } = {}) {
    this.roiMs = roiMs;
    this.wideMs = wideMs;
    this.lostSinceMs = null;
  }

  onDetection() {
    this.lostSinceMs = null;
  }

  onMiss(nowMs) {
    if (this.lostSinceMs === null) this.lostSinceMs = nowMs;
  }

  get lost() {
    return this.lostSinceMs !== null;
  }

  stage(nowMs) {
    if (this.lostSinceMs === null) return LossStage.ROI;
    const elapsed = nowMs - this.lostSinceMs;
    if (elapsed < this.roiMs) return LossStage.ROI;
    if (elapsed < this.roiMs + this.wideMs) return LossStage.WIDE;
    return LossStage.SWEEP;
  }

  /** ROI widening factor for the current stage. */
  widen(nowMs) {
    return this.stage(nowMs) === LossStage.WIDE ? 2 : 1;
  }
}

/**
 * Acquisition lock: a `horse` must clear threshold on N consecutive passes
 * before we call it the subject (§2.4). The rider is normally alone in the
 * paddock, so the highest-confidence horse IS the subject.
 */
export class AcquisitionLock {
  constructor({ passes = ACQUIRE_CONSECUTIVE_PASSES, threshold = 0.4 } = {}) {
    this.requiredPasses = passes;
    this.threshold = threshold;
    this.consecutive = 0;
  }

  /**
   * @param {Array<{category:string, score:number}>} detections
   * @returns {{locked:boolean, consecutive:number, best:object|null}}
   */
  push(detections = []) {
    const horses = detections.filter((d) => d.category === 'horse' && d.score >= this.threshold);
    const best = horses.reduce((a, b) => (a === null || b.score > a.score ? b : a), null);
    this.consecutive = best ? this.consecutive + 1 : 0;
    return { locked: this.consecutive >= this.requiredPasses, consecutive: this.consecutive, best };
  }

  reset() {
    this.consecutive = 0;
  }
}
