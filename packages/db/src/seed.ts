import { randomBytes } from "node:crypto";
import { createPrisma } from "./index.js";

// Idempoten: membuat org/project "demo" + satu DSN key kalau belum ada, lalu mencetak DSN.
const prisma = createPrisma();
const host = process.env["PUBLIC_HOST"] ?? `localhost:${process.env["API_PORT"] ?? 4000}`;

const org = await prisma.organization.upsert({
  where: { slug: "demo" },
  update: {},
  create: { name: "Demo", slug: "demo" },
});
const project = await prisma.project.upsert({
  where: { organizationId_slug: { organizationId: org.id, slug: "demo" } },
  update: {},
  create: {
    organizationId: org.id, name: "Demo", slug: "demo", platform: "javascript",
    publicId: ((await prisma.project.aggregate({ _max: { publicId: true } }))._max.publicId ?? 0) + 1,
  },
});
const key =
  (await prisma.dsnKey.findFirst({ where: { projectId: project.id, revokedAt: null } })) ??
  (await prisma.dsnKey.create({ data: { projectId: project.id, publicKey: randomBytes(16).toString("hex") } }));

console.log(`DSN: http://${key.publicKey}@${host}/${project.publicId}`);
await prisma.$disconnect();
