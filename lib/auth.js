/*
 * Google sign-in, so a phone and a laptop can share one set of watched areas.
 *
 * Flow: Google Identity Services hands the browser a signed ID token; we verify
 * it against Google's public keys, then mint our own cookie session. No client
 * secret and no redirect dance — the ID token is all a "sign in to save my
 * preferences" feature needs.
 *
 * Everything here is optional. With no GOOGLE_CLIENT_ID the endpoints report
 * "not configured", the client hides the button, and the app keeps working
 * exactly as it did with preferences in localStorage.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = process.env.SESSION_FILE || path.join(HERE, '..', 'data', 'session.json');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const COOKIE = 'po_session';
const SESSION_DAYS = 180;

export const googleClientId = () => process.env.GOOGLE_CLIENT_ID || null;
export const authConfigured = () => Boolean(googleClientId());

// ---- session secret ----------------------------------------------------------
let secretPromise;

/*
 * Falls back to the VAPID private key so a Vercel deployment needs no extra
 * variable — it's already a secret that lives only on the server. Set
 * SESSION_SECRET explicitly if you ever want to rotate sessions without
 * invalidating every push subscription.
 */
function sessionSecret() {
  if (secretPromise) return secretPromise;
  secretPromise = (async () => {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    if (process.env.VAPID_PRIVATE_KEY) return `vapid:${process.env.VAPID_PRIVATE_KEY}`;
    if (process.env.VERCEL) throw new Error('SESSION_SECRET (or VAPID_PRIVATE_KEY) must be set');
    try {
      const saved = JSON.parse(await fs.readFile(SECRET_FILE, 'utf8'));
      if (saved.secret) return saved.secret;
    } catch { /* generate below */ }
    const secret = crypto.randomBytes(32).toString('base64url');
    await fs.mkdir(path.dirname(SECRET_FILE), { recursive: true });
    await fs.writeFile(SECRET_FILE, JSON.stringify({ secret }, null, 2));
    return secret;
  })().catch(err => { secretPromise = undefined; throw err; });
  return secretPromise;
}

// ---- Google ID token verification -------------------------------------------
let certsCache = { at: 0, keys: null };

async function googleKeys() {
  if (certsCache.keys && Date.now() - certsCache.at < 60 * 60 * 1000) return certsCache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Google certs ${res.status}`);
  const { keys } = await res.json();
  certsCache = { at: Date.now(), keys };
  return keys;
}

const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/*
 * Verify signature, issuer, audience and expiry. Anything less and the endpoint
 * would accept a token minted for someone else's app — the audience check is
 * what ties the token to *this* project.
 */
export async function verifyGoogleIdToken(token) {
  const clientId = googleClientId();
  if (!clientId) throw new Error('Google sign-in is not configured');

  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed credential');
  const [h, p, s] = parts;

  const header = b64json(h);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(s, 'base64url')
  );
  if (!ok) throw new Error('bad signature');

  const payload = b64json(p);
  if (!ISSUERS.has(payload.iss)) throw new Error('bad issuer');
  if (payload.aud !== clientId) throw new Error('token was not issued for this app');
  if (Number(payload.exp) * 1000 < Date.now()) throw new Error('token expired');
  if (payload.email && payload.email_verified === false) throw new Error('email not verified');

  return {
    sub: payload.sub,
    email: payload.email || null,
    name: payload.name || null,
    picture: payload.picture || null
  };
}

// ---- our own session cookie --------------------------------------------------
// payload.signature, HMAC-SHA256. Small and stateless: no session store to keep
// in sync between the laptop and the serverless copies.
export async function signSession(user) {
  const body = Buffer.from(JSON.stringify({
    sub: user.sub, email: user.email, name: user.name, picture: user.picture,
    exp: Date.now() + SESSION_DAYS * 86400000
  })).toString('base64url');
  const mac = crypto.createHmac('sha256', await sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export async function verifySession(value) {
  if (!value || !value.includes('.')) return null;
  const [body, mac] = value.split('.');
  const expected = crypto.createHmac('sha256', await sessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = b64json(body);
    if (!session.sub || session.exp < Date.now()) return null;
    return session;
  } catch { return null; }
}

export function readCookie(header, name = COOKIE) {
  return String(header || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || null;
}

// Secure only over HTTPS: a Secure cookie would never be stored on
// http://localhost:4950, which is where the local server lives.
function cookieFlags(headers = {}) {
  const https = process.env.VERCEL || headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${https ? '; Secure' : ''}`;
}

export const sessionCookie = (value, headers) => `${COOKIE}=${value}; ${cookieFlags(headers)}`;
export const clearCookie = headers => `${COOKIE}=; ${cookieFlags(headers).replace(/Max-Age=\d+/, 'Max-Age=0')}`;

// Resolve the caller's session from a request's headers, or null.
export async function currentUser(headers = {}) {
  if (!authConfigured()) return null;
  return verifySession(readCookie(headers.cookie));
}
