import { vercel } from '../lib/vercel.js';
import { subscribe } from '../lib/handlers.js';
export default vercel(subscribe, { methods: ['POST'] });
