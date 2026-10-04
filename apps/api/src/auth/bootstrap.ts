import type { PrismaClient } from "@bugtool/db";
import { hashPassword } from "./password.js";

export type BootstrapResult = "created" | "skipped-has-users" | "skipped-no-env";

// Create the first global admin from ADMIN_EMAIL / ADMIN_PASSWORD, but only on an empty database:
// once any user exists the env vars are ignored, so a restart never overwrites a changed password.
export async function ensureFirstAdmin(
  prisma: PrismaClient,
  env: { ADMIN_EMAIL?: string; ADMIN_PASSWORD?: string },
): Promise<BootstrapResult> {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) return "skipped-no-env";
  if ((await prisma.user.count()) > 0) return "skipped-has-users";

  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("ADMIN_EMAIL is not a valid email");
  if (password.length < 10) throw new Error("ADMIN_PASSWORD must be at least 10 characters");

  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), isAdmin: true } });
  return "created";
}
