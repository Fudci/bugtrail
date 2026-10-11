import type { PrismaClient } from "@bugtool/db";

// Username: dipakai untuk login (bersama email opsional). Huruf kecil, angka, ".", "_", "-"; 3-32 karakter.
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
export const USERNAME_HINT = "3-32 characters: lowercase letters, numbers, . _ - (not at the start or end)";

/** Username yang belum dipakai dari bagian email sebelum "@" (akun admin dari email), mis. "andi", "andi-2". */
export async function usernameFromEmail(prisma: PrismaClient, email: string) {
  const base = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[._-]+|[._-]+$/g, "").slice(0, 28) || "user";
  const padded = base.length < 3 ? `${base}user`.slice(0, 28) : base;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? padded : `${padded}-${n}`;
    if (!(await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } }))) return candidate;
  }
}

/** Nama tampilan: name, lalu username. */
export const displayName = (u: { name: string | null; username: string }) => u.name || u.username;
