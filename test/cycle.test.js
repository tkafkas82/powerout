/*
 * End-to-end test of the push cycle.
 *
 * Real store, real diff, real web-push encryption and VAPID signing — only the
 * push *service* is faked: a local HTTP server stands in for FCM/Mozilla, so we
 * can assert exactly which notifications a device would receive.
 *
 *   node --test test/
 *
 * Hits the live DEDDIE site for the outage list (that's the point — it catches
 * markup changes too), so it needs network access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'po-test-'));
process.env.STORE_FILE = path.join(TMP, 'store.json');
process.env.VAPID_FILE = path.join(TMP, 'vapid.json');

/*
 * web-push always dials out over TLS. Rather than stand up a certificate just to
 * talk to ourselves, swap the transport for plain HTTP: everything above the
 * socket — payload encryption, VAPID signing, headers — still runs for real.
 */
const require = createRequire(import.meta.url);
require('node:https').request = (options, cb) => http.request(options, cb);

// Imported after the env is set, so they pick up the temp paths.
const { runCycle } = await import('../lib/cycle.js');
const { putSub, getJson, setJson, allSubs } = await import('../lib/store.js');

const AREA = '10';               // Attica: reliably has a full schedule
const received = [];

// ---- stand-in push service ---------------------------------------------------
const service = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    received.push({
      url: req.url,
      auth: String(req.headers.authorization || ''),        // VAPID JWT
      encoding: req.headers['content-encoding'],
      encrypted: Buffer.concat(chunks).length               // ciphertext; we only check it isn't empty
    });
    res.writeHead(201).end();
  });
});
await new Promise(r => service.listen(0, '127.0.0.1', r));
const PORT = service.address().port;

// A subscription needs a real P-256 public key and a 16-byte auth secret, or
// web-push refuses to encrypt.
function fakeSubscription(id) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://127.0.0.1:${PORT}/push/${id}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url')
    }
  };
}

const register = (id, leadHours) => putSub({
  subscription: fakeSubscription(id),
  areas: [AREA],
  leadHours,
  sent: {},
  createdAt: new Date().toISOString()
});

const snapshot = () => getJson(`po:snap:${AREA}`);

test.after(() => { service.close(); });

test('first cycle baselines the area instead of announcing everything', async () => {
  await register('baseline', 1);        // 1h lead: almost nothing should qualify
  const result = await runCycle({ ttl: 0 });

  assert.equal(result.baselined, 1, 'the area should be recorded as a baseline');
  const snap = await snapshot();
  assert.ok(Object.keys(snap).length > 0, 'snapshot should hold the current outages');
  assert.equal(received.filter(r => r.url.includes('baseline')).length, 0,
    'a fresh area must not blast one notification per existing outage');
});

test('lead-time reminders fire for outages inside the window, once', async () => {
  received.length = 0;
  await register('lead', 168);          // 7 days: guaranteed to catch something
  await runCycle({ ttl: 0 });

  const mine = received.filter(r => r.url.includes('/push/lead'));
  assert.equal(mine.length, 1, 'a device gets one coalesced push, not one per outage');
  assert.match(mine[0].auth, /^vapid /i, 'request must carry the VAPID authorization header');
  assert.equal(mine[0].encoding, 'aes128gcm', 'payload must be encrypted');
  assert.ok(mine[0].encrypted > 0, 'ciphertext must not be empty');

  received.length = 0;
  await runCycle({ ttl: 0 });
  assert.equal(received.filter(r => r.url.includes('/push/lead')).length, 0,
    'the same reminders must not be re-sent on the next cycle');
});

test('a removed snapshot entry reads as a brand-new outage', async () => {
  const snap = await snapshot();
  const [identity] = Object.keys(snap);
  delete snap[identity];
  await setJson(`po:snap:${AREA}`, snap);

  received.length = 0;
  const result = await runCycle({ ttl: 0 });

  assert.ok(result.events >= 1, 'the re-appearing outage should raise an event');
  assert.ok(received.length >= 1, 'and reach the subscribed devices');
});

test('a shifted schedule reads as changed, and a vanished future outage as cancelled', async () => {
  const snap = await snapshot();
  const entries = Object.entries(snap);

  // Move one outage's times: same identity, different schedule.
  const [changedId, changed] = entries[0];
  snap[changedId] = { ...changed, from: '2030-01-01T08:00:00', to: '2030-01-01T12:00:00' };

  // Invent one that the live list won't contain, dated in the future.
  snap['n:10:__gone__'] = {
    from: '2030-06-01T08:00:00', to: '2030-06-01T12:00:00',
    note: '__gone__', municipalities: ['ΔΟΚΙΜΗ'], description: 'δοκιμαστική ακύρωση', reason: 'Συντήρηση'
  };
  await setJson(`po:snap:${AREA}`, snap);

  received.length = 0;
  const result = await runCycle({ ttl: 0 });

  assert.ok(result.events >= 2, `expected a changed and a cancelled event, got ${result.events}`);
  assert.ok(received.length >= 1, 'devices should be notified');

  const after = await snapshot();
  assert.ok(!after['n:10:__gone__'], 'the invented outage should be gone from the new snapshot');
  assert.equal(after[changedId].from, changed.from, 'the real schedule should be restored');
});

test('a past outage dropping off the list is expiry, not a cancellation', async () => {
  const snap = await snapshot();
  snap['n:10:__expired__'] = {
    from: '2020-01-01T08:00:00', to: '2020-01-01T12:00:00',
    note: '__expired__', municipalities: ['ΔΟΚΙΜΗ'], description: 'παλιά διακοπή', reason: 'Συντήρηση'
  };
  await setJson(`po:snap:${AREA}`, snap);

  received.length = 0;
  const result = await runCycle({ ttl: 0 });

  assert.equal(result.events, 0, 'an outage that already finished must not alert as cancelled');
  assert.equal(received.length, 0);
});

test('subscriptions carry their own areas and lead time', async () => {
  const subs = await allSubs();
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map(s => s.leadHours).sort((a, b) => a - b), [1, 168]);
  assert.ok(subs.every(s => s.areas.includes(AREA)));
  assert.ok(subs.some(s => Object.keys(s.sent).length > 0), 'sent events should be remembered per device');
});
