import { vercel } from './_adapter.js';
import { outages } from '../lib/handlers.js';
export default vercel(outages);
