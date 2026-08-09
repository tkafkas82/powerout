/*
 * Request handling, framework-free: every handler takes a plain
 * { query, body, headers } and resolves to { status, json }.
 *
 * server.js (Express) and api/*.js (Vercel) are both thin adapters over these,
 * so the local app and the deployed app cannot drift apart.
 */
import { getPrefectures, getMunicipalities, collectAreas, parseArea } from './deddie.js';
import { putSub, getSub, delSub, countSubs, getJson, setJson, backend } from './store.js';
import { publicKey, sendTo } from './push.js';
import { runCycle } from './cycle.js';
import {
  googleClientId, authConfigured, verifyGoogleIdToken,
  signSession, currentUser, sessionCookie, clearCookie
} from './auth.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ok = (json, cookies) => ({ status: 200, json, cookies });

const prefsKey = sub => `po:user:${sub}`;
const loadPrefs = sub => getJson(prefsKey(sub));

export async function prefectures() {
  return ok(await getPrefectures());
}

export async function municipalities({ query = {} }) {
  const prefecture = Number(query.prefecture);
  if (!Number.isFinite(prefecture) || prefecture <= 0) {
    throw new HttpError(400, 'prefecture is required');
  }
  return ok(await getMunicipalities(prefecture));
}

export async function outages({ query = {} }) {
  const specs = String(query.areas || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!specs.length) throw new HttpError(400, 'areas is required, e.g. areas=24:495,10');
  const areas = await collectAreas(specs);
  return ok({ fetchedAt: new Date().toISOString(), areas });
}

/*
 * Everything the client needs on boot: whether sign-in exists at all, who the
 * caller is, and their stored areas. One round trip so the page can decide
 * between server preferences and its localStorage copy before first paint.
 */
export async function config({ headers = {} }) {
  const user = await currentUser(headers);
  return ok({
    googleClientId: googleClientId(),
    user,
    prefs: user ? await loadPrefs(user.sub) : null
  });
}

export async function login({ body = {}, headers = {} }) {
  if (!authConfigured()) throw new HttpError(503, 'Google sign-in is not configured on this server');
  let user;
  try {
    user = await verifyGoogleIdToken(body.credential);
  } catch (err) {
    throw new HttpError(401, err.message);
  }
  const cookie = sessionCookie(await signSession(user), headers);
  return ok({ user, prefs: await loadPrefs(user.sub) }, [cookie]);
}

export async function logout({ headers = {} }) {
  return ok({ ok: true }, [clearCookie(headers)]);
}

/*
 * Store the signed-in user's watched areas. Areas are kept as the client's own
 * objects (ids plus display names) so a second device can render the chips
 * without refetching every prefecture and municipality list.
 */
export async function savePrefs({ headers = {}, body = {} }) {
  const user = await currentUser(headers);
  if (!user) throw new HttpError(401, 'not signed in');

  const areas = (Array.isArray(body.areas) ? body.areas : [])
    .map(a => {
      const parsed = parseArea(a?.key ?? a);
      if (!parsed) return null;
      return {
        key: parsed.key,
        prefectureId: parsed.prefectureId,
        municipalityId: parsed.municipalityId,
        prefectureName: String(a?.prefectureName || '').slice(0, 100),
        municipalityName: a?.municipalityName ? String(a.municipalityName).slice(0, 100) : null
      };
    })
    .filter(Boolean);

  const prefs = {
    areas,
    leadHours: Math.min(Math.max(Number(body.leadHours) || 24, 1), 168),
    email: user.email,
    name: user.name,
    updatedAt: new Date().toISOString()
  };
  await setJson(prefsKey(user.sub), prefs);
  return ok({ ok: true, prefs });
}

export async function vapidPublicKey() {
  try {
    return ok({ publicKey: await publicKey() });
  } catch (err) {
    // No keys configured — the client shows "push unavailable" rather than
    // dying, so the app still works as a plain viewer.
    throw new HttpError(503, err.message);
  }
}

function validSubscription(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https?:\/\//.test(sub.endpoint);
}

/*
 * Register or update a device.
 *
 * The client re-syncs on every load and whenever areas change, so this has to be
 * idempotent — and it must carry `sent` forward, otherwise a page refresh would
 * re-announce every outage the device has already been told about.
 */
export async function subscribe({ body = {}, headers = {} }) {
  const subscription = body.subscription || body;
  if (!validSubscription(subscription)) throw new HttpError(400, 'invalid subscription');

  const areas = [...new Set(
    (Array.isArray(body.areas) ? body.areas : [])
      .map(parseArea).filter(Boolean).map(a => a.key)
  )];
  if (!areas.length) throw new HttpError(400, 'at least one area is required');

  const leadHours = Math.min(Math.max(Number(body.leadHours) || 24, 1), 168);
  const existing = await getSub(subscription.endpoint);
  const user = await currentUser(headers);

  await putSub({
    subscription,
    areas,
    leadHours,
    // Bound to the account when signed in, so the cycle follows the user's
    // current areas rather than whatever this device last uploaded — change
    // your areas on the phone and the laptop's alerts move with them.
    userSub: user?.sub || null,
    sent: existing?.sent || {},
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userAgent: String(body.userAgent || '').slice(0, 200)
  });

  return ok({ ok: true, areas, leadHours, devices: await countSubs() });
}

export async function unsubscribe({ body = {} }) {
  const endpoint = body.endpoint || body.subscription?.endpoint;
  if (!endpoint) throw new HttpError(400, 'endpoint is required');
  await delSub(endpoint);
  return ok({ ok: true, devices: await countSubs() });
}

// Self-targeted: a device can only test itself, so this needs no secret.
export async function testPush({ body = {} }) {
  const endpoint = body.endpoint || body.subscription?.endpoint;
  if (!endpoint) throw new HttpError(400, 'endpoint is required');
  const record = await getSub(endpoint);
  if (!record) throw new HttpError(404, 'this device is not subscribed');

  const result = await sendTo(record, {
    title: '⚡ Δοκιμαστική ειδοποίηση',
    body: `Οι ειδοποιήσεις λειτουργούν.\nΠαρακολουθείς ${record.areas.length} ${record.areas.length === 1 ? 'περιοχή' : 'περιοχές'}.`,
    tag: 'test',
    count: 1
  });
  if (!result.ok) throw new HttpError(502, result.error || 'push failed');
  return ok({ ok: true });
}

/*
 * Poll + diff + push. Protected by CRON_SECRET when one is set — on a public
 * deployment this is the endpoint that costs money to run.
 */
export async function cron({ headers = {}, query = {} }) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = headers['x-cron-secret'] || query.secret ||
      String(headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (given !== secret) throw new HttpError(401, 'bad cron secret');
  }
  const result = await runCycle({ ttl: 0 });   // always fetch fresh
  return ok({ ranAt: new Date().toISOString(), store: backend, ...result });
}
