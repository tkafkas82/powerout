/*
 * Sign-in and per-account preferences.
 *
 *   node --test test/auth.test.js
 *
 * Google's own token verification can't be exercised without Google signing a
 * token for us, so what's tested here is everything we own: session integrity,
 * the rejection paths, and preferences surviving a round trip through the store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'po-auth-'));
process.env.STORE_FILE = path.join(TMP, 'store.json');
process.env.SESSION_FILE = path.join(TMP, 'session.json');
process.env.GOOGLE_CLIENT_ID = '1234567890-test.apps.googleusercontent.com';
delete process.env.SESSION_SECRET;
delete process.env.VAPID_PRIVATE_KEY;

const auth = await import('../lib/auth.js');
const h = await import('../lib/handlers.js');

const USER = { sub: '110000000000000000001', email: 'tasos@example.com', name: 'Tasos K', picture: null };
const cookieHeader = value => ({ cookie: `po_session=${value}` });

test('a signed session round-trips', async () => {
  const token = await auth.signSession(USER);
  const session = await auth.verifySession(token);
  assert.equal(session.sub, USER.sub);
  assert.equal(session.email, USER.email);
  assert.ok(session.exp > Date.now(), 'session should not be born expired');
});

test('a tampered session is rejected', async () => {
  const token = await auth.signSession(USER);
  const [body, mac] = token.split('.');

  // Swap in a different user id, keep the original signature.
  const forgedBody = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    sub: 'someone-else'
  })).toString('base64url');

  assert.equal(await auth.verifySession(`${forgedBody}.${mac}`), null, 'payload swap must fail');
  assert.equal(await auth.verifySession(`${body}.${'a'.repeat(mac.length)}`), null, 'bad mac must fail');
  assert.equal(await auth.verifySession(body), null, 'a session without a mac must fail');
  assert.equal(await auth.verifySession(''), null);
});

test('an expired session is rejected', async () => {
  const body = Buffer.from(JSON.stringify({ sub: USER.sub, exp: Date.now() - 1000 })).toString('base64url');
  const secret = JSON.parse(await fs.readFile(process.env.SESSION_FILE, 'utf8')).secret;
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  assert.equal(await auth.verifySession(`${body}.${mac}`), null);
});

test('ID tokens that were not signed by Google are refused', async () => {
  await assert.rejects(() => auth.verifyGoogleIdToken('not-a-jwt'), /malformed credential/);
  await assert.rejects(() => auth.verifyGoogleIdToken('a.b'), /malformed credential/);

  // Correctly shaped, self-signed, unknown key id — the signature check must not
  // even get the chance to pass.
  const parts = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'made-up' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      sub: 'x',
      exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url'),
    Buffer.from('bogus').toString('base64url')
  ];
  await assert.rejects(() => auth.verifyGoogleIdToken(parts.join('.')), /unknown signing key/);

  // An alg we never accept, so "alg: none" style downgrades are impossible.
  const none = [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    parts[1], ''
  ].join('.');
  await assert.rejects(() => auth.verifyGoogleIdToken(none), /unexpected alg/);
});

test('preferences need a session, then survive a round trip', async () => {
  const areas = [
    { key: '24', prefectureId: 24, municipalityId: null, prefectureName: 'ΙΩΑΝΝΙΝΩΝ', municipalityName: null },
    { key: '10:1234', prefectureId: 10, municipalityId: 1234, prefectureName: 'ΑΤΤΙΚΗΣ', municipalityName: 'ΔΗΜΟΣ ΒΥΡΩΝΑ' }
  ];

  await assert.rejects(() => h.savePrefs({ headers: {}, body: { areas } }), /not signed in/);

  const headers = cookieHeader(await auth.signSession(USER));
  const saved = await h.savePrefs({ headers, body: { areas, leadHours: 3 } });
  assert.equal(saved.json.prefs.areas.length, 2);
  assert.equal(saved.json.prefs.leadHours, 3);

  // A second device reads them back from /api/config with the same cookie.
  const cfg = await h.config({ headers });
  assert.equal(cfg.json.user.sub, USER.sub);
  assert.equal(cfg.json.prefs.areas.length, 2);
  assert.deepEqual(cfg.json.prefs.areas.map(a => a.key), ['24', '10:1234']);
  assert.equal(cfg.json.prefs.areas[1].municipalityName, 'ΔΗΜΟΣ ΒΥΡΩΝΑ',
    'display names travel with the areas so another device can render chips');

  // Anonymous callers see the config but nobody's preferences.
  const anon = await h.config({ headers: {} });
  assert.equal(anon.json.user, null);
  assert.equal(anon.json.prefs, null);
  assert.equal(anon.json.googleClientId, process.env.GOOGLE_CLIENT_ID);
});

test('preferences are clamped and junk areas dropped', async () => {
  const headers = cookieHeader(await auth.signSession(USER));
  const saved = await h.savePrefs({
    headers,
    body: {
      areas: [{ key: '24' }, { key: 'nonsense' }, { key: '0' }, null, { key: '55:900' }],
      leadHours: 9999
    }
  });
  assert.deepEqual(saved.json.prefs.areas.map(a => a.key), ['24', '55:900']);
  assert.equal(saved.json.prefs.leadHours, 168, 'lead time is capped at a week');
});

test('login sets a session cookie, logout clears it', async () => {
  const out = await h.logout({ headers: {} });
  const cookie = out.cookies[0];
  assert.match(cookie, /^po_session=;/);
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(!/Secure/.test(cookie), 'no Secure flag over plain http, or localhost could never log in');

  const https = await h.logout({ headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.cookies[0], /Secure/);
});

test('a bad credential fails the login with 401, not a 500', async () => {
  await assert.rejects(
    () => h.login({ body: { credential: 'garbage' }, headers: {} }),
    err => err.status === 401
  );
});
