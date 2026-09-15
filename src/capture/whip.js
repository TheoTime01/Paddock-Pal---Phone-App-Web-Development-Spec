/**
 * WHIP sender, stats loop and reconnect — README §3.2–§3.4.
 *
 * The STREAM state machine (§2.1) lives here:
 *   OFF -> CONNECTING -> LIVE <-> RECONNECTING -> OFF
 * It shares no state with the SESSION machine and never awaits the tracker.
 */

import { adapt, backoffMs, BITRATE_MAX, DETECT_INTERVAL_BASE_MS } from '../shared/adaptive.js';

export const StreamState = Object.freeze({
  OFF: 'OFF',
  CONNECTING: 'CONNECTING',
  LIVE: 'LIVE',
  RECONNECTING: 'RECONNECTING',
});

const DISCONNECTED_GRACE_MS = 3000; // §3.3 — 'disconnected' for >3 s is a failure

/**
 * Prefer H.264 Constrained Baseline 3.1: it is the hardware encoder on Android,
 * which means less heat (§3.2).
 */
export function preferH264(transceiver) {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs || typeof transceiver.setCodecPreferences !== 'function') return false;
  const cb31 = caps.codecs.filter(
    (c) => c.mimeType === 'video/H264' && c.sdpFmtpLine?.includes('profile-level-id=42e01f'),
  );
  if (!cb31.length) return false;
  transceiver.setCodecPreferences([...cb31, ...caps.codecs.filter((c) => c.mimeType !== 'video/H264')]);
  return true;
}

export function iceGatheringComplete(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    // Cloudflare supports trickle, so a slow STUN server must not block us.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class WhipSender extends EventTarget {
  /**
   * @param {{whipUrl:string, track:MediaStreamTrack,
   *          maxBitrate?:number, maxFramerate?:number}} opts
   */
  constructor({ whipUrl, track, maxBitrate = BITRATE_MAX, maxFramerate = 30 }) {
    super();
    this.whipUrl = whipUrl;
    this.track = track;
    this.maxBitrate = maxBitrate;
    this.maxFramerate = maxFramerate;

    this.state = StreamState.OFF;
    this.pc = null;
    this.transceiver = null;
    this.resourceUrl = null;
    this.attempt = 0;
    this.statsTimer = null;
    this.disconnectedSince = null;
    this.stopped = false;

    /** Latest adaptive controller output (§3.4). */
    this.policy = { detectIntervalMs: DETECT_INTERVAL_BASE_MS, maxBitrate, health: 'ok', note: '' };
    this.lastStats = null;
    this._prevBytes = 0;
    this._prevTs = 0;
  }

  setState(state, detail = {}) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { state, ...detail });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async connect() {
    this.setState(this.attempt === 0 ? StreamState.CONNECTING : StreamState.RECONNECTING);
    this.teardownPeer();

    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    this.pc = pc;
    const tx = pc.addTransceiver(this.track, { direction: 'sendonly' });
    this.transceiver = tx;
    preferH264(tx);

    pc.addEventListener('connectionstatechange', () => this.onConnectionState());

    await pc.setLocalDescription(await pc.createOffer());
    await iceGatheringComplete(pc);

    let res;
    try {
      res = await fetch(this.whipUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
    } catch (err) {
      return this.scheduleReconnect(`WHIP POST failed: ${err?.message ?? err}`);
    }

    if (!res.ok) return this.scheduleReconnect(`WHIP POST returned ${res.status}`);

    // Keep the resource URL — DELETE on stop, or we leak a paid Live Input (§3.2).
    const location = res.headers.get('Location');
    this.resourceUrl = location ? new URL(location, this.whipUrl).toString() : null;

    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    await this.applyEncoding();
    this.startStatsLoop();
  }

  /** The encoding envelope (§3.2). */
  async applyEncoding() {
    const sender = this.transceiver?.sender;
    if (!sender?.getParameters) return;
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = this.maxBitrate;
    p.encodings[0].maxFramerate = this.maxFramerate;
    // Motion smoothness > detail: a rider reviewing a canter transition needs
    // temporal smoothness far more than pixel detail.
    p.degradationPreference = 'maintain-framerate';
    await sender.setParameters(p).catch((err) => this.emit('warn', { message: String(err?.message ?? err) }));
  }

  onConnectionState() {
    const s = this.pc?.connectionState;
    if (s === 'connected') {
      this.attempt = 0;
      this.disconnectedSince = null;
      this.setState(StreamState.LIVE);
    } else if (s === 'failed') {
      this.scheduleReconnect('connection failed');
    } else if (s === 'disconnected') {
      // §3.3: only act after >3 s. WebRTC recovers from brief blips on its own.
      this.disconnectedSince = Date.now();
      setTimeout(() => {
        if (this.pc?.connectionState === 'disconnected' && this.disconnectedSince) {
          this.scheduleReconnect('disconnected > 3 s');
        }
      }, DISCONNECTED_GRACE_MS);
    }
  }

  scheduleReconnect(reason) {
    if (this.stopped) return;
    this.stopStatsLoop();
    const delay = backoffMs(this.attempt);
    this.attempt++;
    this.setState(StreamState.RECONNECTING, { reason, attempt: this.attempt, delay });
    // Tracking continues untouched throughout, so when the stream comes back
    // the horse is still framed (§3.3).
    setTimeout(() => {
      if (!this.stopped) this.connect().catch((err) => this.scheduleReconnect(String(err?.message ?? err)));
    }, delay);
  }

  // ------------------------------------------------------------ stats (§3.4)

  startStatsLoop(intervalMs = 1000) {
    this.stopStatsLoop();
    this.statsTimer = setInterval(() => this.pollStats(), intervalMs);
  }

  stopStatsLoop() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  async pollStats() {
    if (!this.pc) return;
    const stats = await this.pc.getStats().catch(() => null);
    if (!stats) return;

    let report = null;
    stats.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video' && !r.isRemote) report = r;
    });
    if (!report) return;

    const bitrateBps =
      this._prevTs && report.timestamp > this._prevTs
        ? ((report.bytesSent - this._prevBytes) * 8000) / (report.timestamp - this._prevTs)
        : 0;
    this._prevBytes = report.bytesSent;
    this._prevTs = report.timestamp;

    const reason = report.qualityLimitationReason ?? 'none';
    const next = adapt(this.policy, reason);

    if (next.maxBitrate !== this.maxBitrate) {
      this.maxBitrate = next.maxBitrate;
      await this.applyEncoding();
    }
    const detectChanged = next.detectIntervalMs !== this.policy.detectIntervalMs;
    this.policy = next;

    this.lastStats = {
      bitrateBps,
      framesPerSecond: report.framesPerSecond ?? 0,
      qualityLimitationReason: reason,
      packetsSent: report.packetsSent ?? 0,
      health: next.health,
      note: next.note,
    };
    this.emit('stats', this.lastStats);
    if (detectChanged) this.emit('detect-interval', { detectIntervalMs: next.detectIntervalMs, reason });
  }

  // ------------------------------------------------------------------- stop

  teardownPeer() {
    this.stopStatsLoop();
    if (this.pc) {
      this.pc.getSenders().forEach((s) => s.track && s.replaceTrack(null).catch(() => {}));
      this.pc.close();
    }
    this.pc = null;
    this.transceiver = null;
  }

  /** On stop, DELETE the resource URL or the Live Input stays open (§3.2). */
  async stop() {
    this.stopped = true;
    const url = this.resourceUrl;
    this.resourceUrl = null;
    this.teardownPeer();
    this.setState(StreamState.OFF);
    if (url) {
      await fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
    }
  }
}
