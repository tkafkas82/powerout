# Power Outages — Διακοπές Ρεύματος (ΔΕΔΔΗΕ)

Watch scheduled power outages for the areas you care about. Pick any number of
prefectures / municipalities, get one merged timeline grouped by day, filter by
street or village name, and get a **real Web Push notification** — delivered with
the app closed — when something is announced, moved, cancelled, or about to start.

Data comes from ΔΕΔΔΗΕ's public site: <https://siteapps.deddie.gr/outages2public>.

```
start.bat            # installs deps if needed, opens http://localhost:4950
npm start            # same thing without the browser
npm test             # exercises the push cycle against the live site
```

Push works out of the box locally: on first start the server generates a VAPID
key pair into `data/vapid.json` and keeps subscriptions in `data/store.json`.
Neither is committed — `data/` is gitignored, and `vapid.json` holds a private key.

## Why there is a server

The DEDDIE site has **no JSON API** — it's an ASP.NET MVC page that returns
server-rendered HTML partials, and it sends no CORS headers, so a browser can't
call it directly. The server scrapes that HTML into JSON, caches it, hosts the
PWA, and — the part that matters for alerts — keeps polling on its own schedule
so notifications don't depend on anyone having the page open.

## The upstream endpoints

| What | Call |
|---|---|
| Prefecture list | `GET  /outages2public/` → `<select id="PrefectureID">` |
| Municipality list | `POST /Outages2Public/?Length=4` with `PrefectureID=24` → the reply re-renders the form, so `<select id="MunicipalityID">` comes back filled |
| Outages (paged) | `POST /Outages2Public/Home/OutagesPartial?page=1&municipalityID=&prefectureID=24` |

Gotchas baked into `lib/deddie.js`:

- **Every POST needs a `Content-Length`**, even with an empty body — the Incapsula
  edge answers `411 Length Required` otherwise.
- Results are paged 8 rows at a time; the last page number is only discoverable
  from the pager links in the page-1 response. All pages are walked (concurrency
  4, hard cap 40) and merged.
- Timestamps are Greek locale strings — `9/8/2026 7:45:00 πμ` (`d/M/yyyy`, `πμ`/`μμ`).
  They're normalised to `2026-08-09T07:45:00`, local-naive, so the browser shows
  the same wall clock DEDDIE published. Server-side that stamp is anchored to
  `Europe/Athens` explicitly (`lib/time.js`) — on Vercel the process runs in UTC,
  and a 3-hour error would make every reminder fire late.
- Descriptions are space-padded for column alignment; runs of spaces are collapsed,
  line breaks are kept (they separate streets).

## Two keys per outage

`id` is a content hash — it changes whenever anything changes, and it's what
dedupes the same outage seen through two watched areas.

`identity` is what the outage *is*, independent of its schedule: the note number
when there is one, otherwise a hash of the municipalities plus the description
with every time-like token stripped out. A rescheduled outage keeps its identity
but gets a new id, which is exactly how the push cycle tells **changed times**
apart from **brand new** and **cancelled**.

## What triggers a push

| Kind | When |
|---|---|
| `new` | an outage appears that touches a watched area |
| `changed` | an outage already announced moves its start/end |
| `cancelled` | an announced outage vanishes **while still in the future** — dropping off after it finished is expiry, not cancellation |
| `lead` | a known outage enters the device's lead-time window (1h … 2 days) |

Rules the cycle follows, all covered by `npm test`:

- **First sight of an area is a baseline** — it's recorded silently, so adding an
  area doesn't blast one notification per outage that was already there.
- **Events coalesce**: a device gets one push listing everything, not one per outage.
- **Announced once per device.** The dedupe key carries the schedule, so a
  rescheduled outage legitimately re-alerts with its new times.
- Each subscription carries its **own** areas and lead time; `sent` state lives on
  the subscription record, not globally.

## Signing in with Google (optional)

Without it, watched areas live in `localStorage` — per browser, lost when you
clear site data. Sign in and they're stored against the Google account instead,
so the phone and the laptop share one set.

It's entirely optional: with no `GOOGLE_CLIENT_ID` the server reports no client
id, the client hides the whole account section, and everything works as before.

**Create the OAuth client**

