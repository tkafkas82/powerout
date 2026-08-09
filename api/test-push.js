import { vercel } from './_adapter.js';
import { testPush } from '../lib/handlers.js';
export default vercel(testPush, { methods: ['POST'] });
