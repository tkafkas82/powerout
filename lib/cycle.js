/*
 * The push engine: poll DEDDIE, diff against the last snapshot, and send each
 * device only what it hasn't been told yet.
 *
 * Runs identically from the local server's scheduler and from /api/cron on
 * Vercel, so the two deployments can't drift apart.
 *
 * Four things earn a push (all three diff kinds plus the timer):
 *   new        an outage appeared that touches a watched area
 *   changed    an outage we already announced moved its start/end
 *   cancelled  an outage we already announced vanished while still in the future
 *   lead       a known outage is now inside the device's lead-time window
 *
 * Per-device state, not global: everyone watches different areas with different
 * lead times, so `sent` lives on the subscription record.
 */
import { collectAreas } from './deddie.js';
import { allSubs, putSub, getJson, setJson } from './store.js';
import { sendTo } from './push.js';
import { athensEpoch, formatRange, formatLead } from './time.js';

const SENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // forget acknowledged events after 2 weeks
const MAX_LINES = 4;                            // lines listed in a coalesced push

const snapKey = areaKey => `po:snap:${areaKey}`;

/*
 * Compare an area's current outages with the previous snapshot.
 *
 * Keyed by `identity` (see lib/deddie.js), which survives a reschedule — that's
 * what separates "moved to another day" from "brand new outage".
 */
async function diffArea(area) {
  const now = {};
  for (const o of area.outages) {
    now[o.identity] = {
      id: o.id, from: o.from, to: o.to, note: o.note, reason: o.reason,
      municipalities: o.municipalities, description: o.description.slice(0, 400)
    };
  }

  const prev = await getJson(snapKey(area.key));
  await setJson(snapKey(area.key), now);

  // First sight of an area: record it, announce nothing. Otherwise every device
  // would get a blast of "new" for outages that were simply already there.
  if (!prev) return { baseline: true, added: [], changed: [], cancelled: [] };

  const added = [], changed = [], cancelled = [];
  const nowMs = Date.now();

  for (const [identity, o] of Object.entries(now)) {
    const was = prev[identity];
    if (!was) added.push({ identity, ...o });
    else if (was.from !== o.from || was.to !== o.to) changed.push({ identity, ...o, was });
  }

  for (const [identity, was] of Object.entries(prev)) {
    if (now[identity]) continue;
    // DEDDIE drops outages once they're done — that's expiry, not cancellation.
    const start = athensEpoch(was.from);
    if (start && start > nowMs) cancelled.push({ identity, ...was });
  }

  return { baseline: false, added, changed, cancelled };
}

// One line of push text per event.
function describe(ev, areaLabel, now) {
  const from = athensEpoch(ev.outage.from);
  const to = athensEpoch(ev.outage.to);
  const when = formatRange(from, to, now);
  const where = ev.outage.municipalities?.[0] || areaLabel;

  switch (ev.kind) {
    case 'new':       return { icon: '⚡', title: `Νέα διακοπή — ${where}`, line: `Νέα: ${when} · ${where}` };
    case 'lead':      return { icon: '⚡', title: `Διακοπή ${formatLead(from - now)} — ${where}`, line: `${when} · ${where}` };
    case 'changed':   return { icon: '🕒', title: `Άλλαξε η ώρα — ${where}`, line: `Αλλαγή: ${when} · ${where}` };
    case 'cancelled': return { icon: '✅', title: `Ακυρώθηκε — ${where}`, line: `Ακύρωση: ${when} · ${where}` };
    default:          return { icon: '⚡', title: where, line: when };
  }
}

/*
 * An event is announced at most once per device. The key carries the schedule so
 * a rescheduled outage legitimately re-alerts (new times => new lead reminder),
 * while a re-run of the cycle over unchanged data stays silent.
 */
const eventKey = ev =>
  ev.kind === 'new' ? `new:${ev.identity}` : `${ev.kind}:${ev.identity}:${ev.outage.from || '?'}`;

