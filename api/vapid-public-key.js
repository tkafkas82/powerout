import { vercel } from './_adapter.js';
import { vapidPublicKey } from '../lib/handlers.js';
export default vercel(vapidPublicKey);
