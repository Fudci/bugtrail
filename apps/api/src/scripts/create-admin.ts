import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { createPrisma } from "@bugtool/db";
import { hashPassword } from "../auth/password.js";

// Buat / update admin global. Password diminta lewat prompt (tidak tampil, tidak masuk shell history).
// Non-interaktif (CI/Docker): set ADMIN_EMAIL dan ADMIN_PASSWORD di environment.
let muted = false;
const out = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});
const rl = createInterface({ input: process.stdin, output: out, terminal: true });

const email = (process.env["ADMIN_EMAIL"] ?? (await rl.question("Admin email: "))).trim().toLowerCase();
let password = process.env["ADMIN_PASSWORD"];
if (!password) {
  process.stdout.write("Password (min. 10 characters): ");
  muted = true;
  password = await rl.question("");
  muted = false;
  process.stdout.write("\n");
}
rl.close();

if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("invalid email");
if (password.length < 10) throw new Error("password must be at least 10 characters");

const prisma = createPrisma();
const passwordHash = await hashPassword(password);
const user = await prisma.user.upsert({
  where: { email },
  update: { passwordHash, isAdmin: true },
  create: { email, passwordHash, isAdmin: true },
});
console.log(`Admin ready: ${user.email}`);
await prisma.$disconnect();
