import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { flattenSpans } from "./convert.js";
import { sampleRequest, toProtobuf } from "./fixtures.js";
import descriptor from "./otlp-proto.json" with { type: "json" };
import { decodeTraceRequest, encodeStatus, encodeSuccess } from "./protobuf.js";

const root = protobuf.Root.fromJSON(descriptor);

describe("OTLP protobuf", () => {
  it("decodes to the same spans as the equivalent OTLP/JSON", () => {
    const json = sampleRequest();
    const fromProto = flattenSpans(decodeTraceRequest(toProtobuf(json)));
    expect(fromProto).toEqual(flattenSpans(json));
    expect(fromProto[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", durationUs: 612400, statusCode: 2 });
    expect(fromProto[0]?.events[0]?.attributes["exception.type"]).toBe("SequelizeDatabaseError");
    expect(fromProto[0]?.resource["process.command_args"]).toEqual(["/usr/local/bin/node", "/app/app.js"]);
  });

  it("encodes an empty success response and a google.rpc.Status error", () => {
    expect(encodeSuccess()).toHaveLength(0);
    const Status = root.lookupType("google.rpc.Status");
    expect(Status.toObject(Status.decode(encodeStatus(8, "span queue full")))).toEqual({ code: 8, message: "span queue full" });
  });

  it("throws on garbage input", () => {
    expect(() => decodeTraceRequest(Buffer.from("this is not protobuf at all"))).toThrow();
  });
});
