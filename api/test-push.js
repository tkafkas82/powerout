import { vercel } from '../lib/vercel.js';
import { testPush } from '../lib/handlers.js';
export default vercel(testPush, { methods: ['POST'] });
