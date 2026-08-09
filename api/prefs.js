// Watched areas for the signed-in account.
import { vercel } from '../lib/vercel.js';
import { savePrefs } from '../lib/handlers.js';
export default vercel(savePrefs, { methods: ['POST'] });
