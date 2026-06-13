/** Bootstrap the first admin: npm run create-admin -- admin@acme.com "Ada Admin" "a-strong-password" */
import { query, pool } from "../src/db.js";
import { hashPassword } from "../src/lib/auth.js";

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password || password.length < 10) {
  console.error('Usage: npm run create-admin -- <email> <name> <password (10+ chars)>');
  process.exit(1);
}
const [user] = await query(
  `INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)
   ON CONFLICT (email) DO UPDATE SET password_hash = $3 RETURNING id`,
  [email.toLowerCase(), name, hashPassword(password)]);
await query(
  `INSERT INTO user_roles (user_id, role_id)
   SELECT $1, id FROM roles WHERE code = 'admin' ON CONFLICT DO NOTHING`, [user.id]);
console.log(`Admin ready: ${email}`);
await pool.end();
