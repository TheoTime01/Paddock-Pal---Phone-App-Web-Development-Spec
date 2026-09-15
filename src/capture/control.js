/**
 * ControlTransport interface + latency tracking — README §5.6, §5.7.
 *
 * Everything above this line speaks angles and display states; everything below
 * it speaks bytes from shared/protocol.js. Swapping the fake transport for the
 * BLE one (build order step 5) changes nothing else.
 */

import {
  ControlFlags,
  DisplayState,
  LatencyTracker,
  Mode,
  clampAngleCdeg,
  degToCdeg,
  encodeControl,
  makeSeqCounter,
} from '../shared/protocol.js';
import { MAX_RATE_DPS } from '../shared/tracking.js';

export const CONTROL_HZ = 10; // nominal (§5.2); the contract allows up to 20

/**
 * A transport implements:
 *   connect(): Promise<void>
 *   disconnect(): Promise<void>
 *   write(ArrayBuffer): Promise<void>          // Control characteristic
 *   readonly connected: boolean
 * and dispatches 'state', 'event', 'connected', 'disconnected', 'error'.
 *
 * ControlLink wraps one and owns the cadence, the seq counter, the latency
 * tracker, and the single-flight latest-wins write policy.
 */
export class ControlLink extends EventTarget {
  constructor(transport, { hz = CONTROL_HZ, now = () => performance.now() } = {}) {
    super();
    this.transport = transport;
    this.periodMs = 1000 / hz;
    this.now = now;
    this.nextSeq = makeSeqCounter();
    this.latency = new LatencyTracker({ now });

    /** Latest turret State (§5.3) — the predictor's source of camera angle. */
    this.lastState = null;
    this.lastStateAt = null;

    /** What the next Control packet will carry. Set by the tracker loop. */
    this.command = {
      mode: Mode.IDLE,
      targetCdeg: 0,
      maxRateCds: 0,
      flags: 0,
      displayState: DisplayState.IDLE,
    };

    this._timer = null;
    this._inFlight = false;
    this._pending = null;

    transport.addEventListener('state', (e) => this.onState(e.detail));
    transport.addEventListener('event', (e) => this.emit('event', e.detail));
    transport.addEventListener('connected', () => this.emit('connected', {}));
    transport.addEventListener('disconnected', (e) => this.emit('disconnected', e.detail ?? {}));
    transport.addEventListener('error', (e) => this.emit('error', e.detail ?? {}));
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get connected() {
    return Boolean(this.transport.connected);
  }

  /** Lead time for the predictor, self-tuned to the actual link (§5.6). */
  get leadSec() {
    return this.latency.leadSec;
  }

  get cameraAngleDeg() {
    return this.lastState ? this.lastState.angleDeg : 0;
  }

  async connect() {
    await this.transport.connect();
    this.startLoop();
  }

  async disconnect() {
    this.stopLoop();
    await this.transport.disconnect();
  }

  onState(state) {
    this.lastState = state;
    this.lastStateAt = this.now();
    const rtt = this.latency.onEcho(state.seqEcho);
    this.emit('state', { state, rttMs: rtt, medianRttMs: this.latency.medianRttMs });
  }

  // ----------------------------------------------------------- command setters

  /** Track a bearing. Targets, never steps (§5.6) — the ESP32 owns the path. */
  trackTo(targetDeg, maxRateDps = MAX_RATE_DPS) {
    this.command.mode = Mode.TRACK;
    this.command.targetCdeg = clampAngleCdeg(degToCdeg(targetDeg));
    this.command.maxRateCds = Math.round(Math.min(maxRateDps, MAX_RATE_DPS) * 100);
    this.command.flags |= ControlFlags.MOTOR_ENABLE;
  }

  /** Hold position — used inside the deadband, at a limit, and while LOST. */
  hold() {
    this.command.mode = Mode.IDLE;
    this.command.maxRateCds = 0;
  }

  goTo(targetDeg, maxRateDps = 60) {
    this.command.mode = Mode.GOTO;
    this.command.targetCdeg = clampAngleCdeg(degToCdeg(targetDeg));
    this.command.maxRateCds = Math.round(Math.min(maxRateDps, MAX_RATE_DPS) * 100);
    this.command.flags |= ControlFlags.MOTOR_ENABLE;
  }

  calibrate(targetDeg, maxRateDps = 30) {
    this.command.mode = Mode.CALIBRATE;
    this.command.targetCdeg = clampAngleCdeg(degToCdeg(targetDeg));
    this.command.maxRateCds = Math.round(Math.min(maxRateDps, MAX_RATE_DPS) * 100);
    this.command.flags |= ControlFlags.MOTOR_ENABLE;
  }

  setMotorEnabled(on) {
    if (on) this.command.flags |= ControlFlags.MOTOR_ENABLE;
    else this.command.flags &= ~ControlFlags.MOTOR_ENABLE;
  }

  requestHome() {
    this.command.flags |= ControlFlags.HOME_REQUEST;
  }

  /**
   * display_state rides along on every Control packet (§5.2), which is what
   * guarantees the face on the turret matches what the tracker is doing.
   */
  setDisplayState(displayState) {
    this.command.displayState = displayState;
  }

  // -------------------------------------------------------------- the cadence

  startLoop() {
    this.stopLoop();
    this._timer = setInterval(() => this.tick(), this.periodMs);
  }

  stopLoop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  tick() {
    if (!this.transport.connected) return;
    const seq = this.nextSeq();
    const buf = encodeControl({ seq, ...this.command });
    // home_request is edge-triggered: one packet carries it, not every packet.
    this.command.flags &= ~ControlFlags.HOME_REQUEST;
    this.latency.onSent(seq);
    this.send(buf);
  }

  /**
   * Single-flight with latest-wins (§5.7). Web Bluetooth throws
   * InvalidStateError if a GATT operation starts while another is pending, and
   * at 10 Hz that will bite. Queueing stale commands is worse than dropping
   * them — a servo chasing a 300 ms-old target oscillates.
   */
  async send(buf) {
    if (this._inFlight) {
      this._pending = buf; // drop stale, keep newest
      return;
    }
    this._inFlight = true;
    try {
      await this.transport.write(buf);
    } catch (err) {
      this.emit('error', { message: String(err?.message ?? err) });
    } finally {
      this._inFlight = false;
      if (this._pending) {
        const b = this._pending;
        this._pending = null;
        this.send(b);
      }
    }
  }
}
