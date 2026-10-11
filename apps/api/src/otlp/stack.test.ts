import { describe, expect, it } from "vitest";
import { parseNodeStack } from "./stack.js";

const STACK = `SequelizeDatabaseError: Invalid column name 'coupon_id'.
    at Query.formatError (/app/node_modules/sequelize/lib/dialects/mssql/query.js:415:16)
    at Request.userCallback (/app/node_modules/sequelize/lib/dialects/mssql/query.js:115:25)
    at async createOrder (/app/services/order.service.js:142:5)
    at async checkIn (/app/controllers/order.controller.js:88:20)
    at new Worker (file:///app/lib/worker.mjs:10:3)
    at /app/routes/index.js:12:7
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`;

describe("parseNodeStack", () => {
  const frames = parseNodeStack(STACK, ["/app"]);

  it("returns frames outermost first, innermost (throw site) last", () => {
    expect(frames).toHaveLength(7);
    expect(frames.at(-1)).toMatchObject({ function: "Query.formatError", lineno: 415, colno: 16 });
    expect(frames[0]?.abs_path).toBe("node:internal/process/task_queues");
  });

  it("handles async, constructor, file:// and anonymous frames", () => {
    expect(frames.find((f) => f.function === "createOrder")).toMatchObject({ filename: "services/order.service.js", lineno: 142, in_app: true });
    expect(frames.find((f) => f.function === "new Worker")).toMatchObject({ filename: "lib/worker.mjs", abs_path: "/app/lib/worker.mjs" });
    expect(frames.find((f) => f.filename === "routes/index.js")).toMatchObject({ lineno: 12, colno: 7, in_app: true });
    expect(frames.find((f) => f.filename === "routes/index.js")?.function).toBeUndefined();
  });

  it("marks node_modules and node internals as not in-app, with stable short paths", () => {
    const lib = frames.filter((f) => !f.in_app).map((f) => f.filename);
    expect(lib).toEqual([
      "node:internal/process/task_queues",
      "node_modules/sequelize/lib/dialects/mssql/query.js",
      "node_modules/sequelize/lib/dialects/mssql/query.js",
    ]);
  });

  it("ignores the message line and junk", () => {
    expect(parseNodeStack("Error: boom\nnot a frame\n")).toEqual([]);
  });
});

describe("parseNodeStack — real Node 22 output", () => {
  const frames = parseNodeStack(`Error: boom
    at new Foo (file:///private/tmp/ot/t.mjs:1:34)
    at a (file:///private/tmp/ot/t.mjs:2:33)
    at async file:///private/tmp/ot/t.mjs:3:7
    at JSON.parse (<anonymous>)
    at Object.openSync (node:fs:562:18)
    at listOnTimeout (node:internal/timers:594:17)
    at [eval]:1:19`, ["/private/tmp/ot"]);

  it("parses every frame kind", () => {
    expect(frames).toHaveLength(7);
    expect(frames.at(-1)).toMatchObject({ function: "new Foo", filename: "t.mjs", lineno: 1, colno: 34, in_app: true });
    expect(frames.find((f) => f.function === "JSON.parse")).toMatchObject({ abs_path: "<anonymous>", in_app: false });
    expect(frames.find((f) => f.function === "Object.openSync")).toMatchObject({ abs_path: "node:fs", lineno: 562, in_app: false });
    expect(frames.find((f) => f.filename === "t.mjs" && f.lineno === 3)?.function).toBeUndefined();
  });
});
