/*
 * Request handling, framework-free: every handler takes a plain
 * { query, body, headers } and resolves to { status, json }.
 *
 * server.js (Express) and api/*.js (Vercel) are both thin adapters over these,
 * so the local app and the deployed app cannot drift apart.
 */
import { getPrefectures, getMunicipalities, collectAreas, parseArea } from './deddie.js';
import { putSub, getSub, delSub, countSubs, backend } from './store.js';
import { publicKey, sendTo } from './push.js';
import { runCycle } from './cycle.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ok = json => ({ status: 200, json });

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
export async function subscribe({ body = {} }) {
  const subscription = body.subscription || body;
  if (!validSubscription(subscription)) throw new HttpError(400, 'invalid subscription');

  const areas = [...new Set(
    (Array.isArray(body.areas) ? body.areas : [])
      .map(parseArea).filter(Boolean).map(a => a.key)
  )];
  if (!areas.length) throw new HttpError(400, 'at least one area is required');

  const leadHours = Math.min(Math.max(Number(body.leadHours) || 24, 1), 168);
  const existing = await getSub(subscription.endpoint);

  await putSub({
    subscription,
    areas,
    leadHours,
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
