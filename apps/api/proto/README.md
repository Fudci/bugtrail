# Vendored protobuf definitions

Used to decode OTLP traces and logs (OTLP/HTTP `application/x-protobuf` and OTLP/gRPC, `src/otlp/protobuf.ts`).

- `opentelemetry/` from [open-telemetry/opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) **v1.11.1** (Apache-2.0)
- `google/rpc/status.proto` from [googleapis/googleapis](https://github.com/googleapis/googleapis) (Apache-2.0), for error responses

After updating these files, regenerate the bundled descriptor:

```bash
node apps/api/scripts/gen-otlp-proto.mjs
```
