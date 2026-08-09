// Vercel adapter: same lib/handlers functions the local Express server uses.
import { HttpError } from './handlers.js';

export function vercel(handler, { methods = ['GET'] } = {}) {
  return async (req, res) => {
    if (!methods.includes(req.method)) {
      return res.status(405).json({ error: `${methods.join('/')} only` });
    }
    try {
      const { status, json } = await handler({
        query: req.query || {},
        // Vercel parses JSON bodies for us, but a string slips through when the
        // content-type is missing (some service workers and curl one-liners).
        body: typeof req.body === 'string' ? safeParse(req.body) : (req.body || {}),
        headers: req.headers || {}
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).json(json);
    } catch (err) {
      res.status(err instanceof HttpError ? err.status : 502).json({ error: err.message });
    }
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
