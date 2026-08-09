/*
 * Persistence with two backends, chosen by environment:
 *
 *   Upstash Redis (REST) — when UPSTASH_REDIS_REST_URL/TOKEN or the Vercel KV
 *     equivalents are set. Required on Vercel, where the filesystem is ephemeral
 *     and every invocation may land on a different instance.
 *   JSON file — otherwise. This is what the local server uses, so push works on
 *     the laptop with no accounts and no setup.
 *
 * Same surface either way, so lib/cycle.js never knows which one it got.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.STORE_FILE || path.join(HERE, '..', 'data', 'store.json');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const backend = REDIS_URL && REDIS_TOKEN ? 'redis' : 'file';

const SUBS = 'po:subs';

// ---- redis backend -----------------------------------------------------------
let _redis;
async function redis() {
  if (_redis) return _redis;
  // Imported lazily so the local file backend never needs the dependency installed.
  const { Redis } = await import('@upstash/redis');
  _redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  return _redis;
}

// ---- file backend ------------------------------------------------------------
// All writes go through one promise chain: concurrent callers can't interleave a
// read-modify-write and lose each other's changes.
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readFile() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { subs: {}, kv: {} };
    throw err;
  }
}

async function writeFile(data) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, FILE);     // atomic-ish: readers never see a half file
}

const mutate = fn => serialize(async () => {
  const data = await readFile();
  const result = await fn(data);
  await writeFile(data);
  return result;
});

// ---- public API --------------------------------------------------------------
// A subscription record is { subscription, areas, leadHours, sent, createdAt },
// keyed by its push endpoint so re-subscribing the same device is idempotent.
export async function putSub(record) {
  if (backend === 'redis') {
    const r = await redis();
    return r.hset(SUBS, { [record.subscription.endpoint]: record });
  }
  return mutate(data => { data.subs[record.subscription.endpoint] = record; });
}

export async function delSub(endpoint) {
  if (backend === 'redis') {
    const r = await redis();
    return r.hdel(SUBS, endpoint);
  }
  return mutate(data => { delete data.subs[endpoint]; });
}

export async function getSub(endpoint) {
  if (backend === 'redis') {
    const r = await redis();
    return (await r.hget(SUBS, endpoint)) || null;
  }
  const data = await readFile();
  return data.subs[endpoint] || null;
}

export async function allSubs() {
  if (backend === 'redis') {
    const r = await redis();
    return Object.values((await r.hgetall(SUBS)) || {});
  }
  return Object.values((await readFile()).subs);
}

export async function countSubs() {
  return (await allSubs()).length;
}

export async function getJson(key) {
  if (backend === 'redis') {
    const r = await redis();
    return (await r.get(key)) ?? null;     // @upstash/redis returns parsed JSON
  }
  return (await readFile()).kv[key] ?? null;
}

export async function setJson(key, value) {
  if (backend === 'redis') {
    const r = await redis();
    return r.set(key, value);
  }
  return mutate(data => { data.kv[key] = value; });
}
