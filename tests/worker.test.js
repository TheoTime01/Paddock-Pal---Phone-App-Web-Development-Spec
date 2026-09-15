/**
 * §3.1 — the session broker. The security rule is the first test: the client
 * must never be handed anything that could create a Live Input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index.js';

const TOKEN = 'super-secret-stream-token';

function makeEnv() {
  const store = new Map();
  return {
    CF_ACCOUNT_ID: 'acct123',
    CF_STREAM_TOKEN: TOKEN,
    ALLOWED_ORIGIN: 'https://paddock.example',
    SESSIONS: {
      async get(k) {
        return store.get(k) ?? null;
      },
      async put(k, v) {
        store.set(k, v);
      },
      async delete(k) {
        store.delete(k);
      },
      _store: store,
    },
  };
}

const ctx = { waitUntil: (p) => p };

function mockStream(liveInput = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization });
    if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: {} }));
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          uid: 'live-input-uid',
          webRTC: { url: 'https://customer.cloudflarestream.com/xyz/webRTC/publish' },
          webRTCPlayback: { url: 'https://customer.cloudflarestream.com/xyz/webRTC/play' },
          ...liveInput,
        },
      }),
    );
  });
  return calls;
}

const post = (body = {}) =>
  new Request('https://paddock.example/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://paddock.example' },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe('POST /api/session', () => {
  it('returns only sessionId, whipUrl, whepUrl and expiresAt', async () => {
    mockStream();
    const env = makeEnv();
    const res = await worker.fetch(post(), env, ctx);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'sessionId', 'whepUrl', 'whipUrl']);
    expect(body.whipUrl).toContain('webRTC/publish');
  });

  it('NEVER leaks the Stream API token or the Live Input uid', async () => {
    mockStream();
    const env = makeEnv();
    const text = await (await worker.fetch(post(), env, ctx)).text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('live-input-uid');
  });

  it('keeps the live input uid server-side in KV so it can be reaped', async () => {
    mockStream();
    const env = makeEnv();
    const { sessionId } = await (await worker.fetch(post(), env, ctx)).json();
    expect(JSON.parse(await env.SESSIONS.get(sessionId)).liveInputUid).toBe('live-input-uid');
  });

  it('sends the token to Cloudflare as a bearer, and nowhere else', async () => {
    const calls = mockStream();
    await worker.fetch(post(), makeEnv(), ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('api.cloudflare.com');
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it('deletes the orphan and fails loudly if the input has no WebRTC URLs', async () => {
    const calls = mockStream({ webRTC: undefined, webRTCPlayback: undefined });
    const res = await worker.fetch(post(), makeEnv(), ctx);
    expect(res.status).toBe(502);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('refuses to run unconfigured rather than guessing', async () => {
    const env = { ...makeEnv(), CF_STREAM_TOKEN: undefined };
    const res = await worker.fetch(post(), env, ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('not_configured');
  });

  it('strips control characters from the session name before it reaches Cloudflare', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push(JSON.parse(init.body ?? '{}'));
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            uid: 'u',
            webRTC: { url: 'https://x/publish' },
            webRTCPlayback: { url: 'https://x/play' },
          },
        }),
      );
    });

    const nasty = `Lucie${String.fromCharCode(0)}${String.fromCharCode(7)}${String.fromCharCode(127)} — schooling`;
    await worker.fetch(post({ name: nasty }), makeEnv(), ctx);

    const sent = calls[0].meta.name;
    expect(sent).toBe('Lucie — schooling');
    expect(Array.from(sent).every((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)).toBe(true);
  });

  it('caps an over-long name rather than passing it through', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push(JSON.parse(init.body ?? '{}'));
      return new Response(
        JSON.stringify({
          success: true,
          result: { uid: 'u', webRTC: { url: 'https://x/p' }, webRTCPlayback: { url: 'https://x/w' } },
        }),
      );
    });
    await worker.fetch(post({ name: 'x'.repeat(500) }), makeEnv(), ctx);
    expect(calls[0].meta.name.length).toBe(64);
  });

  it('rejects a malformed body', async () => {
    mockStream();
    const req = new Request('https://paddock.example/api/session', { method: 'POST', body: '{oh no' });
    expect((await worker.fetch(req, makeEnv(), ctx)).status).toBe(400);
  });
});

describe('GET /api/session/:id', () => {
  it('gives the viewer the WHEP URL but not the WHIP URL', async () => {
    mockStream();
    const env = makeEnv();
    const { sessionId } = await (await worker.fetch(post(), env, ctx)).json();

    const res = await worker.fetch(
      new Request(`https://paddock.example/api/session/${sessionId}`),
      env,
      ctx,
    );
    const body = await res.json();
    expect(body.whepUrl).toContain('webRTC/play');
    expect(body.whipUrl).toBeUndefined();
  });

  it('404s an unknown session so the viewer can say "session ended"', async () => {
    const res = await worker.fetch(
      new Request('https://paddock.example/api/session/does-not-exist'),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/session/:id', () => {
  it('deletes the Live Input and then the record — skip it and it costs money', async () => {
    const calls = mockStream();
    const env = makeEnv();
    const { sessionId } = await (await worker.fetch(post(), env, ctx)).json();

    const res = await worker.fetch(
      new Request(`https://paddock.example/api/session/${sessionId}`, { method: 'DELETE' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/live-input-uid'))).toBe(true);
    expect(await env.SESSIONS.get(sessionId)).toBeNull();
  });
});

describe('CORS', () => {
  it('echoes only the exact allowed origin, never *', async () => {
    mockStream();
    const env = makeEnv();
    const ok = await worker.fetch(post(), env, ctx);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://paddock.example');

    const evil = new Request('https://paddock.example/api/session', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: '{}',
    });
    const res = await worker.fetch(evil, env, ctx);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
