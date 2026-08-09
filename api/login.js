// Exchanges a Google ID token for our own session cookie.
import { vercel } from '../lib/vercel.js';
import { login } from '../lib/handlers.js';
export default vercel(login, { methods: ['POST'] });
