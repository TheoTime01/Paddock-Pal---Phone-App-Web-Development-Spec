/**
 * Camera acquisition, constraint locking, wake lock — README §2.2.
 */

import { clamp } from '../shared/protocol.js';

export const CAPTURE_CONSTRAINTS = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
  audio: false, // a mic 25 m away records wind, not hooves
};

export async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser has no camera API. Use Chrome on Android over HTTPS.');
  }
  const stream = await navigator.mediaDevices.getUserMedia(CAPTURE_CONSTRAINTS);
  return { stream, track: stream.getVideoTracks()[0] };
}

/**
 * Lock exposure, focus and white balance. AE/AF hunting while panning wrecks
 * detection and looks amateur.
 *
 * Every one of these is optional on Android: feature-detect each independently
 * and carry on without it. Call AFTER the rider has framed the arena and
 * BEFORE ACQUIRING, with the subject roughly mid-frame.
 *
 * @param {MediaStreamTrack} track
 * @param {'indoor'|'outdoor'} venue
 * @returns {Promise<{applied:string[], skipped:string[], error?:string}>}
 */
export async function lockExposure(track, venue = 'outdoor') {
  const applied = [];
  const skipped = [];
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const advanced = [];

  if (caps.exposureMode?.includes('manual')) {
    advanced.push({ exposureMode: 'manual' });
    applied.push('exposure');
  } else skipped.push('exposure');

  if (caps.focusMode?.includes('manual')) {
    advanced.push({ focusMode: 'manual' });
    applied.push('focus');
  } else skipped.push('focus');

  if (caps.whiteBalanceMode?.includes('manual')) {
    advanced.push({ whiteBalanceMode: 'manual' });
    applied.push('whiteBalance');
  } else skipped.push('whiteBalance');

  // France is 50 Hz mains. Indoor arena lighting bands unless the shutter is
  // 1/50 or 1/100. exposureTime is in units of 100 microseconds.
  if (caps.exposureTime) {
    const target = venue === 'indoor' ? 100 : 200; // 1/100 s or 1/50 s
    advanced.push({ exposureTime: clamp(target, caps.exposureTime.min, caps.exposureTime.max) });
    applied.push('exposureTime');
  } else skipped.push('exposureTime');

  if (!advanced.length) return { applied, skipped };

  try {
    await track.applyConstraints({ advanced });
  } catch (err) {
    // A refused constraint set is a cosmetic loss, never a session-ender.
    return { applied: [], skipped: [...applied, ...skipped], error: String(err?.message ?? err) };
  }
  return { applied, skipped };
}

/**
 * Screen wake lock — mandatory (§2.2). Chrome suspends a backgrounded tab and
 * both tracking and the WHIP stream die with it.
 *
 * @param {(state:{held:boolean, error?:string}) => void} onChange
 */
export function createWakeLock(onChange = () => {}) {
  let wakeLock = null;
  let wanted = false;

  async function acquire() {
    if (!('wakeLock' in navigator)) {
      onChange({ held: false, error: 'Screen wake lock unavailable — do not let the screen sleep.' });
      return false;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => onChange({ held: false }));
      onChange({ held: true });
      return true;
    } catch (err) {
      onChange({ held: false, error: String(err?.message ?? err) });
      return false;
    }
  }

  async function onVisibility() {
    if (wanted && document.visibilityState === 'visible' && (wakeLock === null || wakeLock.released)) {
      await acquire();
    }
  }

  return {
    async request() {
      wanted = true;
      document.addEventListener('visibilitychange', onVisibility);
      return acquire();
    },
    async release() {
      wanted = false;
      document.removeEventListener('visibilitychange', onVisibility);
      try {
        await wakeLock?.release();
      } catch {
        /* already gone */
      }
      wakeLock = null;
    },
    get held() {
      return Boolean(wakeLock && !wakeLock.released);
    },
  };
}

/**
 * Feed the tracker (§2.3). MediaStreamTrackProcessor hands over VideoFrames
 * that transfer to a worker zero-copy; where it is unavailable we fall back to
 * requestVideoFrameCallback + OffscreenCanvas.
 *
 * Note the track.clone(): the stream keeps the original track, the tracker gets
 * a clone. Independent lifetimes — §2.1's isolation rule at the media layer.
 *
 * @param {MediaStreamTrack} track
 * @param {(frame: any, close: () => void) => boolean} onFrame  return true if consumed
 */
export function createFrameSource(track, onFrame) {
  const clone = track.clone();
  let stopped = false;

  if ('MediaStreamTrackProcessor' in globalThis) {
    const processor = new MediaStreamTrackProcessor({ track: clone });
    const reader = processor.readable.getReader();
    (async () => {
      for (;;) {
        const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
        if (done || stopped) {
          frame?.close?.();
          break;
        }
        // onFrame transfers the frame when it consumes it; otherwise we close.
        if (!onFrame(frame, () => frame.close())) frame.close();
      }
    })();
    return {
      kind: 'track-processor',
      stop() {
        stopped = true;
        reader.cancel().catch(() => {});
        clone.stop();
      },
    };
  }

  // Fallback: draw into an OffscreenCanvas and ship an ImageBitmap.
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([clone]);
  const canvas = new OffscreenCanvas(1280, 720);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const play = video.play();
  if (play?.catch) play.catch(() => {});

  const pump = () => {
    if (stopped) return;
    if (video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const bitmap = canvas.transferToImageBitmap();
      if (!onFrame(bitmap, () => bitmap.close())) bitmap.close();
    }
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(pump);
    else requestAnimationFrame(pump);
  };
  pump();

  return {
    kind: 'canvas-fallback',
    stop() {
      stopped = true;
      video.srcObject = null;
      clone.stop();
    },
  };
}
