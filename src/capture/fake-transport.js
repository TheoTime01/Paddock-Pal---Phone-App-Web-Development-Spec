/**
 * Fake transport — README build order step 4.
 *
 * Implements §5 against a simulated turret: it logs Control writes, integrates
 * a plausible trajectory towards the commanded target, and notifies State at
 * 10 Hz with the seq echoed back. The whole control loop can be developed and
 * tuned before the ESP32 exists.
 *
 * It also honours the normative behaviours so they get exercised in dev:
 *  - command timeout: no Control for 1000 ms -> hold position, LOST face
 *  - the firmware clamps rate; the phone only requests
 *  - targets, never steps: this model generates its own trajectory
 */

import {
  COMMAND_TIMEOUT_MS,
  EventId,
  Mode,
  StatusBits,
  clamp,
  decodeControl,
  decodeState,
  encodeEvent,
  encodeState,
} from '../shared/protocol.js';

export class FakeTurretTransport extends EventTarget {
  constructor({
    notifyHz = 10,
    tickHz = 50,
    latencyMs = 35,
    firmwareMaxRateCds = 15000, // 150 deg/s — the firmware's own ceiling
    limitCwCdeg = 17000,
    limitCcwCdeg = -17000,
    log = false,
  } = {}) {
    super();
    this.notifyPeriodMs = 1000 / notifyHz;
    this.tickPeriodMs = 1000 / tickHz;
    this.latencyMs = latencyMs;
    this.firmwareMaxRateCds = firmwareMaxRateCds;
    this.limitCwCdeg = limitCwCdeg;
    this.limitCcwCdeg = limitCcwCdeg;
    this.log = log;

    this.connected = false;
    this.angleCdeg = 0;
    this.rateCds = 0;
    this.seqEcho = 0;
    this.targetCdeg = 0;
    this.maxRateCds = 0;
    this.motorEnabled = false;
    this.mode = Mode.IDLE;
    this.lastControlAt = 0;
    this.timedOut = false;
    this.writes = [];

    this._tick = null;
    this._notify = null;
  }

  async connect() {
    this.connected = true;
    this.lastControlAt = Date.now();
    this._tick = setInterval(() => this.step(), this.tickPeriodMs);
    this._notify = setInterval(() => this.notifyState(), this.notifyPeriodMs);
    this.dispatchEvent(new CustomEvent('connected', { detail: { fake: true } }));
  }

  async disconnect() {
    this.connected = false;
    clearInterval(this._tick);
    clearInterval(this._notify);
    this._tick = this._notify = null;
    this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason: 'closed' } }));
  }

  async write(buffer) {
    if (!this.connected) throw new Error('fake turret not connected');
    const msg = decodeControl(buffer);
    this.writes.push(msg);
    if (this.log) console.debug('[fake turret] control', msg);

    // Simulate air time so seq/seq_echo produces a realistic RTT.
    await delay(this.latencyMs / 2);

    this.lastControlAt = Date.now();
    this.timedOut = false;
    this.seqEcho = msg.seq;
    this.mode = msg.mode;
    this.motorEnabled = msg.motorEnabled;
    this.targetCdeg = msg.targetCdeg;
    // The ESP32 clamps, the phone requests (§5.6).
    this.maxRateCds =
      msg.maxRateCds === 0 ? this.firmwareMaxRateCds : Math.min(msg.maxRateCds, this.firmwareMaxRateCds);
    if (msg.homeRequest) this.targetCdeg = 0;
  }

  /** Trajectory generation — the firmware's job, not the phone's (§5.6). */
  step() {
    // Command timeout: hold current position, never return home (§5.6).
    if (Date.now() - this.lastControlAt > COMMAND_TIMEOUT_MS) {
      if (!this.timedOut) {
        this.timedOut = true;
        if (this.log) console.warn('[fake turret] control timeout — holding position');
      }
      this.rateCds = 0;
      return;
    }

    const holding = this.mode === Mode.IDLE || !this.motorEnabled;
    if (holding) {
      this.rateCds = 0;
      return;
    }

    const dt = this.tickPeriodMs / 1000;
    const err = this.targetCdeg - this.angleCdeg;
    const step = clamp(err, -this.maxRateCds * dt, this.maxRateCds * dt);
    const next = clamp(this.angleCdeg + step, this.limitCcwCdeg, this.limitCwCdeg);
    if (next !== this.angleCdeg + step) this.emitEvent(EventId.LIMIT_HIT, step > 0 ? 1 : 0);
    this.rateCds = Math.round((next - this.angleCdeg) / dt);
    this.angleCdeg = next;
  }

  notifyState() {
    let status = StatusBits.CALIBRATED;
    if (this.motorEnabled && !this.timedOut) status |= StatusBits.MOTOR_ENABLED;
    if (this.angleCdeg >= this.limitCwCdeg) status |= StatusBits.AT_LIMIT_CW;
    if (this.angleCdeg <= this.limitCcwCdeg) status |= StatusBits.AT_LIMIT_CCW;

    const buf = encodeState({
      seqEcho: this.seqEcho,
      status,
      angleCdeg: this.angleCdeg,
      rateCds: this.rateCds,
      vbatMv: 7900,
      battPct: 86,
      tempC: 31,
      faultCode: 0,
    });
    setTimeout(() => this.deliverState(buf), this.latencyMs / 2);
  }

  deliverState(buf) {
    if (!this.connected) return;
    // Decoding here keeps the transport contract identical to the BLE one:
    // consumers always receive a decoded State object.
    this.dispatchEvent(new CustomEvent('state', { detail: decodeState(buf) }));
  }

  /** Inject a fob press or a fault from the console / test. */
  emitEvent(eventId, arg = 0) {
    const detail = { eventId, arg, raw: encodeEvent({ eventId, arg }) };
    this.dispatchEvent(new CustomEvent('event', { detail }));
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
