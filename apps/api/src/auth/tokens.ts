import { createHash, randomBytes } from "node:crypto";

// Token acak untuk cookie sesi / link undangan. Yang disimpan di DB hanya sha256-nya,
// jadi bocornya isi DB tidak langsung memberi akses.
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
