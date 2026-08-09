/*
 * Web Push transport. VAPID keys come from the environment when they're set
 * (required on Vercel); locally we generate a pair once and keep it in
 * data/vapid.json, so `start.bat` gives you working push with no setup.
 *
 * Rotating keys invalidates every existing subscription — delete the file (or
 * change the env vars) only if you're prepared for every device to re-subscribe.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';
import { allSubs, delSub } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAPID_FILE = process.env.VAPID_FILE || path.join(HERE, '..', 'data', 'vapid.json');

let keysPromise;

export function getVapid() {
  if (keysPromise) return keysPromise;
  keysPromise = (async () => {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      return {
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY,
        contact: process.env.VAPID_CONTACT || 'mailto:admin@example.com',
        source: 'env'
      };
    }
    // Serverless filesystems are read-only and per-instance: a generated key
    // wouldn't survive, and two instances would disagree. Fail loudly instead.
    if (process.env.VERCEL) {
      throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY must be set in the Vercel environment');
    }
    try {
      const saved = JSON.parse(await fs.readFile(VAPID_FILE, 'utf8'));
      if (saved.publicKey && saved.privateKey) return { ...saved, source: 'file' };
    } catch { /* fall through and generate */ }

    const generated = webpush.generateVAPIDKeys();
    const record = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      contact: process.env.VAPID_CONTACT || 'mailto:admin@example.com'
    };
    await fs.mkdir(path.dirname(VAPID_FILE), { recursive: true });
    await fs.writeFile(VAPID_FILE, JSON.stringify(record, null, 2));
    return { ...record, source: 'generated' };
  })().catch(err => { keysPromise = undefined; throw err; });
  return keysPromise;
}

let configured = false;
async function configure() {
  const keys = await getVapid();
  if (!configured) {
    webpush.setVapidDetails(keys.contact, keys.publicKey, keys.privateKey);
    configured = true;
  }
  return keys;
}

export async function publicKey() {
  return (await getVapid()).publicKey;
}

/*
 * Send one payload to one device. A 404/410 means the browser threw the
 * subscription away (app uninstalled, notifications revoked) — drop it rather
 * than retrying it forever.
 */
export async function sendTo(record, payload) {
  await configure();
  try {
    await webpush.sendNotification(record.subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    const code = err?.statusCode;
    if (code === 404 || code === 410) {
      await delSub(record.subscription.endpoint);
      return { ok: false, pruned: true };
    }
    return { ok: false, error: err.message, code };
  }
}

// Broadcast — used by /api/test-push and nothing else; the cycle sends
// per-device payloads because every device watches different areas.
export async function pushAll(payload) {
  const subs = await allSubs();
  const results = await Promise.all(subs.map(s => sendTo(s, payload)));
  return {
    sent: results.filter(r => r.ok).length,
    pruned: results.filter(r => r.pruned).length,
    failed: results.filter(r => !r.ok && !r.pruned).length
  };
}
