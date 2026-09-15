/**
 * Paddock Pal BLE data contract — README §5.
 *
 * SINGLE SOURCE OF TRUTH for byte layouts. Nothing else in this repo may
 * encode or decode a turret packet. The ESP32 header is generated from here
 * (`npm run protocol:header`) so the two sides cannot drift.
 *
 * All multi-byte fields are little-endian.
 * All angles are centidegrees (1/100 deg), signed, relative to `home`.
 */

// ---------------------------------------------------------------- §5.1 GATT

export const SERVICE_UUID = 'e7a10000-9d3c-4b21-b0f5-2c7a6d18e4f1';
export const CONTROL_UUID = 'e7a10001-9d3c-4b21-b0f5-2c7a6d18e4f1';
export const STATE_UUID = 'e7a10002-9d3c-4b21-b0f5-2c7a6d18e4f1';
export const EVENT_UUID = 'e7a10003-9d3c-4b21-b0f5-2c7a6d18e4f1';
export const CONFIG_UUID = 'e7a10004-9d3c-4b21-b0f5-2c7a6d18e4f1';

export const CONTROL_BYTES = 8;
export const STATE_BYTES = 12;
export const EVENT_BYTES = 2;
export const CONFIG_BYTES = 8;

/** Requested BLE connection interval, milliseconds (§5.1). */
export const CONN_INTERVAL_MS = { min: 15, max: 30 };

/** No Control write for this long → ESP32 holds position, shows LOST (§5.6). */
export const COMMAND_TIMEOUT_MS = 1000;

// ------------------------------------------------------------- enumerations

/** Control.mode (§5.2). */
export const Mode = Object.freeze({
  IDLE: 0,
  TRACK: 1,
  GOTO: 2,
  CALIBRATE: 3,
});

/** Control.display_state — drives the GC9A01 face (§5.2). */
export const DisplayState = Object.freeze({
  IDLE: 0,
  SEARCHING: 1,
  LOCKED: 2,
  LOST: 3,
  ERROR: 4,
});

/** Control.flags bitfield (§5.2). */
export const ControlFlags = Object.freeze({
  MOTOR_ENABLE: 1 << 0,
  HOME_REQUEST: 1 << 1,
});

/** State.status bitfield (§5.3). */
export const StatusBits = Object.freeze({
  MOTOR_ENABLED: 1 << 0,
  AT_LIMIT_CW: 1 << 1,
  AT_LIMIT_CCW: 1 << 2,
  CALIBRATED: 1 << 3,
  FAULT: 1 << 4,
  CHARGING: 1 << 5,
});

/** Event.event_id (§5.4). */
export const EventId = Object.freeze({
  FOB_START_STOP: 1,
  FOB_REACQUIRE: 2,
  BUTTON_TOP: 3,
  LIMIT_HIT: 4,
  FAULT: 5,
  LOW_BATTERY: 6,
});

/** Config.accel_profile (§5.5). */
export const AccelProfile = Object.freeze({
  SMOOTH: 0,
  RESPONSIVE: 1,
});

// ------------------------------------------------------------------- limits

/** target_cdeg is int16 but the contract narrows it to +/-180.00 deg. */
export const ANGLE_MIN_CDEG = -18000;
export const ANGLE_MAX_CDEG = 18000;

/** State.temp_c carries a +40 offset: raw 40 means 0 C (§5.3). */
export const TEMP_OFFSET_C = 40;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Centidegrees, rounded and clamped to the contract's angle range. */
export function clampAngleCdeg(cdeg) {
  return clamp(Math.round(cdeg), ANGLE_MIN_CDEG, ANGLE_MAX_CDEG);
}

export const degToCdeg = (deg) => Math.round(deg * 100);
export const cdegToDeg = (cdeg) => cdeg / 100;

// ------------------------------------------------------- §5.2 Control (8 B)

/**
 * @param {{seq:number, mode:number, targetCdeg:number, maxRateCds:number,
 *          flags:number, displayState:number}} msg
 * @returns {ArrayBuffer} 8 bytes, phone -> ESP32
 */
