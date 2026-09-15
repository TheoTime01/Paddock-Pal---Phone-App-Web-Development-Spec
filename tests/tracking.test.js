/** §2.4 — ROI, calibration, the control law and loss escalation. */
import { describe, expect, it } from 'vitest';
import {
  AcquisitionLock,
  DEADBAND_DEG,
  LossEscalator,
  LossStage,
  MAX_RATE_DPS,
  PxPerDegEstimator,
  ROI_MAX_PX,
  ROI_MIN_PX,
  TrackingController,
  computeRoi,
  sweepTiles,
} from '../src/shared/tracking.js';

const FRAME = { width: 1280, height: 720 };

describe('ROI crop', () => {
  it('is 4x the bbox height, clamped to 480..960, square', () => {
    expect(computeRoi({ cx: 640, cy: 360, h: 160 }, FRAME).width).toBe(640); // 4 x 160
    expect(computeRoi({ cx: 640, cy: 360, h: 20 }, FRAME).width).toBe(ROI_MIN_PX);
    expect(computeRoi({ cx: 640, cy: 360, h: 400 }, FRAME).width).toBe(Math.min(ROI_MAX_PX, FRAME.height));
  });

  it('stays inside the frame when the subject is at the edge', () => {
    const roi = computeRoi({ cx: 0, cy: 0, h: 160 }, FRAME);
    expect(roi.x).toBe(0);
    expect(roi.y).toBe(0);

    const far = computeRoi({ cx: FRAME.width, cy: FRAME.height, h: 160 }, FRAME);
    expect(far.x + far.width).toBeLessThanOrEqual(FRAME.width);
    expect(far.y + far.height).toBeLessThanOrEqual(FRAME.height);
  });

  it('doubles for the WIDE loss stage', () => {
    const roi = computeRoi({ cx: 640, cy: 360, h: 100 }, FRAME);
    const wide = computeRoi({ cx: 640, cy: 360, h: 100 }, FRAME, 2);
    expect(wide.width).toBeGreaterThan(roi.width);
  });

  it('sweep tiles cover the whole frame', () => {
    const tiles = sweepTiles(FRAME);
    expect(tiles.length).toBeGreaterThan(1);
    expect(Math.min(...tiles.map((t) => t.x))).toBe(0);
    expect(Math.max(...tiles.map((t) => t.x + t.width))).toBe(FRAME.width);
  });
});

describe('px/deg self-calibration', () => {
  it('solves dPixels / dAngle', () => {
    const est = new PxPerDegEstimator({ alpha: 1 });
    est.addSample(160, 8); // 160 px over 8 deg
    expect(est.value).toBeCloseTo(20);
  });

  it('rejects samples with too small an angle delta', () => {
    const est = new PxPerDegEstimator({ minDeltaDeg: 2 });
    expect(est.addSample(300, 0.1)).toBeNull(); // would read as 3000 px/deg
    expect(est.value).toBeNull();
  });

  it('is sign-agnostic — the camera and the subject move opposite ways', () => {
    const est = new PxPerDegEstimator({ alpha: 1 });
    est.addSample(-160, 8);
    expect(est.value).toBeCloseTo(20);
  });
});

describe('control law', () => {
  const base = { frameWidthPx: 1280, pxPerDeg: 20, cameraAngleDeg: 0, leadSec: 0 };

  it('converts frame offset into an absolute bearing', () => {
    const c = new TrackingController();
    // bbox 25% right of centre: 0.25 * 1280 = 320 px = 16 deg at 20 px/deg
    const out = c.update({ ...base, bboxCx: 0.75, cameraAngleDeg: 30, tSec: 0 });
    expect(out.subjectDeg).toBeCloseTo(46);
  });

  it('holds inside the deadband, so the turret does not hunt', () => {
    const c = new TrackingController();
    const smallOffset = 0.5 + (DEADBAND_DEG * 0.5 * 20) / 1280; // half a deadband
    const out = c.update({ ...base, bboxCx: smallOffset, tSec: 0 });
    expect(out.move).toBe(false);
    expect(out.reason).toBe('deadband');
  });

  it('leads a moving subject by velocity x measured latency', () => {
    const c = new TrackingController({ velocityAlpha: 1 });
    // Two frames 0.1 s apart, subject moving right at 20 deg/s.
    c.update({ ...base, bboxCx: 0.5, tSec: 0 });
    const out = c.update({ ...base, bboxCx: 0.5 + 2 / 12.8 / 5, tSec: 0.1, leadSec: 0.1 });
    expect(out.velDegPerSec).toBeGreaterThan(0);
    expect(out.commandDeg).toBeGreaterThan(out.subjectDeg); // lead is ahead of now
  });

  it('scales rate with error and never exceeds MAX_RATE', () => {
    const c = new TrackingController();
    const small = c.update({ ...base, bboxCx: 0.62, tSec: 0 });
    c.reset();
    const large = c.update({ ...base, bboxCx: 1.0, tSec: 0 });
    expect(small.maxRateDps).toBeLessThan(large.maxRateDps);
    expect(large.maxRateDps).toBeLessThanOrEqual(MAX_RATE_DPS);
  });

  it('stops commanding into a software limit (§5.6)', () => {
    const c = new TrackingController();
    const out = c.update({ ...base, bboxCx: 1.0, tSec: 0, atLimitCw: true });
    expect(out.move).toBe(false);
    expect(out.reason).toBe('at-limit');
  });

  it('uses the encoder angle, so a stale detection still resolves correctly', () => {
    const c = new TrackingController();
    // Same bbox, camera has since panned 10 deg: the bearing must follow it.
    const a = c.update({ ...base, bboxCx: 0.75, cameraAngleDeg: 0, tSec: 0 });
    c.reset();
    const b = c.update({ ...base, bboxCx: 0.75, cameraAngleDeg: 10, tSec: 0 });
    expect(b.subjectDeg - a.subjectDeg).toBeCloseTo(10);
  });
});

describe('acquisition and loss', () => {
  it('locks only after 3 consecutive passes', () => {
    const lock = new AcquisitionLock({ threshold: 0.4 });
    const horse = [{ category: 'horse', score: 0.8 }];
    expect(lock.push(horse).locked).toBe(false);
    expect(lock.push(horse).locked).toBe(false);
    expect(lock.push(horse).locked).toBe(true);
  });

  it('resets the run on a miss', () => {
    const lock = new AcquisitionLock();
    lock.push([{ category: 'horse', score: 0.9 }]);
    lock.push([{ category: 'person', score: 0.9 }]); // person alone is not a lock
    expect(lock.consecutive).toBe(0);
  });

  it('takes the highest-confidence horse — the rider is alone in the paddock', () => {
    const lock = new AcquisitionLock();
    const { best } = lock.push([
      { category: 'horse', score: 0.55 },
      { category: 'horse', score: 0.91 },
    ]);
    expect(best.score).toBe(0.91);
  });

  it('widens ROI -> 2xROI -> full-frame sweep while lost', () => {
    const esc = new LossEscalator({ roiMs: 600, wideMs: 1500 });
    esc.onMiss(0);
    expect(esc.stage(100)).toBe(LossStage.ROI);
    expect(esc.stage(900)).toBe(LossStage.WIDE);
    expect(esc.stage(3000)).toBe(LossStage.SWEEP);
    esc.onDetection();
    expect(esc.lost).toBe(false);
  });
});
