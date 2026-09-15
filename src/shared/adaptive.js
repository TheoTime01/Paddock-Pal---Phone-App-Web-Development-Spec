/**
 * The adaptive controller — README §3.4.
 *
 * One function, one place, so the policy "live streaming is the product;
 * detection rate is what gives way" cannot drift across the codebase.
 */

import { clamp } from './protocol.js';

export const DETECT_INTERVAL_BASE_MS = 100; // 10 Hz (§2.3)
export const DETECT_INTERVAL_MAX_MS = 500; // 2 Hz floor for detection
export const DETECT_INTERVAL_STEP_MS = 50;

export const BITRATE_MAX = 2_500_000; // §3.2
export const BITRATE_MIN = 600_000;
export const BITRATE_STEP = 400_000;

/** Preflight verdict thresholds (§3.5). */
export const PREFLIGHT = Object.freeze({
  GREEN: { minBitrate: 2_000_000, maxLoss: 0.02 },
  AMBER: { minBitrate: 800_000, maxLoss: 0.05 },
});

/**
 * @param {number} bitrateBps sustained uplink bitrate
 * @param {number} lossRatio  0..1 packet loss
 * @returns {'green'|'amber'|'red'}
 */
export function preflightVerdict(bitrateBps, lossRatio) {
  if (bitrateBps >= PREFLIGHT.GREEN.minBitrate && lossRatio < PREFLIGHT.GREEN.maxLoss) return 'green';
  if (bitrateBps >= PREFLIGHT.AMBER.minBitrate && lossRatio <= PREFLIGHT.AMBER.maxLoss) return 'amber';
  return 'red';
}

/**
 * Map `qualityLimitationReason` onto the one response the spec allows.
 *
 * | none      | healthy            | restore detector rate            |
 * | bandwidth | uplink-limited     | let WebRTC adapt, surface amber  |
 * | cpu       | compute-bound      | raise detectIntervalMs           |
 * | thermal   | throttling         | raise it further, then drop rate |
 *
 * @param {{detectIntervalMs:number, maxBitrate:number}} current
 * @param {string} reason
 * @returns {{detectIntervalMs:number, maxBitrate:number, health:'ok'|'degraded'|'throttled', note:string}}
 */
export function adapt(current, reason) {
  const detect = current.detectIntervalMs ?? DETECT_INTERVAL_BASE_MS;
  const bitrate = current.maxBitrate ?? BITRATE_MAX;

  switch (reason) {
    case 'cpu':
      return {
        detectIntervalMs: clamp(detect + DETECT_INTERVAL_STEP_MS, DETECT_INTERVAL_BASE_MS, DETECT_INTERVAL_MAX_MS),
        maxBitrate: bitrate,
        health: 'degraded',
        note: 'CPU-bound: lowering detection rate',
      };

    case 'thermal': {
      const nextDetect = clamp(
        detect + DETECT_INTERVAL_STEP_MS * 2,
        DETECT_INTERVAL_BASE_MS,
        DETECT_INTERVAL_MAX_MS,
      );
      // Video only gives way once detection has nothing left to give.
      const nextBitrate =
        nextDetect >= DETECT_INTERVAL_MAX_MS
          ? clamp(bitrate - BITRATE_STEP, BITRATE_MIN, BITRATE_MAX)
          : bitrate;
      return {
        detectIntervalMs: nextDetect,
        maxBitrate: nextBitrate,
        health: 'throttled',
        note:
          nextBitrate < bitrate
            ? 'Thermal: detection at floor, dropping bitrate'
            : 'Thermal: lowering detection rate',
      };
    }

    case 'bandwidth':
      // Let WebRTC do its own thing with the encoder; just tell the viewer.
      return {
        detectIntervalMs: detect,
        maxBitrate: bitrate,
        health: 'degraded',
        note: 'Uplink-limited: WebRTC adapting',
      };

    case 'none':
    default:
      return {
        detectIntervalMs: clamp(
          detect - DETECT_INTERVAL_STEP_MS,
          DETECT_INTERVAL_BASE_MS,
          DETECT_INTERVAL_MAX_MS,
        ),
        maxBitrate: clamp(bitrate + BITRATE_STEP, BITRATE_MIN, BITRATE_MAX),
        health: 'ok',
        note: 'Healthy',
      };
  }
}

/**
 * Exponential backoff for WHIP/WHEP/BLE reconnects: 1, 2, 4, 8 s, cap 15 s
 * (§3.3). Jitter keeps a venue full of phones from retrying in lockstep.
 */
export function backoffMs(attempt, { baseMs = 1000, capMs = 15000, jitter = 0.2 } = {}) {
  const raw = Math.min(baseMs * 2 ** Math.max(0, attempt), capMs);
  const spread = raw * jitter;
  return Math.round(raw - spread / 2 + Math.random() * spread);
}
