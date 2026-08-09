/*
 * DEDDIE scraper — the only place that knows about their HTML.
 *
 * Source: https://siteapps.deddie.gr/outages2public
 *   There is no JSON API. It's a classic ASP.NET MVC page that renders
 *   server-side HTML partials over unobtrusive-ajax. Three shapes matter:
 *
 *     GET  /outages2public/                        -> full page, contains the
 *                                                     <select id="PrefectureID"> list
 *     POST /Outages2Public/?Length=4               -> form post with PrefectureID; the
 *                                                     reply re-renders the form, so the
 *                                                     <select id="MunicipalityID"> list
 *                                                     for that prefecture comes back with it
 *     POST /Outages2Public/Home/OutagesPartial?page=N&municipalityID=&prefectureID=N
 *                                                  -> just the results table + pager
 *
 *   Quirks worth remembering:
 *     - Every POST must carry a Content-Length, even an empty body: the edge
 *       (Incapsula) answers 411 otherwise. We always send ''.
 *     - The pager is 8 rows/page; the last page number is only discoverable from
 *       the pager links in the page-1 response.
 *     - Dates render as Greek locale strings: "9/8/2026 7:45:00 πμ" (d/M/yyyy, πμ/μμ).
 */

const BASE = 'https://siteapps.deddie.gr';
const PAGE_URL = `${BASE}/outages2public/`;
const FORM_URL = `${BASE}/Outages2Public/?Length=4`;
const PARTIAL_URL = `${BASE}/Outages2Public/Home/OutagesPartial`;

const MAX_PAGES = 40;        // hard stop; Attica peaks around 7
const PAGE_CONCURRENCY = 4;

export const TTL_LOOKUP = 12 * 60 * 60 * 1000;  // prefectures / municipalities barely change
export const TTL_OUTAGES = 10 * 60 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---- tiny in-process cache ---------------------------------------------------
const cache = new Map();
function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(producer).catch(err => {
    cache.delete(key);   // never cache failures
    throw err;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

// ---- HTTP --------------------------------------------------------------------
async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'el-GR,el;q=0.9' }
  });
  if (!res.ok) throw new Error(`DEDDIE GET ${res.status}`);
  return res.text();
}

async function post(url, body = '') {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html, */*; q=0.01',
      'Accept-Language': 'el-GR,el;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': PAGE_URL,
      'Content-Length': String(Buffer.byteLength(body))   // 411 without it, even when empty
    },
    body
  });
  if (!res.ok) throw new Error(`DEDDIE POST ${res.status}`);
  return res.text();
}

// ---- HTML helpers ------------------------------------------------------------
function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const stripTags = s => decode(String(s).replace(/<[^>]*>/g, ''));

function parseOptions(html, selectId) {
  const block = html.match(
    new RegExp(`<select[^>]*id="${selectId}"[^>]*>([\\s\\S]*?)</select>`, 'i')
  );
  if (!block) return [];
  const out = [];
  const re = /<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(block[1]))) {
    const name = stripTags(m[2]).trim();
    if (name) out.push({ id: Number(m[1]), name });
  }
  return out;
}

// "9/8/2026 7:45:00 πμ" -> "2026-08-09T07:45:00" (local-naive; the site publishes
// Greek local time and the client renders in the same wall clock).
export function parseGreekDateTime(raw) {
  const m = String(raw).trim().match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([πμΠΜ]{2})?/
  );
  if (!m) return null;
  const [, d, mo, y, hRaw, mi, se, ampm] = m;
  let h = Number(hRaw);
  if (ampm) {
    const pm = ampm.toLowerCase() === 'μμ';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  const p2 = n => String(n).padStart(2, '0');
  return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(se || 0)}`;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/*
 * Two keys per row, and the difference matters for the push diff:
 *
 *   id       — content hash. Changes whenever anything changes. Used to dedupe
 *              the same outage seen through two watched areas.
 *   identity — what the outage *is*, independent of its schedule. A rescheduled
 *              outage keeps its identity but gets a new id, which is how the
 *              cycle tells "changed times" apart from "brand new" and
 *              "cancelled". Note numbers are the natural identity but are often
 *              blank, so fall back to the description with every time-like token
 *              stripped out (Attica rows embed the hours in the prose).
 */
function keysFor(row, prefectureId) {
  const id = hash([row.from, row.to, row.note, row.municipalities.join('|'), row.description.slice(0, 200)].join('~'));
  const identity = row.note
    ? `n:${prefectureId}:${row.note}`
    : 'd:' + hash(row.municipalities.join('|') + '~' + row.description
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')
        .replace(/[πμΠΜ]{2}/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 400));
  return { id, identity };
}

function parseRows(html, prefectureId) {
  const rows = [];
  const rowRe = /<tr class="align-middle">([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = rowRe.exec(html))) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(r[1]))) cells.push(c[1]);
    if (cells.length < 6) continue;

    const fromRaw = stripTags(cells[0]).trim();
    const toRaw = stripTags(cells[1]).trim();
    const municipalities = cells[2]
      .split(/<br\s*\/?>/i)
      .map(s => stripTags(s).trim())
      .filter(Boolean);
    // Descriptions arrive with alignment padding ("Ζυγά      οδός:ΛΕΝΟΡΜΑΝ");
    // collapse space runs but keep the line breaks, which separate streets.
    const description = decode(
      cells[3].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    ).replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    const row = {
      from: parseGreekDateTime(fromRaw),
      to: parseGreekDateTime(toRaw),
      fromRaw,
      toRaw,
      municipalities,
      description,
      note: stripTags(cells[4]).trim(),
      reason: stripTags(cells[5]).trim()
    };
    rows.push({ ...keysFor(row, prefectureId), ...row });
  }
  return rows;
}

