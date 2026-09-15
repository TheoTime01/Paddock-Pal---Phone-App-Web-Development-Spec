/**
 * Viewer page — README §4.
 *
 * Hand-rolled WHEP. NOT the Cloudflare Stream Player: that is an HLS player and
 * a WHIP input has no HLS rendition, so this is the only playback path.
 *
 * The four states below are handled explicitly, because a blank black rectangle
 * is the most common failure of homemade WHEP pages and the viewer is often a
 * parent on a phone in a car park.
 */

import { backoffMs } from '../shared/adaptive.js';

const ViewState = Object.freeze({
  WAITING: 'waiting', // rider hasn't started yet
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  ENDED: 'ended',
});

const els = {
  video: document.getElementById('player'),
  status: document.getElementById('status'),
  message: document.getElementById('message'),
  bars: document.getElementById('bars'),
};

const view = {
  sessionId: sessionIdFromPath(),
  pc: null,
  attempt: 0,
  statsTimer: null,
  stopped: false,
};

function sessionIdFromPath() {
  // /watch/:id — Pages rewrites /watch/* to this page (see public/_redirects).
  const fromPath = location.pathname.match(/\/watch\/([A-Za-z0-9_-]+)/)?.[1];
  return fromPath ?? new URLSearchParams(location.search).get('id');
}

function setState(state, message) {
  els.status.dataset.state = state;
  els.status.textContent = {
    [ViewState.WAITING]: 'Waiting for the rider',
    [ViewState.LIVE]: 'Live',
    [ViewState.RECONNECTING]: 'Reconnecting',
    [ViewState.ENDED]: 'Session ended',
  }[state];
  els.message.textContent = message ?? '';
  els.video.classList.toggle('is-live', state === ViewState.LIVE);
}

async function loadSession() {
  const res = await fetch(`/api/session/${view.sessionId}`);
  if (res.status === 404) {
    setState(ViewState.ENDED, 'This session has finished or the link has expired.');
    return null;
  }
  if (!res.ok) throw new Error(`session lookup failed (${res.status})`);
  return res.json();
}

async function connect() {
  if (view.stopped) return;

  const session = await loadSession().catch((err) => {
    setState(ViewState.RECONNECTING, err.message);
    return null;
  });
  if (!session) return retryLater();

  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  view.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (e) => {
    els.video.srcObject = e.streams[0];
  };

  pc.addEventListener('connectionstatechange', () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      view.attempt = 0;
      setState(ViewState.LIVE);
      startStats();
    } else if (s === 'failed' || s === 'disconnected') {
      stopStats();
      setState(ViewState.RECONNECTING, 'Lost the picture — trying again.');
      retryLater();
    }
  });

  await pc.setLocalDescription(await pc.createOffer());

  let res;
  try {
    res = await fetch(session.whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
  } catch {
    return retryLater('No connection to the stream server.');
  }

  if (res.status === 404 || res.status === 405) {
    // Cloudflare answers this way until the rider's WHIP session is up.
    setState(ViewState.WAITING, 'The rider has not started yet. This page will start on its own.');
    return retryLater();
  }
  if (!res.ok) return retryLater(`Stream server returned ${res.status}.`);

  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
}

function retryLater(message) {
  if (view.stopped) return;
  closePeer();
  const delay = backoffMs(view.attempt);
  view.attempt++;
  if (message) els.message.textContent = message;
  setTimeout(() => connect().catch(() => retryLater()), delay);
}

function closePeer() {
  stopStats();
  try {
    view.pc?.close();
  } catch {
    /* already closed */
  }
  view.pc = null;
}

/** Connection quality from inbound-rtp as a simple three-bar indicator (§4). */
function startStats() {
  stopStats();
  let prevLost = 0;
  let prevReceived = 0;
  view.statsTimer = setInterval(async () => {
    const stats = await view.pc?.getStats().catch(() => null);
    if (!stats) return;
    stats.forEach((r) => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
      const lost = (r.packetsLost ?? 0) - prevLost;
      const received = (r.packetsReceived ?? 0) - prevReceived;
      prevLost = r.packetsLost ?? 0;
      prevReceived = r.packetsReceived ?? 0;
      const lossRatio = received > 0 ? lost / (lost + received) : 0;
      const jitter = r.jitter ?? 0;
      const bars = lossRatio < 0.02 && jitter < 0.05 ? 3 : lossRatio < 0.05 && jitter < 0.15 ? 2 : 1;
      els.bars.dataset.bars = String(bars);
      els.bars.title = `${(lossRatio * 100).toFixed(1)}% loss · ${(jitter * 1000).toFixed(0)} ms jitter`;
    });
  }, 1000);
}

function stopStats() {
  if (view.statsTimer) clearInterval(view.statsTimer);
  view.statsTimer = null;
}

if (!view.sessionId) {
  setState(ViewState.ENDED, 'That link is missing a session id.');
} else {
  setState(ViewState.WAITING, 'Connecting…');
  connect().catch(() => retryLater());
}

window.addEventListener('pagehide', () => {
  view.stopped = true;
  closePeer();
});
