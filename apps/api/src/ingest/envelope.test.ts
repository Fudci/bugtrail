import { gzipSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decompress, EnvelopeError, parseEnvelope } from "./envelope.js";

const event = JSON.stringify({ event_id: "9ec79c33ec9942ab8353589fcb2e04dc", message: "hi" });

describe("parseEnvelope", () => {
  it("parses length-prefixed items", () => {
    const att = "line1\nline2";
    const raw = [
      JSON.stringify({ event_id: "9ec79c33ec9942ab8353589fcb2e04dc" }),
      JSON.stringify({ type: "attachment", length: Buffer.byteLength(att) }),
      att,
      JSON.stringify({ type: "event", length: Buffer.byteLength(event) }),
      event,
      "",
    ].join("\n");
    const env = parseEnvelope(Buffer.from(raw));
    expect(env.headers["event_id"]).toBe("9ec79c33ec9942ab8353589fcb2e04dc");
    expect(env.items.map((i) => i.headers.type)).toEqual(["attachment", "event"]);
    expect(env.items[0]!.payload.toString()).toBe(att);
    expect(JSON.parse(env.items[1]!.payload.toString()).message).toBe("hi");
  });

  it("parses newline-terminated items without length, at EOF", () => {
    const raw = `{}\n{"type":"event"}\n${event}`;
    const env = parseEnvelope(Buffer.from(raw));
    expect(env.items).toHaveLength(1);
    expect(env.items[0]!.payload.toString()).toBe(event);
  });

  it("handles empty payload and multibyte length", () => {
    const s = "héllo";
    const raw = `{}\n{"type":"a","length":0}\n\n{"type":"b","length":${Buffer.byteLength(s)}}\n${s}`;
    const env = parseEnvelope(Buffer.from(raw));
    expect(env.items[0]!.payload.length).toBe(0);
    expect(env.items[1]!.payload.toString()).toBe(s);
  });

  it("rejects bad input", () => {
    expect(() => parseEnvelope(Buffer.from("not json\n"))).toThrow(EnvelopeError);
    expect(() => parseEnvelope(Buffer.from('{}\n{"length":1}\nx'))).toThrow(/type/);
    expect(() => parseEnvelope(Buffer.from('{}\n{"type":"e","length":99}\nx'))).toThrow(/exceeds/);
    expect(() => parseEnvelope(Buffer.from('{}\n{"type":"e","length":1}\nxy'))).toThrow(/terminated/);
  });
});

describe("decompress", () => {
  it("handles gzip, deflate, identity", () => {
    const b = Buffer.from("abc");
    expect(decompress(gzipSync(b), "gzip").toString()).toBe("abc");
    expect(decompress(deflateSync(b), "deflate").toString()).toBe("abc");
    expect(decompress(b, undefined).toString()).toBe("abc");
    expect(() => decompress(b, "br")).toThrow(/unsupported/);
    expect(() => decompress(b, "gzip")).toThrow(/invalid/);
  });
});
