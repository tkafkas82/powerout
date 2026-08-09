import { vercel } from '../lib/vercel.js';
import { outages } from '../lib/handlers.js';
export default vercel(outages);
