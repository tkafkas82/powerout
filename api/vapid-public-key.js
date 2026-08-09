import { vercel } from '../lib/vercel.js';
import { vapidPublicKey } from '../lib/handlers.js';
export default vercel(vapidPublicKey);
