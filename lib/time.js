/*
 * DEDDIE publishes local-naive wall-clock times ("2026-08-11T08:00:00" meaning
 * 08:00 in Greece). The browser can read those with `new Date(...)` because the
 * user is in the same timezone — the server cannot: locally it happens to be
 * Greek time, on Vercel it is UTC, and a 3-hour error would make every lead-time
 * reminder fire late. So everything server-side anchors the naive stamp to
 * Europe/Athens explicitly.
 */
const TZ = 'Europe/Athens';

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

// How far the given instant's Athens wall clock is ahead of UTC.
function offsetAt(epoch) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - epoch;
}

// "2026-08-11T08:00:00" (Athens wall clock) -> epoch ms.
export function athensEpoch(naive) {
  if (!naive) return null;
  const m = String(naive).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, Y, M, D, h, mi, s] = m.map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, mi, s || 0);
  // Two passes so the hour that DST moves still resolves correctly: the offset
  // is sampled at the instant we actually land on, not at the UTC guess.
  const once = guess - offsetAt(guess);
  return guess - offsetAt(once);
}

const parts = epoch => Object.fromEntries(
  FMT.formatToParts(new Date(epoch)).map(x => [x.type, x.value])
);

const WEEKDAYS = ['Κυρ', 'Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ'];

export function athensWeekday(epoch) {
  const p = parts(epoch);
  // Day-of-week of the Athens calendar date, read off a UTC-anchored copy.
  return WEEKDAYS[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
}

const hhmm = epoch => { const p = parts(epoch); return `${p.hour}:${p.minute}`; };

// "Δευ 11/8, 08:00–14:00", collapsing the day when it's today.
export function formatRange(fromEpoch, toEpoch, now = Date.now()) {
  if (!fromEpoch) return '';
  const f = parts(fromEpoch), n = parts(now);
  const sameDay = f.year === n.year && f.month === n.month && f.day === n.day;
  const day = sameDay ? 'Σήμερα' : `${athensWeekday(fromEpoch)} ${+f.day}/${+f.month}`;
  return toEpoch ? `${day}, ${hhmm(fromEpoch)}–${hhmm(toEpoch)}` : `${day}, ${hhmm(fromEpoch)}`;
}

// "σε 40′" / "σε 3ω" / "σε 2 ημέρες"
export function formatLead(ms) {
  const mins = Math.round(ms / 60000);
  if (mins <= 0) return 'τώρα';
  if (mins < 60) return `σε ${mins}′`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `σε ${hours}ω`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'σε 1 ημέρα' : `σε ${days} ημέρες`;
}
