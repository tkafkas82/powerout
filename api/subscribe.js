import { vercel } from './_adapter.js';
import { subscribe } from '../lib/handlers.js';
export default vercel(subscribe, { methods: ['POST'] });
