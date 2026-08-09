import { vercel } from './_adapter.js';
import { unsubscribe } from '../lib/handlers.js';
export default vercel(unsubscribe, { methods: ['POST'] });
