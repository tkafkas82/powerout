// Poll + diff + push. Driven by .github/workflows/cron.yml; protect it with
// CRON_SECRET so a public deployment isn't free to spin on demand.
import { vercel } from '../lib/vercel.js';
import { cron } from '../lib/handlers.js';
export default vercel(cron, { methods: ['GET', 'POST'] });
