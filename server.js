/*
 * Local server: hosts the PWA, exposes the same API as the Vercel deployment,
 * and runs the push cycle on a timer.
 *
 * All the logic lives in lib/ — this file only adapts it to Express and owns the
 * scheduler, which is the one thing Vercel does differently (a GitHub Actions
 * cron hits /api/cron there).
 *
 * Push from here reaches a device even with the tab closed: the notification
 * travels through the browser vendor's push service, so only *this process*
 * needs to stay running, not the page.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as h from './lib/handlers.js';
import { HttpError } from './lib/handlers.js';
import { backend } from './lib/store.js';
import { getVapid } from './lib/push.js';
import { runCycle } from './lib/cycle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4950;
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES) || 20;

app.use(express.json({ limit: '64kb' }));

// Adapt a lib/handlers function to Express.
const route = handler => async (req, res) => {
  try {
    const { status, json, cookies } = await handler({ query: req.query, body: req.body, headers: req.headers });
    if (cookies?.length) res.append('Set-Cookie', cookies);
    res.set('Cache-Control', 'no-store').status(status).json(json);
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 502).json({ error: err.message });
  }
};

app.get('/api/config', route(h.config));
app.post('/api/login', route(h.login));
app.post('/api/logout', route(h.logout));
app.post('/api/prefs', route(h.savePrefs));
app.get('/api/prefectures', route(h.prefectures));
app.get('/api/municipalities', route(h.municipalities));
app.get('/api/outages', route(h.outages));
app.get('/api/vapid-public-key', route(h.vapidPublicKey));
app.post('/api/subscribe', route(h.subscribe));
app.post('/api/unsubscribe', route(h.unsubscribe));
app.post('/api/test-push', route(h.testPush));
app.post('/api/cron', route(h.cron));
app.get('/api/cron', route(h.cron));     // convenient to poke from a browser locally

app.use(express.static(path.join(HERE, 'public'), { extensions: ['html'] }));

app.listen(PORT, async () => {
  console.log(`Power Outages running on http://localhost:${PORT}`);
  console.log(`Store: ${backend}`);

  try {
    const vapid = await getVapid();
    console.log(`Push: ready (VAPID from ${vapid.source})`);
  } catch (err) {
    console.log(`Push: disabled — ${err.message}`);
  }

  // The scheduler is what makes push real: it keeps checking DEDDIE whether or
  // not anyone has the page open. Kick off shortly after boot, then every
  // CYCLE_MINUTES.
  const tick = async () => {
    try {
      const result = await runCycle({ ttl: 0 });
      if (result.events) console.log(`[cycle] ${new Date().toLocaleTimeString('el-GR')}`, result);
    } catch (err) {
      console.error('[cycle] failed:', err.message);
    }
  };
  setTimeout(tick, 15000).unref?.();
  setInterval(tick, CYCLE_MINUTES * 60000);
});
