/**
 * Capture UI — thin. It renders state, it never owns state.
 *
 * Designed for a phone clamped to a turret, read at arm's length in sunlight
 * by someone in riding gloves: big targets, high contrast, plain words.
 */

const $ = (id) => document.getElementById(id);

export function createUi(handlers) {
  const els = {
    session: $('session-state'),
    stream: $('stream-state'),
    turret: $('turret-state'),
    detail: $('status-detail'),
    stats: $('stats'),
    log: $('log'),
    viewerLink: $('viewer-link'),
    overlay: $('overlay'),
    video: $('preview'),
    preflight: $('preflight-result'),
  };

  bind('btn-preflight', handlers.onPreflight);
  bind('btn-connect-turret', handlers.onConnectTurret);
  bind('btn-fake-turret', handlers.onFakeTurret);
  bind('btn-start', handlers.onStart);
  bind('btn-stop', handlers.onStop);
  bind('btn-reacquire', handlers.onReacquire);
  bind('venue', handlers.onVenueChange, 'change');

  function bind(id, fn, event = 'click') {
    const el = $(id);
    if (el && fn) el.addEventListener(event, (e) => fn(e));
  }

  const ctx = els.overlay?.getContext('2d');

  return {
    els,

    setSessionState(s) {
      if (els.session) els.session.textContent = s;
      els.session?.setAttribute('data-state', s);
    },

    setStreamState(s) {
      if (els.stream) els.stream.textContent = s;
      els.stream?.setAttribute('data-state', s);
    },

    setTurretState(text, ok = true) {
      if (els.turret) els.turret.textContent = text;
      els.turret?.setAttribute('data-state', ok ? 'ok' : 'warn');
    },

    setDetail(text) {
      if (els.detail) els.detail.textContent = text ?? '';
    },

    setViewerUrl(url) {
      if (!els.viewerLink) return;
      els.viewerLink.textContent = url;
      els.viewerLink.href = url;
      els.viewerLink.hidden = false;
    },

    setStats({ bitrateBps = 0, framesPerSecond = 0, qualityLimitationReason = 'none', note = '' } = {}) {
      if (!els.stats) return;
      els.stats.textContent = `${(bitrateBps / 1e6).toFixed(2)} Mbps · ${Math.round(
        framesPerSecond,
      )} fps · ${qualityLimitationReason}${note ? ` · ${note}` : ''}`;
    },

    setPreflight(result) {
      if (!els.preflight) return;
      els.preflight.dataset.verdict = result.verdict;
      els.preflight.textContent =
        `${result.verdict.toUpperCase()} — ${(result.bitrateBps / 1e6).toFixed(2)} Mbps, ` +
        `${(result.lossRatio * 100).toFixed(1)}% loss, ${Math.round(result.fps)} fps`;
    },

    /** Draw the ROI and the locked bbox over the preview. Debug, but earns its keep. */
    drawOverlay({ roi, bbox, frameSize }) {
      if (!ctx || !els.overlay) return;
      const { width, height } = els.overlay;
      ctx.clearRect(0, 0, width, height);
      const sx = width / (frameSize?.width ?? 1280);
      const sy = height / (frameSize?.height ?? 720);
      if (roi) {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 2;
        ctx.strokeRect(roi.x * sx, roi.y * sy, roi.width * sx, roi.height * sy);
      }
      if (bbox) {
        ctx.strokeStyle = '#41d18a';
        ctx.lineWidth = 3;
        ctx.strokeRect((bbox.cx - bbox.w / 2) * sx, (bbox.cy - bbox.h / 2) * sy, bbox.w * sx, bbox.h * sy);
      }
    },

    log(message, level = 'info') {
      if (!els.log) return;
      const line = document.createElement('div');
      line.className = `log-line log-${level}`;
      line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
      els.log.prepend(line);
      while (els.log.childElementCount > 80) els.log.lastElementChild.remove();
    },
  };
}
