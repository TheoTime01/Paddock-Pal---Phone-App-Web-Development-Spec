/**
 * Build order step 4 — the whole control loop against a fake transport, with
 * no camera, no ESP32 and no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ControlLink } from '../src/capture/control.js';
import { FakeTurretTransport } from '../src/capture/fake-transport.js';
import { TrackingController } from '../src/shared/tracking.js';
import { COMMAND_TIMEOUT_MS, DisplayState, Mode } from '../src/shared/protocol.js';

const links = [];
function link(opts = {}) {
  const transport = new FakeTurretTransport({ latencyMs: 20, ...opts });
  const l = new ControlLink(transport, { hz: 20 });
  links.push(l);
  return { transport, link: l };
}

afterEach(async () => {
  await Promise.all(links.splice(0).map((l) => l.disconnect().catch(() => {})));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('ControlLink', () => {
  it('measures round-trip latency from seq / seq_echo', async () => {
    const { link: l } = link();
    await l.connect();
    l.trackTo(10);
    await sleep(300);

    expect(l.latency.medianRttMs).toBeGreaterThan(0);
    expect(l.leadSec).toBeGreaterThan(0);
    expect(l.leadSec).toBeLessThan(0.25);
  });

  it('drops stale commands instead of queueing them (latest-wins, §5.7)', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const transport = {
      connected: true,
      addEventListener() {},
      connect: async () => {},
      disconnect: async () => {},
      writes: [],
      async write(buf) {
        this.writes.push(new Uint8Array(buf)[0]);
        if (this.writes.length === 1) await gate; // hold the first write open
      },
    };
    const l = new ControlLink(transport, { hz: 20 });

    l.send(new Uint8Array([1]).buffer);
    l.send(new Uint8Array([2]).buffer);
    l.send(new Uint8Array([3]).buffer); // supersedes 2 — 2 must never go out
    release();
    await sleep(10);

    expect(transport.writes).toEqual([1, 3]);
  });

  it('sends home_request once, not on every packet', async () => {
    const { transport, link: l } = link();
    await l.connect();
    l.requestHome();
    await sleep(200);
    expect(transport.writes.filter((w) => w.homeRequest).length).toBe(1);
  });

  it('carries display_state on every control packet (§5.2)', async () => {
    const { transport, link: l } = link();
    await l.connect();
    l.setDisplayState(DisplayState.LOST);
    await sleep(150);
    const recent = transport.writes.slice(-3);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((w) => w.displayState === DisplayState.LOST)).toBe(true);
  });

  it('never requests more than the 150 deg/s ceiling', async () => {
    const { transport, link: l } = link();
    await l.connect();
    l.trackTo(90, 400); // a wild request from a misbehaving tracker
    await sleep(150);
    expect(Math.max(...transport.writes.map((w) => w.maxRateCds))).toBeLessThanOrEqual(15000);
  });
});

describe('fake turret honours the normative behaviours (§5.6)', () => {
  it('holds position on command timeout — it does NOT return home', async () => {
    const { transport, link: l } = link();
    await l.connect();
    l.trackTo(40, 120);
    await sleep(500);

    const angleWhenAbandoned = transport.angleCdeg;
    expect(angleWhenAbandoned).toBeGreaterThan(0);

    l.stopLoop(); // simulate the phone going away mid-session
    await sleep(COMMAND_TIMEOUT_MS + 300);

    expect(transport.timedOut).toBe(true);
    expect(transport.rateCds).toBe(0);
    // A turret that snaps around next to a horse is a safety event, not a
    // recovery: it stays where it was and must not head for home.
    expect(transport.angleCdeg).toBe(angleWhenAbandoned);
    expect(transport.angleCdeg).not.toBe(0);
  });

  it('clamps the requested rate against its own firmware maximum', async () => {
    const { transport, link: l } = link({ firmwareMaxRateCds: 5000 });
    await l.connect();
    l.trackTo(150, 150);
    await sleep(120);
    expect(transport.maxRateCds).toBeLessThanOrEqual(5000);
  });

  it('generates its own trajectory — the phone only sends targets', async () => {
    const { transport, link: l } = link();
    await l.connect();
    l.trackTo(30, 60);
    await sleep(200);
    const midway = transport.angleCdeg;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(3000); // still travelling, not teleported
    await sleep(600);
    expect(transport.angleCdeg).toBeGreaterThan(midway);
  });
});

describe('closed loop: tracker + control + turret', () => {
  it('drives the turret onto a stationary subject and then holds', async () => {
    const { transport, link: l } = link();
    await l.connect();
    const controller = new TrackingController();

    const SUBJECT_BEARING = 25; // degrees from home
    const PX_PER_DEG = 20;
    const FRAME_W = 1280;

    for (let i = 0; i < 60; i++) {
      const cameraAngleDeg = l.cameraAngleDeg;
      // Where the subject appears in frame, given where the camera points.
      const bboxCx = 0.5 + ((SUBJECT_BEARING - cameraAngleDeg) * PX_PER_DEG) / FRAME_W;
      if (bboxCx >= 0 && bboxCx <= 1) {
        const out = controller.update({
          bboxCx,
          frameWidthPx: FRAME_W,
          pxPerDeg: PX_PER_DEG,
          cameraAngleDeg,
          leadSec: l.leadSec,
          tSec: i * 0.05,
        });
        if (out.move) l.trackTo(out.commandDeg, out.maxRateDps);
        else l.hold();
      }
      await sleep(50);
    }

    // Converged to within the deadband, and parked there rather than hunting.
    expect(Math.abs(transport.angleCdeg / 100 - SUBJECT_BEARING)).toBeLessThan(5);
    expect(transport.mode).toBe(Mode.IDLE);
  });
});
