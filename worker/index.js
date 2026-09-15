/**
 * Session broker — README §3.1.
 *
 *   POST   /api/session       -> { sessionId, whipUrl, whepUrl, expiresAt }
 *   GET    /api/session/:id   -> { sessionId, whepUrl, expiresAt, status }
 *   DELETE /api/session/:id
 *
 * SECURITY RULE, NON-NEGOTIABLE (§1): the Cloudflare Stream API token lives
 * here and only here. The capture page never holds a credential that could
 * create Live Inputs. Nothing in this file may return `env.CF_STREAM_TOKEN`
 * or the raw Live Input object to a client.
 *
 * Bindings (wrangler.toml):
 *   CF_ACCOUNT_ID   var     Cloudflare account id
 *   CF_STREAM_TOKEN secret  API token with Stream:Edit
 *   SESSIONS        KV      session records, written with a TTL so orphaned
 *                           Live Inputs get reaped
 *   ALLOWED_ORIGIN  var     exact origin allowed to call this API
 */

const SESSION_TTL_SECONDS = 4 * 60 * 60; // a long lesson plus slack
const KV_MIN_TTL_SECONDS = 60; // Cloudflare KV rejects anything shorter
const MAX_SESSION_NAME = 64;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (pathname === '/api/session' && request.method === 'POST') {
        return json(await createSession(request, env, ctx), 201, request, env);
      }

      const match = pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{1,64})$/);
      if (match) {
        const id = match[1];
        if (request.method === 'GET') return json(await readSession(id, env), 200, request, env);
        if (request.method === 'DELETE') return json(await deleteSession(id, env), 200, request, env);
      }

      if (pathname === '/api/health') {
        return json({ ok: true, configured: Boolean(env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN) }, 200, request, env);
      }

      return json({ error: 'not_found' }, 404, request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('session broker failure', err);
      return json({ error: err.code ?? 'internal_error', message: err.message }, status, request, env);
    }
  },
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

// ------------------------------------------------------------------ handlers

async function createSession(request, env, ctx) {
  requireConfig(env);

  const body = await readJson(request);
  const name = sanitiseName(body.name ?? 'Paddock Pal session');
  const sessionId = crypto.randomUUID();

  const liveInput = await cfStream(env, '', {
    method: 'POST',
    body: JSON.stringify({
      meta: { name, sessionId },
      recording: { mode: body.record === true ? 'automatic' : 'off' },
    }),
  });

  const whipUrl = liveInput.webRTC?.url;
  const whepUrl = liveInput.webRTCPlayback?.url;
  if (!whipUrl || !whepUrl) {
    // The Live Input exists but is useless to us — don't leak it.
    ctx.waitUntil(cfStream(env, `/${liveInput.uid}`, { method: 'DELETE' }).catch(() => {}));
    throw new HttpError(502, 'no_webrtc_urls', 'Live Input came back without WebRTC URLs');
  }

  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const record = { sessionId, liveInputUid: liveInput.uid, whipUrl, whepUrl, name, createdAt: Date.now(), expiresAt };

  await env.SESSIONS.put(sessionId, JSON.stringify(record), {
    expirationTtl: Math.max(KV_MIN_TTL_SECONDS, SESSION_TTL_SECONDS),
  });

  // liveInputUid stays server-side; the client gets only what it needs.
  return { sessionId, whipUrl, whepUrl, expiresAt };
}

async function readSession(sessionId, env) {
  const record = await loadSession(sessionId, env);
  // The viewer needs the WHEP URL. It does NOT need the WHIP URL — that would
  // hand any viewer the ability to publish over the rider's session.
  return {
    sessionId: record.sessionId,
    whepUrl: record.whepUrl,
    name: record.name,
    expiresAt: record.expiresAt,
  };
}

async function deleteSession(sessionId, env) {
  requireConfig(env);
  const record = await loadSession(sessionId, env);

  // Delete the Live Input first: a KV record with no input is harmless, an
  // input with no record is an orphan nobody will ever reap (§3.2).
  await cfStream(env, `/${record.liveInputUid}`, { method: 'DELETE' }).catch((err) => {
    if (!(err instanceof HttpError) || err.status !== 404) throw err;
  });
  await env.SESSIONS.delete(sessionId);
  return { sessionId, deleted: true };
}

// ------------------------------------------------------------------ helpers

function requireConfig(env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_STREAM_TOKEN) {
    throw new HttpError(500, 'not_configured', 'CF_ACCOUNT_ID and CF_STREAM_TOKEN must be set');
  }
  if (!env.SESSIONS) throw new HttpError(500, 'not_configured', 'SESSIONS KV binding missing');
}

async function loadSession(sessionId, env) {
  const raw = await env.SESSIONS?.get(sessionId);
  if (!raw) throw new HttpError(404, 'session_not_found', 'No such session');
  return JSON.parse(raw);
}

async function cfStream(env, path, init) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CF_STREAM_TOKEN}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    },
  );

  if (res.status === 404) throw new HttpError(404, 'live_input_not_found', 'Live Input not found');

  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.success === false) {
    // Cloudflare's error text can echo request details; log it, don't return it.
    console.error('cloudflare stream api error', res.status, JSON.stringify(payload?.errors ?? null));
    throw new HttpError(502, 'stream_api_error', `Cloudflare Stream API returned ${res.status}`);
  }
  return payload?.result ?? {};
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Body must be JSON');
  }
}

function sanitiseName(name) {
  // Strip control characters: the name is echoed into Live Input metadata.
  const cleaned = Array.from(String(name))
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
  return cleaned.slice(0, MAX_SESSION_NAME) || 'Paddock Pal session';
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGIN;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // Same-origin deployment (Pages + Worker route) needs no CORS at all; the
  // allowlist exists for split dev setups and is an exact match, never '*'.
  if (allowed && origin === allowed) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

export { createSession, readSession, deleteSession, HttpError, SESSION_TTL_SECONDS };