1. [Google Cloud console](https://console.cloud.google.com/) → create (or pick) a project.
2. **APIs & Services → OAuth consent screen** → External → fill in app name and
   your email. While the app is in *Testing*, add yourself under **Test users**;
   nobody else can sign in until you publish.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   *Web application*.
4. Under **Authorised JavaScript origins**, add every origin the page is served
   from — no paths, no trailing slash:
   - `http://localhost:4950`
   - `https://<your-deployment>.vercel.app`

   No redirect URI is needed: this uses the ID-token flow, not a redirect.
5. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`).

**Configure the server**

```
GOOGLE_CLIENT_ID=<client id>     # locally: set it before `npm start`
```

On Vercel add it as an environment variable and redeploy. There is **no client
secret** anywhere — the browser gets a signed ID token, the server verifies it
against Google's public keys (`lib/auth.js`) and mints its own HttpOnly session
cookie. The audience check is what ties a token to this project; a token minted
for some other app is rejected.

Sessions are signed with `SESSION_SECRET` if set, otherwise derived from
`VAPID_PRIVATE_KEY` so a deployment needs no extra variable. Locally a secret is
generated into `data/session.json`.

**What gets stored:** under `po:user:<google-sub>`, the watched areas (ids plus
display names, so a second device can render the chips without refetching every
list), the lead time, and the account's email and name. Nothing else.

**Which copy wins:** an account that already has areas overrides what the browser
had — that's the point of signing in on a second device. A first-ever login has
nothing stored, so the browser's current areas are uploaded rather than wiped.
Signing out leaves the local copy alone.

Push subscriptions made while signed in record the account, and the cycle then
reads that account's *current* areas rather than the snapshot the device
uploaded — so changing areas on the phone moves the laptop's alerts too.

## API

Same handlers serve the local Express app and the Vercel functions (`lib/handlers.js`).

| Endpoint | Notes |
|---|---|
| `GET /api/config` | `{ googleClientId, user, prefs }` — one boot round trip |
| `POST /api/login` | `{ credential }` from Google Identity Services; sets the session cookie |
| `POST /api/logout` | clears the cookie |
| `POST /api/prefs` | `{ areas, leadHours }` for the signed-in account; `401` otherwise |
| `GET /api/prefectures` | `[{ id, name }]`, cached 12h |
| `GET /api/municipalities?prefecture=24` | `[{ id, name }]`, cached 12h |
| `GET /api/outages?areas=24:495,10` | comma-separated `prefectureID[:municipalityID]`; cached 10 min per area |
| `GET /api/vapid-public-key` | `503` when no keys are configured; the client degrades to a plain viewer |
| `POST /api/subscribe` | `{ subscription, areas, leadHours }` — idempotent, carries `sent` forward |
| `POST /api/unsubscribe` | `{ endpoint }` |
| `POST /api/test-push` | `{ endpoint }` — self-targeted, so it needs no secret |
| `POST /api/cron` | poll + diff + push; requires `x-cron-secret` when `CRON_SECRET` is set |

`/api/outages` returns one entry per requested area; a failing area comes back
with an `error` field instead of sinking the whole response.

## Deploying to Vercel (for phone push)

A phone can only subscribe from a secure origin, so `http://<laptop-ip>:4950`
won't do — it needs HTTPS.

1. **Import the repo** in Vercel. `vercel.json` pins `framework: null` and serves
   `public/` plus the `api/` functions — nothing is built. Express is deliberately
   a **devDependency**: listed under `dependencies` it makes Vercel auto-detect the
   repo as an Express app and fail the build hunting for a server entrypoint
   (`No entrypoint found which imports express`). Only `server.js` uses it, and
   `server.js` never runs on Vercel.
2. Attach an **Upstash Redis** integration. `lib/store.js` picks up either
   `UPSTASH_REDIS_REST_URL`/`TOKEN` or `KV_REST_API_URL`/`TOKEN` automatically and
   switches off the file backend — Vercel's filesystem is ephemeral and
   per-instance, so a file store would lose every subscription.
3. Set the environment variables:

   | Variable | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | from `npm run vapid` (or `npx web-push generate-vapid-keys`) |
   | `VAPID_PRIVATE_KEY` | *secret* |
   | `VAPID_CONTACT` | `mailto:you@example.com` |
   | `CRON_SECRET` | any random string |
   | `GOOGLE_CLIENT_ID` | only if you want sign-in — see above |

   Reusing `data/vapid.json` from the laptop keeps existing subscriptions valid;
   a fresh pair invalidates every device and they must re-subscribe.
4. Add repo secrets `CRON_URL` (`https://<deployment>/api/cron`) and `CRON_SECRET`.
   `.github/workflows/cron.yml` then drives the cycle every 30 minutes — Vercel's
   own cron is once-a-day on the free plan, which is useless for lead reminders.

Locally none of this is needed: the scheduler in `server.js` runs the same cycle
every `CYCLE_MINUTES` (default 20).

## Files

```
lib/deddie.js      scrape + parse + cache; id/identity keys
lib/time.js        Europe/Athens anchoring for the naive timestamps
lib/store.js       subscriptions + snapshots: Upstash Redis or a JSON file
lib/push.js        web-push transport, VAPID keys, prune-on-410
lib/cycle.js       poll -> diff -> per-device events -> push
lib/auth.js        Google ID-token verification + cookie sessions
lib/handlers.js    framework-free request handlers
lib/vercel.js      Vercel adapter (kept out of api/, which holds only functions)
server.js          Express adapter + the local scheduler
api/*.js           one file per endpoint, each a 3-line wrapper
public/            the PWA (index.html, app.js, styles.css, sw.js, icons)
test/cycle.test.js end-to-end: real encryption + VAPID, stand-in push service
test/auth.test.js  session integrity, token rejection, preference round trip
```

Port is `4950` (`PORT` env var overrides).
