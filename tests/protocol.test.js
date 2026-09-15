/** §5 — the BLE data contract. Every field offset here is normative. */
import { describe, expect, it } from 'vitest';
import {
  ANGLE_MAX_CDEG,
  ANGLE_MIN_CDEG,
  CONTROL_BYTES,
  ControlFlags,
  DisplayState,
  EVENT_BYTES,
  EventId,
  LatencyTracker,
  Mode,
  STATE_BYTES,
  StatusBits,
  decodeConfig,
  decodeControl,
  decodeEvent,
  decodeState,
  encodeConfig,
  encodeControl,
  encodeEvent,
  encodeState,
  makeSeqCounter,
} from '../src/shared/protocol.js';

describe('Control (§5.2)', () => {
  it('is 8 bytes with the documented layout, little-endian', () => {
    const buf = encodeControl({
      seq: 200,
      mode: Mode.TRACK,
      targetCdeg: -4500,
      maxRateCds: 15000,
      flags: ControlFlags.MOTOR_ENABLE,
      displayState: DisplayState.LOCKED,
    });
    expect(buf.byteLength).toBe(CONTROL_BYTES);

    const v = new DataView(buf);
    expect(v.getUint8(0)).toBe(200);
    expect(v.getUint8(1)).toBe(Mode.TRACK);
    expect(v.getInt16(2, true)).toBe(-4500);
    expect(v.getUint16(4, true)).toBe(15000);
    expect(v.getUint8(6)).toBe(1);
    expect(v.getUint8(7)).toBe(DisplayState.LOCKED);
  });

  it('round-trips', () => {
    const msg = {
      seq: 7,
      mode: Mode.GOTO,
      targetCdeg: 12345,
      maxRateCds: 900,
      flags: ControlFlags.MOTOR_ENABLE | ControlFlags.HOME_REQUEST,
      displayState: DisplayState.SEARCHING,
    };
    const out = decodeControl(encodeControl(msg));
    expect(out).toMatchObject(msg);
    expect(out.motorEnabled).toBe(true);
    expect(out.homeRequest).toBe(true);
  });

  it('wraps seq at 255 and clamps the angle to +/-180.00 deg', () => {
    expect(new DataView(encodeControl({ seq: 256 })).getUint8(0)).toBe(0);
    expect(decodeControl(encodeControl({ targetCdeg: 99999 })).targetCdeg).toBe(ANGLE_MAX_CDEG);
    expect(decodeControl(encodeControl({ targetCdeg: -99999 })).targetCdeg).toBe(ANGLE_MIN_CDEG);
  });
});

describe('State (§5.3)', () => {
  it('is 12 bytes and carries the +40 temperature offset', () => {
    const buf = encodeState({ tempC: 0 });
    expect(buf.byteLength).toBe(STATE_BYTES);
    expect(new DataView(buf).getUint8(9)).toBe(40); // value 40 = 0 C
    expect(decodeState(buf).tempC).toBe(0);
  });

  it('expands the status bitfield', () => {
    const status = StatusBits.MOTOR_ENABLED | StatusBits.AT_LIMIT_CW | StatusBits.CALIBRATED;
    const s = decodeState(encodeState({ status, angleCdeg: -1250, rateCds: -300, battPct: 64 }));
    expect(s.motorEnabled).toBe(true);
    expect(s.atLimitCw).toBe(true);
    expect(s.atLimitCcw).toBe(false);
    expect(s.calibrated).toBe(true);
    expect(s.fault).toBe(false);
    expect(s.angleCdeg).toBe(-1250);
    expect(s.angleDeg).toBeCloseTo(-12.5);
    expect(s.rateCds).toBe(-300);
    expect(s.battPct).toBe(64);
  });

  it('rejects a short packet rather than reading garbage', () => {
    expect(() => decodeState(new ArrayBuffer(6))).toThrow(/too short/);
  });
});

describe('Event (§5.4) and Config (§5.5)', () => {
  it('encodes an event in 2 bytes', () => {
    const buf = encodeEvent({ eventId: EventId.LIMIT_HIT, arg: 1 });
    expect(buf.byteLength).toBe(EVENT_BYTES);
    expect(decodeEvent(buf)).toEqual({ eventId: EventId.LIMIT_HIT, arg: 1 });
  });

  it('round-trips config', () => {
    const cfg = { limitCwCdeg: 16000, limitCcwCdeg: -16000, defaultRateCds: 7200, accelProfile: 1 };
    expect(decodeConfig(encodeConfig(cfg))).toEqual(cfg);
  });
});

describe('LatencyTracker (§5.6) — latency is measured, not assumed', () => {
  it('matches seq to seq_echo and yields a lead of half the round trip', () => {
    let t = 0;
    const lt = new LatencyTracker({ now: () => t });

    for (const rtt of [80, 120, 100]) {
      const seq = 1;
      lt.onSent(seq, t);
      t += rtt;
      expect(lt.onEcho(seq, t)).toBe(rtt);
    }
    expect(lt.medianRttMs).toBe(100);
    expect(lt.leadSec).toBeCloseTo(0.05);
  });

  it('ignores an echo it never sent', () => {
    const lt = new LatencyTracker({ now: () => 0 });
    expect(lt.onEcho(42)).toBeNull();
    expect(lt.leadSec).toBe(0);
  });

  it('survives seq wrapping', () => {
    let t = 0;
    const lt = new LatencyTracker({ now: () => t });
    const next = makeSeqCounter(254);
    expect([next(), next(), next()]).toEqual([254, 255, 0]);
    lt.onSent(0, 0);
    t = 60;
    expect(lt.onEcho(256, t)).toBe(60); // 256 & 0xff === 0
  });
});
