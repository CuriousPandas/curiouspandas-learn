// A toy JWT: base64url(header).base64url(payload).base64url(signature), signed
// with HMAC-SHA-256 through WebCrypto, so the signature is real and editing one
// character of the payload really does break it. Two verifiers: one that trusts
// the token's own header (the hole RFC 8725 section 2.1 describes) and one that
// follows its advice - the caller decides the algorithm, then issuer, audience
// and expiry are checked (RFC 8725 3.1, 3.8, 3.9; OIDC Core 3.1.3.7).

// Obviously not a real secret, and shaped so no secret scanner mistakes it for one.
export const DEMO_KEY = 'panda-demo-key-not-a-real-secret';
export const ISSUER = 'https://auth.toy/realms/panda';
export const AUDIENCE = 'toy-shop';

const enc = new TextEncoder(), dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 1 ? null : '';
  if (pad === null) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const encodeJson = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

export async function sign(payload: object, key = DEMO_KEY): Promise<string> {
  const head = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const body = encodeJson(payload);
  return `${head}.${body}.${b64url(await hmac(key, `${head}.${body}`))}`;
}

// What an attacker sends: whatever header they like, and no signature.
export const unsigned = (payload: object) => `${encodeJson({ alg: 'none', typ: 'JWT' })}.${encodeJson(payload)}.`;

export type Decoded = { header: Record<string, unknown>; payload: Record<string, unknown>; signature: string; signed: string };

export function decode(token: string): Decoded {
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw new Error(`a JWT has 3 parts separated by dots; this has ${parts.length}`);
  const json = (s: string, what: string) => {
    try { return JSON.parse(dec.decode(unb64url(s))); } catch { throw new Error(`the ${what} is not base64url-encoded JSON`); }
  };
  return { header: json(parts[0], 'header'), payload: json(parts[1], 'payload'), signature: parts[2], signed: `${parts[0]}.${parts[1]}` };
}

// Constant-time-ish comparison; real libraries do this properly, and a toy
// should not teach the leaky version.
const same = (a: string, b: string) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

export type Verdict = { ok: boolean; reason: string; claims?: Record<string, unknown> };

// The broken one. It asks the token how to check the token.
export async function verifyNaive(token: string, key = DEMO_KEY): Promise<Verdict> {
  let d: Decoded;
  try { d = decode(token); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (d.header.alg === 'none') return { ok: true, reason: 'header says alg "none", so there is no signature to check - accepted', claims: d.payload };
  if (d.header.alg !== 'HS256') return { ok: false, reason: `unknown alg "${String(d.header.alg)}"` };
  return same(d.signature, b64url(await hmac(key, d.signed)))
    ? { ok: true, reason: 'signature matches', claims: d.payload }
    : { ok: false, reason: 'signature does not match the header and payload' };
}

// The one to copy. The server decides the algorithm, never the token.
export async function verifyStrict(token: string, opts: { key?: string; now?: number; iss?: string; aud?: string } = {}): Promise<Verdict> {
  const { key = DEMO_KEY, now = Math.floor(Date.now() / 1000), iss = ISSUER, aud = AUDIENCE } = opts;
  let d: Decoded;
  try { d = decode(token); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (d.header.alg !== 'HS256') return { ok: false, reason: `alg "${String(d.header.alg)}" is not on this server's allow-list (HS256 only)` };
  if (!same(d.signature, b64url(await hmac(key, d.signed)))) return { ok: false, reason: 'signature does not match the header and payload' };
  const p = d.payload;
  if (p.iss !== iss) return { ok: false, reason: `issuer "${String(p.iss)}" is not the one this server trusts` };
  const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!auds.includes(aud)) return { ok: false, reason: `audience ${JSON.stringify(p.aud)} does not include "${aud}" - this token was issued for another app` };
  if (typeof p.exp !== 'number' || p.exp <= now) return { ok: false, reason: 'token has expired (or has no exp)' };
  return { ok: true, reason: 'algorithm allowed, signature, issuer, audience and expiry all check out', claims: p };
}

export const claims = (over: Record<string, unknown> = {}, now = Math.floor(Date.now() / 1000)) =>
  ({ iss: ISSUER, sub: 'learner-42', aud: AUDIENCE, iat: now, exp: now + 3600, name: 'Curious Learner', role: 'viewer', ...over });
