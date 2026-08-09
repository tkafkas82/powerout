import { vercel } from '../lib/vercel.js';
import { logout } from '../lib/handlers.js';
export default vercel(logout, { methods: ['POST'] });
