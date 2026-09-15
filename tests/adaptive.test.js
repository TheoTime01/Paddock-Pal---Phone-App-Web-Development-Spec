/** §3.4/§3.5 — the adaptive controller and the preflight verdicts. */
import { describe, expect, it } from 'vitest';
import {
  BITRATE_MAX,
  DETECT_INTERVAL_BASE_MS,
  DETECT_INTERVAL_MAX_MS,
  adapt,
  backoffMs,
  preflightVerdict,
} from '../src/shared/adaptive.js';

const healthy = { detectIntervalMs: DETECT_INTERVAL_BASE_MS, maxBitrate: BITRATE_MAX };

describe('adapt (§3.4)', () => {
  it('cpu-bound drops detection rate, not video', () => {
    const out = adapt(healthy, 'cpu');
    expect(out.detectIntervalMs).toBeGreaterThan(DETECT_INTERVAL_BASE_MS);
    expect(out.maxBitrate).toBe(BITRATE_MAX);
  });

  it('thermal degrades detection FIRST and only then bitrate', () => {
    let s = { ...healthy };
    let sawBitrateDrop = false;
    for (let i = 0; i < 10; i++) {
      const next = adapt(s, 'thermal');
      if (next.maxBitrate < s.maxBitrate) {
        // Video may only give way once detection has nothing left to give.
        expect(next.detectIntervalMs).toBe(DETECT_INTERVAL_MAX_MS);
        sawBitrateDrop = true;
      }
      s = next;
    }
    expect(sawBitrateDrop).toBe(true);
  });

  it('bandwidth limitation leaves both alone — WebRTC adapts itself', () => {
    const out = adapt(healthy, 'bandwidth');
    expect(out.detectIntervalMs).toBe(DETECT_INTERVAL_BASE_MS);
    expect(out.maxBitrate).toBe(BITRATE_MAX);
    expect(out.health).toBe('degraded');
  });

  it('restores the detector rate once healthy', () => {
    const degraded = { detectIntervalMs: 300, maxBitrate: 1_000_000 };
    const out = adapt(degraded, 'none');
    expect(out.detectIntervalMs).toBeLessThan(300);
    expect(out.maxBitrate).toBeGreaterThan(1_000_000);
    expect(out.health).toBe('ok');
  });

  it('never runs away past its floors and ceilings', () => {
    let s = { ...healthy };
    for (let i = 0; i < 50; i++) s = adapt(s, 'cpu');
    expect(s.detectIntervalMs).toBe(DETECT_INTERVAL_MAX_MS);
    for (let i = 0; i < 50; i++) s = adapt(s, 'none');
    expect(s.detectIntervalMs).toBe(DETECT_INTERVAL_BASE_MS);
    expect(s.maxBitrate).toBe(BITRATE_MAX);
  });
});

describe('preflight verdicts (§3.5)', () => {
  it.each([
    [2_500_000, 0.01, 'green'],
    [2_000_000, 0.019, 'green'],
    [2_500_000, 0.03, 'amber'], // plenty of bitrate but lossy
    [1_200_000, 0.03, 'amber'],
    [800_000, 0.05, 'amber'],
    [700_000, 0.01, 'red'],
    [2_500_000, 0.09, 'red'],
  ])('%i bps at %f loss is %s', (bitrate, loss, expected) => {
    expect(preflightVerdict(bitrate, loss)).toBe(expected);
  });
});

describe('backoff (§3.3)', () => {
  it('follows 1, 2, 4, 8 s and caps at 15 s', () => {
    const nominal = (a) => backoffMs(a, { jitter: 0 });
    expect([nominal(0), nominal(1), nominal(2), nominal(3)]).toEqual([1000, 2000, 4000, 8000]);
    expect(nominal(10)).toBe(15000);
  });

  it('jitters so a venue full of phones does not retry in lockstep', () => {
    const values = new Set(Array.from({ length: 20 }, () => backoffMs(2)));
    expect(values.size).toBeGreaterThan(1);
  });
});
