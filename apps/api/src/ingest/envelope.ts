import { gunzipSync, inflateSync } from "node:zlib";

export const MAX_EVENT_BYTES = 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 20 * 1024 * 1024;

export interface EnvelopeItem {
  headers: Record<string, unknown> & { type: string };
  payload: Buffer;
}

export interface Envelope {
  headers: Record<string, unknown>;
  items: EnvelopeItem[];
}

export class EnvelopeError extends Error {}

const NL = 0x0a;

export function decompress(body: Buffer, encoding: string | undefined): Buffer {
  const enc = encoding?.trim().toLowerCase();
  if (!enc || enc === "identity") return body;
  const opts = { maxOutputLength: MAX_ENVELOPE_BYTES };
  try {
    if (enc === "gzip") return gunzipSync(body, opts);
    if (enc === "deflate") return inflateSync(body, opts);
  } catch {
    throw new EnvelopeError(`invalid ${enc} body`);
  }
  throw new EnvelopeError(`unsupported content-encoding: ${enc}`);
}

function readLine(buf: Buffer, start: number): [line: Buffer, next: number] {
  const end = buf.indexOf(NL, start);
  if (end === -1) return [buf.subarray(start), buf.length];
  return [buf.subarray(start, end), end + 1];
}

function parseHeader(line: Buffer, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    throw new EnvelopeError(`invalid ${what} header`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeError(`${what} header must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseEnvelope(buf: Buffer): Envelope {
  const [headerLine, afterHeader] = readLine(buf, 0);
  const headers = parseHeader(headerLine, "envelope");
  const items: EnvelopeItem[] = [];

  let pos = afterHeader;
  while (pos < buf.length) {
    const [line, afterItemHeader] = readLine(buf, pos);
    // Baris kosong di sela item (mis. trailing newline) dilewati.
    if (line.length === 0) {
      pos = afterItemHeader;
      continue;
    }
    const itemHeaders = parseHeader(line, "item");
    if (typeof itemHeaders["type"] !== "string") throw new EnvelopeError("item header missing type");

    let payload: Buffer;
    const length = itemHeaders["length"];
    if (length !== undefined) {
      if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
        throw new EnvelopeError("invalid item length");
      }
      const end = afterItemHeader + length;
      if (end > buf.length) throw new EnvelopeError("item length exceeds envelope");
      payload = buf.subarray(afterItemHeader, end);
      pos = end;
      // Payload ber-length harus diakhiri \n atau EOF.
      if (pos < buf.length) {
        if (buf[pos] !== NL) throw new EnvelopeError("item payload not terminated by newline");
        pos += 1;
      }
    } else {
      [payload, pos] = readLine(buf, afterItemHeader);
    }

    items.push({ headers: itemHeaders as EnvelopeItem["headers"], payload });
  }

  return { headers, items };
}
