/**
 * Preflight uplink probe — README §3.5.
 *
 * Don't synthesise a speed test: run the real path. Open the WHIP session,
 * stream for 15 s, read the stats, tear down. Indoor arenas are steel-clad and
 * often cellular-hostile; this screen is what stops a 50-minute session being
 * wasted.
 */

import { WhipSender } from './whip.js';
import { preflightVerdict } from '../shared/adaptive.js';

export const PROBE_SECONDS = 15;
const SETTLE_SECONDS = 4; // ignore ramp-up: WebRTC starts conservative

/**
 * @param {{whipUrl:string, track:MediaStreamTrack, seconds?:number,
 *          onProgress?:(p:{elapsed:number, total:number, bitrateBps:number}) => void}} opts
 * @returns {Promise<{verdict:'green'|'amber'|'red', bitrateBps:number,
 *                    lossRatio:number, fps:number, samples:number}>}
 */
export async function runPreflight({ whipUrl, track, seconds = PROBE_SECONDS, onProgress = () => {} }) {
  const sender = new WhipSender({ whipUrl, track });
  const samples = [];

  sender.addEventListener('stats', (e) => {
    samples.push(e.detail);
    onProgress({ elapsed: samples.length, total: seconds, bitrateBps: e.detail.bitrateBps });
  });

  await sender.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const settled = samples.slice(SETTLE_SECONDS);
    const used = settled.length ? settled : samples;

    const bitrateBps = median(used.map((s) => s.bitrateBps).filter((v) => v > 0));
    const fps = median(used.map((s) => s.framesPerSecond).filter((v) => v > 0));
    const lossRatio = await readLossRatio(sender.pc);

    return {
      verdict: preflightVerdict(bitrateBps, lossRatio),
      bitrateBps,
      lossRatio,
      fps,
      samples: used.length,
      limitation: used.at(-1)?.qualityLimitationReason ?? 'none',
    };
  } finally {
    // Always tear the probe session down — a leaked Live Input costs money.
    await sender.stop();
  }
}

/** Sender-side loss comes from the remote-inbound-rtp report Cloudflare returns. */
async function readLossRatio(pc) {
  if (!pc) return 0;
  const stats = await pc.getStats().catch(() => null);
  if (!stats) return 0;
  let lost = 0;
  let sent = 0;
  stats.forEach((r) => {
    if (r.type === 'remote-inbound-rtp' && r.kind === 'video') lost = r.packetsLost ?? 0;
    if (r.type === 'outbound-rtp' && r.kind === 'video') sent = r.packetsSent ?? 0;
  });
  if (sent <= 0) return 0;
  return Math.max(0, Math.min(1, lost / sent));
}

/** Which uplink is in use, so the rider can switch and re-test (§3.5). */
export function describeUplink() {
  const c = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
  if (!c) return { label: 'Unknown uplink', type: 'unknown' };
  const type = c.type ?? c.effectiveType ?? 'unknown';
  const label =
    type === 'wifi'
      ? 'Venue WiFi'
      : ['cellular', '4g', '5g', '3g'].includes(type)
        ? `Cellular (${c.effectiveType ?? type})`
        : `Uplink: ${type}`;
  return { label, type, downlinkMbps: c.downlink ?? null };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