function lastPageOf(html) {
  let max = 1;
  const re = /[?&]page=(\d+)/g;
  let m;
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]));
  return Math.min(max, MAX_PAGES);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

// ---- public API --------------------------------------------------------------
export function getPrefectures() {
  return cached('prefectures', TTL_LOOKUP, async () => {
    const html = await get(PAGE_URL);
    const list = parseOptions(html, 'PrefectureID');
    if (!list.length) throw new Error('No prefectures parsed — DEDDIE markup may have changed');
    return list.sort((a, b) => a.name.localeCompare(b.name, 'el'));
  });
}

export function getMunicipalities(prefectureId) {
  return cached(`municipalities:${prefectureId}`, TTL_LOOKUP, async () => {
    const html = await post(FORM_URL, `PrefectureID=${prefectureId}&MunicipalityID=`);
    return parseOptions(html, 'MunicipalityID');
  });
}

export function getOutages(prefectureId, municipalityId, { ttl = TTL_OUTAGES } = {}) {
  const mun = municipalityId || '';
  return cached(`outages:${prefectureId}:${mun}`, ttl, async () => {
    const url = p =>
      `${PARTIAL_URL}?page=${p}&municipalityID=${encodeURIComponent(mun)}&prefectureID=${encodeURIComponent(prefectureId)}`;

    const first = await post(url(1));
    const last = lastPageOf(first);
    const rest = last > 1
      ? await mapLimit(
          Array.from({ length: last - 1 }, (_, i) => i + 2),
          PAGE_CONCURRENCY,
          p => post(url(p))
        )
      : [];

    const seen = new Set();
    const outages = [];
    for (const html of [first, ...rest]) {
      for (const row of parseRows(html, prefectureId)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        outages.push(row);
      }
    }
    outages.sort((a, b) => String(a.from).localeCompare(String(b.from)));
    return { outages, pages: last };
  });
}

// "24" or "24:495" -> { key, prefectureId, municipalityId }
export function parseArea(spec) {
  const [p, m] = String(spec).trim().split(':');
  const prefectureId = Number(p);
  if (!Number.isFinite(prefectureId) || prefectureId <= 0) return null;
  const municipalityId = m ? Number(m) : null;
  const mun = Number.isFinite(municipalityId) && municipalityId > 0 ? municipalityId : null;
  return { key: `${prefectureId}${mun ? ':' + mun : ''}`, prefectureId, municipalityId: mun };
}

export async function nameArea(area) {
  const [prefs, muns] = await Promise.all([
    getPrefectures().catch(() => []),
    area.municipalityId ? getMunicipalities(area.prefectureId).catch(() => []) : Promise.resolve([])
  ]);
  return {
    prefectureName: prefs.find(p => p.id === area.prefectureId)?.name || `#${area.prefectureId}`,
    municipalityName: area.municipalityId
      ? muns.find(m => m.id === area.municipalityId)?.name || `#${area.municipalityId}`
      : null
  };
}

// One entry per requested area; a failing area reports `error` instead of
// sinking the whole response.
export async function collectAreas(specs, opts) {
  const areas = specs.map(parseArea).filter(Boolean);
  return Promise.all(areas.map(async area => {
    const names = await nameArea(area);
    try {
      const { outages, pages } = await getOutages(area.prefectureId, area.municipalityId, opts);
      return { ...area, ...names, pages, outages };
    } catch (err) {
      return { ...area, ...names, error: err.message, outages: [] };
    }
  }));
}