export function encodeControl({
  seq = 0,
  mode = Mode.IDLE,
  targetCdeg = 0,
  maxRateCds = 0,
  flags = 0,
  displayState = DisplayState.IDLE,
} = {}) {
  const v = new DataView(new ArrayBuffer(CONTROL_BYTES));
  v.setUint8(0, seq & 0xff);
  v.setUint8(1, mode & 0xff);
  v.setInt16(2, clampAngleCdeg(targetCdeg), true);
  v.setUint16(4, clamp(Math.round(maxRateCds), 0, 0xffff), true);
  v.setUint8(6, flags & 0xff);
  v.setUint8(7, displayState & 0xff);
  return v.buffer;
}

/** Inverse of {@link encodeControl}. Used by the fake transport and tests. */
export function decodeControl(buffer) {
  const v = asDataView(buffer, CONTROL_BYTES, 'Control');
  return {
    seq: v.getUint8(0),
    mode: v.getUint8(1),
    targetCdeg: v.getInt16(2, true),
    maxRateCds: v.getUint16(4, true),
    flags: v.getUint8(6),
    displayState: v.getUint8(7),
    motorEnabled: Boolean(v.getUint8(6) & ControlFlags.MOTOR_ENABLE),
    homeRequest: Boolean(v.getUint8(6) & ControlFlags.HOME_REQUEST),
  };
}

// --------------------------------------------------------- §5.3 State (12 B)

/** @returns {ArrayBuffer} 12 bytes, ESP32 -> phone. Mirror for the fake turret. */
export function encodeState({
  seqEcho = 0,
  status = 0,
  angleCdeg = 0,
  rateCds = 0,
  vbatMv = 0,
  battPct = 0,
  tempC = 0,
  faultCode = 0,
} = {}) {
  const v = new DataView(new ArrayBuffer(STATE_BYTES));
  v.setUint8(0, seqEcho & 0xff);
  v.setUint8(1, status & 0xff);
  v.setInt16(2, clampAngleCdeg(angleCdeg), true);
  v.setInt16(4, clamp(Math.round(rateCds), -32768, 32767), true);
  v.setUint16(6, clamp(Math.round(vbatMv), 0, 0xffff), true);
  v.setUint8(8, clamp(Math.round(battPct), 0, 100));
  v.setUint8(9, clamp(Math.round(tempC) + TEMP_OFFSET_C, 0, 255));
  v.setUint8(10, faultCode & 0xff);
  v.setUint8(11, 0);
  return v.buffer;
}

/**
 * @param {DataView|ArrayBuffer} buffer
 * @returns decoded State with `status` expanded into booleans.
 */
export function decodeState(buffer) {
  const v = asDataView(buffer, STATE_BYTES, 'State');
  const status = v.getUint8(1);
  return {
    seqEcho: v.getUint8(0),
    status,
    motorEnabled: Boolean(status & StatusBits.MOTOR_ENABLED),
    atLimitCw: Boolean(status & StatusBits.AT_LIMIT_CW),
    atLimitCcw: Boolean(status & StatusBits.AT_LIMIT_CCW),
    calibrated: Boolean(status & StatusBits.CALIBRATED),
    fault: Boolean(status & StatusBits.FAULT),
    charging: Boolean(status & StatusBits.CHARGING),
    angleCdeg: v.getInt16(2, true),
    angleDeg: cdegToDeg(v.getInt16(2, true)),
    rateCds: v.getInt16(4, true),
    vbatMv: v.getUint16(6, true),
    battPct: v.getUint8(8),
    tempC: v.getUint8(9) - TEMP_OFFSET_C,
    faultCode: v.getUint8(10),
  };
}

// --------------------------------------------------------- §5.4 Event (2 B)

export function encodeEvent({ eventId = 0, arg = 0 } = {}) {
  const v = new DataView(new ArrayBuffer(EVENT_BYTES));
  v.setUint8(0, eventId & 0xff);
  v.setUint8(1, arg & 0xff);
  return v.buffer;
}

export function decodeEvent(buffer) {
  const v = asDataView(buffer, EVENT_BYTES, 'Event');
  return { eventId: v.getUint8(0), arg: v.getUint8(1) };
}

