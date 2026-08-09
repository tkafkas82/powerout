# Power Outages — Διακοπές Ρεύματος (ΔΕΔΔΗΕ)

Watch scheduled power outages for the areas you care about. Pick any number of
prefectures / municipalities, get one merged timeline grouped by day, filter by
street or village name, and get a browser notification before an outage starts.

Data comes from ΔΕΔΔΗΕ's public site: <https://siteapps.deddie.gr/outages2public>.

```
start.bat            # installs deps if needed, opens http://localhost:4950
npm start            # same thing without the browser
```

## Why there is a server

The DEDDIE site has **no JSON API** — it's an ASP.NET MVC page that returns
server-rendered HTML partials, and it sends no CORS headers, so a browser can't
call it directly. `server.js` is a thin proxy that scrapes the HTML into JSON,
caches it, and hosts the static PWA.

## The upstream endpoints

| What | Call |
|---|---|
| Prefecture list | `GET  /outages2public/` → `<select id="PrefectureID">` |
| Municipality list | `POST /Outages2Public/?Length=4` with `PrefectureID=24` → the reply re-renders the form, so `<select id="MunicipalityID">` comes back filled |
| Outages (paged) | `POST /Outages2Public/Home/OutagesPartial?page=1&municipalityID=&prefectureID=24` |

Gotchas baked into the proxy:

- **Every POST needs a `Content-Length`**, even with an empty body — the Incapsula
  edge answers `411 Length Required` otherwise.
- Results are paged 8 rows at a time; the last page number is only discoverable
  from the pager links in the page-1 response. The proxy walks all pages
  (concurrency 4, hard cap 40) and merges them.
- Timestamps are Greek locale strings — `9/8/2026 7:45:00 πμ` (`d/M/yyyy`, `πμ`/`μμ`).
  They're normalised to `2026-08-09T07:45:00`, local-naive, so the browser shows
  the same wall clock DEDDIE published.
- Descriptions are space-padded for column alignment; runs of spaces are collapsed,
  line breaks are kept (they separate streets).

## Local API

| Endpoint | Notes |
|---|---|
| `GET /api/prefectures` | `[{ id, name }]`, cached 12h |
| `GET /api/municipalities?prefecture=24` | `[{ id, name }]`, cached 12h |
| `GET /api/outages?areas=24:495,10` | comma-separated `prefectureID[:municipalityID]`; cached 10 min per area |

`/api/outages` returns one entry per requested area; a failing area comes back
with an `error` field instead of sinking the whole response:

```json
{
  "fetchedAt": "2026-08-09T06:15:02.001Z",
  "areas": [{
    "key": "24:495",
    "prefectureName": "ΙΩΑΝΝΙΝΩΝ",
    "municipalityName": "ΔΗΜΟΣ ΙΩΑΝΝΙΤΩΝ",
    "pages": 1,
    "outages": [{
      "id": "s3r7vz",
      "from": "2026-08-09T07:45:00",
      "to": "2026-08-09T08:45:00",
      "fromRaw": "9/8/2026 7:45:00 πμ",
      "municipalities": ["ΙΩΑΝΝΙΤΩΝ", "ΒΟΡΕΙΩΝ ΤΖΟΥΜΕΡΚΩΝ"],
      "description": "τμήμα Κατσικάς προς …",
      "note": "346",
      "reason": "Συντήρηση"
    }]
  }]
}
```

`id` is a content hash, so the same outage seen through two watched areas
(a prefecture *and* one of its municipalities) is deduped client-side and
labelled with every area it matched.

## Client

- Watched areas, filter text and notification settings live in `localStorage`;
  nothing is stored server-side.
- Auto-refresh every 10 min, plus on tab focus if the data is older than 5 min.
- Status per outage: **ΣΕ ΕΞΕΛΙΞΗ** / `σε 40′` / `σε 3ω` / `σε 2 ημ.` / finished.
- **Notifications fire only while the page is open** — there is no push backend
  and no server-side subscription. Installing the PWA and leaving it open on a
  phone or a pinned tab is what makes them useful.

## Files

```
server.js                 proxy + HTML→JSON parser + cache
public/index.html         UI shell (Greek)
public/app.js             state, rendering, filtering, notifications
public/styles.css         dark theme
public/sw.js              cache-first shell, network-only API
public/icon*.png|svg      PWA icons
```

Port is `4950` (`PORT` env var overrides).
