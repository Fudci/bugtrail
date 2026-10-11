import { z } from "zod";

// Paging bernomor untuk tabel request/trace: page mulai 1, size 25|50|100 (default 50).
export const pageQuery = {
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  size: z.enum(["25", "50", "100"]).default("50").transform(Number),
};

/** Pesan 400 kalau (page-1)*size melewati MAX_PAGE_OFFSET. */
export const OLD_PAGE_MESSAGE = "Narrow the time range or filters to see older results";
