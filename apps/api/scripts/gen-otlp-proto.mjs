// Ubah file .proto (apps/api/proto) menjadi deskriptor JSON yang ikut di-bundle esbuild,
// supaya server tidak perlu membaca file .proto saat runtime (image Docker hanya berisi server.js).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const here = dirname(fileURLToPath(import.meta.url));
const protoDir = join(here, "../proto");
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => join(protoDir, target);
await root.load(["opentelemetry/proto/collector/trace/v1/trace_service.proto", "opentelemetry/proto/collector/logs/v1/logs_service.proto", "google/rpc/status.proto"], { keepCase: false });
root.resolveAll();
const out = join(here, "../src/otlp/otlp-proto.json");
writeFileSync(out, JSON.stringify(root.toJSON({ keepComments: false })) + "\n");
console.log(`wrote ${out}`);
