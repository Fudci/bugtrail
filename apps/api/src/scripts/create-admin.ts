import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { createPrisma } from "@bugtool/db";
import { hashPassword } from "../auth/password.js";
import { USERNAME_HINT, USERNAME_RE, usernameFromEmail } from "../auth/users.js";

// Buat / update admin global. Password diminta lewat prompt (tidak tampil, tidak masuk shell history).
// Non-interaktif (CI/Docker): set ADMIN_EMAIL (email atau username) dan ADMIN_PASSWORD di environment.
// Juga dipakai untuk reset password akun yang sudah ada (cari lewat email atau username).
let muted = false;
const out = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});
const rl = createInterface({ input: process.stdin, output: out, terminal: true });

const login = (process.env["ADMIN_EMAIL"] ?? (await rl.question("Admin email or username: "))).trim().toLowerCase();
let password = process.env["ADMIN_PASSWORD"];
if (!password) {
  process.stdout.write("Password (min. 10 characters): ");
  muted = true;
  password = await rl.question("");
  muted = false;
  process.stdout.write("\n");
}
rl.close();

const isEmail = login.includes("@");
if (isEmail ? !/^[^@\s]+@[^@\s]+$/.test(login) : !USERNAME_RE.test(login)) throw new Error(isEmail ? "invalid email" : `invalid username (${USERNAME_HINT})`);
if (password.length < 10) throw new Error("password must be at least 10 characters");

const prisma = createPrisma();
const passwordHash = await hashPassword(password);
const where = isEmail ? { email: login } : { username: login };
const user = await prisma.user.upsert({
  where,
  update: { passwordHash, isAdmin: true },
  create: isEmail
    ? { username: await usernameFromEmail(prisma, login), email: login, passwordHash, isAdmin: true }
    : { username: login, passwordHash, isAdmin: true },
});
console.log(`Admin ready: ${user.username}${user.email ? ` (${user.email})` : ""}`);
await prisma.$disconnect();