function buildPayload(events, now) {
  if (events.length === 1) {
    const e = events[0];
    const d = describe(e, e.areaLabel, now);
    return {
      title: `${d.icon} ${d.title}`,
      body: [
        formatRange(athensEpoch(e.outage.from), athensEpoch(e.outage.to), now),
        e.outage.reason,
        (e.outage.description || '').split('\n')[0].slice(0, 140)
      ].filter(Boolean).join('\n'),
      tag: eventKey(e),
      count: 1
    };
  }
  const lines = events.slice(0, MAX_LINES).map(e => describe(e, e.areaLabel, now).line);
  if (events.length > MAX_LINES) lines.push(`…και άλλες ${events.length - MAX_LINES}`);
  return {
    title: `⚡ ${events.length} ενημερώσεις διακοπών`,
    body: lines.join('\n'),
    tag: 'outages-digest',
    count: events.length
  };
}

function pruneSent(sent, now) {
  const kept = {};
  for (const [k, ts] of Object.entries(sent || {})) {
    if (now - ts < SENT_TTL_MS) kept[k] = ts;
  }
  return kept;
}

/*
 * A device bound to a Google account follows the account's current areas, not
 * the snapshot it uploaded when it subscribed — otherwise adding an area on the
 * phone would leave the laptop alerting on the old set until someone opened it.
 */
async function areasFor(sub) {
  if (!sub.userSub) return sub.areas || [];
  const prefs = await getJson(`po:user:${sub.userSub}`);
  const keys = (prefs?.areas || []).map(a => a.key).filter(Boolean);
  return keys.length ? keys : (sub.areas || []);
}

export async function runCycle({ ttl } = {}) {
  const subs = await allSubs();
  if (!subs.length) return { subs: 0, areas: 0, sent: 0, events: 0, note: 'no subscriptions' };

  // Resolve once; every later step reads sub.areas through this.
  for (const sub of subs) sub.areas = await areasFor(sub);

  const areaKeys = [...new Set(subs.flatMap(s => s.areas || []))].filter(Boolean);
  if (!areaKeys.length) return { subs: subs.length, areas: 0, sent: 0, events: 0, note: 'no watched areas' };

  const areas = await collectAreas(areaKeys, ttl === undefined ? undefined : { ttl });
  const byKey = new Map(areas.map(a => [a.key, a]));

  // Diff every area once, no matter how many devices watch it.
  const diffs = new Map();
  for (const area of areas) {
    if (area.error) continue;
    diffs.set(area.key, await diffArea(area));
  }

  const now = Date.now();
  let totalEvents = 0, sentCount = 0, prunedCount = 0;

  for (const sub of subs) {
    const sent = pruneSent(sub.sent, now);
    const leadMs = (Number(sub.leadHours) || 24) * 3600000;
    const events = [];
    const seen = new Set();

    const add = (kind, identity, outage, areaLabel) => {
      const ev = { kind, identity, outage, areaLabel };
      const k = eventKey(ev);
      // The same outage can reach a device through two watched areas
      // (a prefecture and one of its municipalities) — announce it once.
      if (seen.has(k) || sent[k]) return;
      seen.add(k);
      events.push(ev);
    };

    for (const areaKey of sub.areas || []) {
      const area = byKey.get(areaKey);
      const diff = diffs.get(areaKey);
      if (!area || !diff) continue;
      const label = area.municipalityName || area.prefectureName;

      for (const o of diff.added) add('new', o.identity, o, label);
      for (const o of diff.changed) add('changed', o.identity, o, label);
      for (const o of diff.cancelled) add('cancelled', o.identity, o, label);

      // Lead reminders run against the live list, including outages that were
      // already known — the diff kinds above only cover what just moved.
      for (const o of area.outages) {
        const start = athensEpoch(o.from);
        if (!start) continue;
        const delta = start - now;
        if (delta > 0 && delta <= leadMs) add('lead', o.identity, o, label);
      }
    }

    if (!events.length) continue;
    events.sort((a, b) => String(a.outage.from).localeCompare(String(b.outage.from)));
    totalEvents += events.length;

    const result = await sendTo(sub, buildPayload(events, now));
    if (result.pruned) { prunedCount++; continue; }          // device is gone; record deleted
    if (!result.ok) continue;                                 // transient failure: retry next cycle

    sentCount++;
    for (const ev of events) sent[eventKey(ev)] = now;
    await putSub({ ...sub, sent, lastPush: new Date(now).toISOString() });
  }

  return {
    subs: subs.length,
    areas: areaKeys.length,
    baselined: [...diffs.values()].filter(d => d.baseline).length,
    events: totalEvents,
    sent: sentCount,
    pruned: prunedCount,
    failedAreas: areas.filter(a => a.error).map(a => a.key)
  };
}
