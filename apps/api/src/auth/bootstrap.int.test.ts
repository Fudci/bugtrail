import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma } from "@bugtool/db";
import { ensureFirstAdmin } from "./bootstrap.js";
import { verifyPassword } from "./password.js";

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (run via `pnpm test:int`)");
const prisma = createPrisma(url);

beforeEach(async () => {
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
});
afterAll(() => prisma.$disconnect());

describe("ensureFirstAdmin", () => {
  it("creates an admin on an empty database", async () => {
    const r = await ensureFirstAdmin(prisma, { ADMIN_EMAIL: " Root@X.io ", ADMIN_PASSWORD: "password-123" });
    expect(r).toBe("created");
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "root@x.io" } });
    expect(u.isAdmin).toBe(true);
    expect(await verifyPassword("password-123", u.passwordHash!)).toBe(true);
  });

  it("does nothing once a user exists (no password overwrite)", async () => {
    await ensureFirstAdmin(prisma, { ADMIN_EMAIL: "root@x.io", ADMIN_PASSWORD: "password-123" });
    const r = await ensureFirstAdmin(prisma, { ADMIN_EMAIL: "root@x.io", ADMIN_PASSWORD: "other-password-456" });
    expect(r).toBe("skipped-has-users");
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "root@x.io" } });
    expect(await verifyPassword("password-123", u.passwordHash!)).toBe(true);
  });

  it("skips without env, rejects weak input", async () => {
    expect(await ensureFirstAdmin(prisma, { ADMIN_EMAIL: "", ADMIN_PASSWORD: "" })).toBe("skipped-no-env");
    await expect(ensureFirstAdmin(prisma, { ADMIN_EMAIL: "a@b.io", ADMIN_PASSWORD: "short" })).rejects.toThrow();
    await expect(ensureFirstAdmin(prisma, { ADMIN_EMAIL: "nope", ADMIN_PASSWORD: "password-123" })).rejects.toThrow();
    expect(await prisma.user.count()).toBe(0);
  });
});
