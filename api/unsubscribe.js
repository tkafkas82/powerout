import { vercel } from '../lib/vercel.js';
import { unsubscribe } from '../lib/handlers.js';
export default vercel(unsubscribe, { methods: ['POST'] });