const EVENT_NAMES = {
  [EventId.FOB_START_STOP]: 'FOB_START_STOP',
  [EventId.FOB_REACQUIRE]: 'FOB_REACQUIRE',
  [EventId.BUTTON_TOP]: 'BUTTON_TOP',
  [EventId.LIMIT_HIT]: 'LIMIT_HIT',
  [EventId.FAULT]: 'FAULT',
  [EventId.LOW_BATTERY]: 'LOW_BATTERY',
};

export function eventName(eventId) {
  return EVENT_NAMES[eventId] ?? `UNKNOWN_${eventId}`;
}

// -------------------------------------------------------- §5.5 Config (8 B)

export function encodeConfig({
  limitCwCdeg = ANGLE_MAX_CDEG,
  limitCcwCdeg = ANGLE_MIN_CDEG,
  defaultRateCds = 6000,
  accelProfile = AccelProfile.SMOOTH,
} = {}) {
  const v = new DataView(new ArrayBuffer(CONFIG_BYTES));
  v.setInt16(0, clampAngleCdeg(limitCwCdeg), true);
  v.setInt16(2, clampAngleCdeg(limitCcwCdeg), true);
  v.setUint16(4, clamp(Math.round(defaultRateCds), 0, 0xffff), true);
  v.setUint8(6, accelProfile & 0xff);
  v.setUint8(7, 0);
  return v.buffer;
}

export function decodeConfig(buffer) {
  const v = asDataView(buffer, CONFIG_BYTES, 'Config');
  return {
    limitCwCdeg: v.getInt16(0, true),
    limitCcwCdeg: v.getInt16(2, true),
    defaultRateCds: v.getUint16(4, true),
    accelProfile: v.getUint8(6),
  };
}

// ------------------------------------------------------------------ helpers

/**
 * Round-trip latency from seq / seq_echo (§5.6). `seq` wraps at 255, so match
 * on the wrapped value and keep a short ring of send timestamps.
 */
export class LatencyTracker {
  constructor({ historySize = 16, now = () => performance.now() } = {}) {
    this.now = now;
    this.historySize = historySize;
    /** @type {Map<number, number>} seq -> send timestamp */
    this.sent = new Map();
    /** @type {number[]} recent round-trip samples, milliseconds */
    this.samples = [];
    this.lastRttMs = null;
  }

  /** Call when a Control packet with `seq` goes out. */
  onSent(seq, t = this.now()) {
    this.sent.set(seq & 0xff, t);
    if (this.sent.size > this.historySize) {
      // Map preserves insertion order, so the first key is the oldest.
      this.sent.delete(this.sent.keys().next().value);
    }
  }

  /**
   * Call with `seq_echo` from a State notification.
   * @returns {number|null} the round-trip time in ms, or null if unmatched.
   */
  onEcho(seqEcho, t = this.now()) {
    const sentAt = this.sent.get(seqEcho & 0xff);
    if (sentAt === undefined) return null;
    this.sent.delete(seqEcho & 0xff);
    const rtt = t - sentAt;
    this.lastRttMs = rtt;
    this.samples.push(rtt);
    if (this.samples.length > this.historySize) this.samples.shift();
    return rtt;
  }

  /** Median round-trip — robust against the odd BLE stall. */
  get medianRttMs() {
    if (!this.samples.length) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Lead time for the predictor (§2.4): half the round trip, in seconds. */
  get leadSec() {
    const rtt = this.medianRttMs;
    return rtt === null ? 0 : rtt / 2000;
  }

  reset() {
    this.sent.clear();
    this.samples.length = 0;
    this.lastRttMs = null;
  }
}

/** Monotonic 8-bit sequence counter, wrapping at 255 (§5.2). */
export function makeSeqCounter(start = 0) {
  let seq = start & 0xff;
  return () => {
    const v = seq;
    seq = (seq + 1) & 0xff;
    return v;
  };
}

function asDataView(buffer, expectedBytes, label) {
  const v =
    buffer instanceof DataView
      ? buffer
      : new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  if (v.byteLength < expectedBytes) {
    throw new RangeError(`${label} packet too short: ${v.byteLength} < ${expectedBytes} bytes`);
  }
  return v;
}
