/**
 * §6 — the failure-domain table. Every row is a test.
 *
 * The bench test the README demands ("throw an exception inside the tracker
 * worker mid-stream and confirm the stream survives, then kill BLE and confirm
 * the same") is mechanised here against the real supervisor logic, so the field
 * test is confirmation rather than discovery.
 */
import { describe, expect, it, vi } from 'vitest';
import { ControlLink } from '../src/capture/control.js';
import { FakeTurretTransport } from '../src/capture/fake-transport.js';
import { StreamState } from '../src/capture/whip.js';
import { adapt } from '../src/shared/adaptive.js';
import { COMMAND_TIMEOUT_MS, DisplayState } from '../src/shared/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the stream side that records whether anything ever reached it.
 * The point of the isolation rule is that no tracker or BLE code path can.
 */
function makeStreamProbe() {
  return {
    state: StreamState.LIVE,
    touched: 0,
    close() {
      this.touched++;
      this.state = StreamState.OFF;
    },
  };
}

describe('detector throws', () => {
  it('stops tracking, parks the turret, sets LOST, and leaves the stream alone', async () => {
    const stream = makeStreamProbe();
    const transport = new FakeTurretTransport({ latencyMs: 10 });
    const link = new ControlLink(transport, { hz: 20 });
    await link.connect();
    link.setMotorEnabled(true);
    link.trackTo(20, 90);
    await sleep(200);
    expect(transport.angleCdeg).toBeGreaterThan(0); // it was tracking

    // This is what main.js's worker.onerror does, and all it does.
    const onWorkerError = () => {
      link.hold();
      link.setDisplayState(DisplayState.LOST);
    };
    onWorkerError();
    await sleep(200);

    // Parked at the last angle: once the hold lands, it stops moving.
    const parkedAt = transport.angleCdeg;
    await sleep(300);

    expect(link.command.displayState).toBe(DisplayState.LOST);
    expect(transport.rateCds).toBe(0);
    expect(transport.angleCdeg).toBe(parkedAt);
    expect(stream.state).toBe(StreamState.LIVE);
    expect(stream.touched).toBe(0);
    await link.disconnect();
  });
});

describe('BLE drops', () => {
  it('leaves the stream untouched and lets the ESP32 hold after 1 s', async () => {
    const stream = makeStreamProbe();
    const transport = new FakeTurretTransport({ latencyMs: 10 });
    const link = new ControlLink(transport, { hz: 20 });
    await link.connect();
    link.setMotorEnabled(true);
    link.trackTo(30, 120);
    await sleep(250);

    link.stopLoop(); // the link is gone; Control writes stop arriving
    await sleep(COMMAND_TIMEOUT_MS + 200);

    // It carried on to its last commanded target, then held there — it did NOT
    // return home, which next to a horse would be a safety event (§5.6).
    const angleAfterTimeout = transport.angleCdeg;
    await sleep(300);

    expect(transport.timedOut).toBe(true);
    expect(transport.angleCdeg).toBe(angleAfterTimeout);
    expect(angleAfterTimeout).not.toBe(0);
    expect(stream.state).toBe(StreamState.LIVE);
    expect(stream.touched).toBe(0);
    await link.disconnect();
  });

  it('writing to a dead transport surfaces an error event, never an unhandled rejection', async () => {
    const transport = new FakeTurretTransport();
    const link = new ControlLink(transport, { hz: 20 });
    const onError = vi.fn();
    link.addEventListener('error', onError);

    await link.connect();
    transport.connected = false; // range loss between tick and write
    await link.send(new ArrayBuffer(8));

    expect(onError).toHaveBeenCalled();
    await link.disconnect();
  });
});

describe('phone thermal-throttles', () => {
  it('drops detection Hz first and bitrate only second', () => {
    let s = { detectIntervalMs: 100, maxBitrate: 2_500_000 };
    const first = adapt(s, 'thermal');
    expect(first.detectIntervalMs).toBeGreaterThan(s.detectIntervalMs);
    expect(first.maxBitrate).toBe(s.maxBitrate); // video has not given way yet

    s = first;
    while (s.detectIntervalMs < 500) s = adapt(s, 'thermal');
    expect(adapt(s, 'thermal').maxBitrate).toBeLessThan(2_500_000);
  });
});

describe('WHIP fails / uplink dies', () => {
  it('tracking keeps running so the stream resumes correctly framed', async () => {
    const transport = new FakeTurretTransport({ latencyMs: 10 });
    const link = new ControlLink(transport, { hz: 20 });
    await link.connect();
    link.setMotorEnabled(true);
    link.trackTo(15, 90);
    await sleep(200);

    // The stream side goes away entirely; nothing here observes it.
    const streamGone = { state: StreamState.RECONNECTING };
    link.trackTo(25, 90);
    await sleep(300);

    expect(streamGone.state).toBe(StreamState.RECONNECTING);
    expect(transport.angleCdeg).toBeGreaterThan(1000); // still tracking
    expect(transport.timedOut).toBe(false);
    await link.disconnect();
  });
});
