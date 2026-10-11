<p align="center">
  <img src="brand/wordmark.png" alt="BugTrail" width="360" />
</p>

<p align="center">
  Self-hosted, Sentry-compatible error tracking. One container and SQLite by default, ClickHouse when you need it. MIT licensed.
</p>

---

BugTrail receives errors from the official Sentry SDKs, groups them into issues and shows you the full trail
(stacktrace, breadcrumbs, device context, affected users) in a fast dashboard. Point your existing `Sentry.init({ dsn })`
at BugTrail; no SDK changes needed.

> **Status:** early, in active development. APIs and the data format may still change.

## Features

- **Sentry SDK compatible:** envelope ingest endpoint for the official Sentry SDKs (React Native, Node.js, React, Flutter). Tested so far with `@sentry/node` and `sentry-cli`.
- **Issue grouping** by in-app stack frames, applied after source maps so issues stay stable across releases; SDK `fingerprint` supported.
- **Source maps** via `sentry-cli` (debug IDs), resolved at ingest.
- **OpenTelemetry:** OTLP over HTTP (protobuf/JSON) and gRPC for traces and logs; span exceptions become issues, with a Jaeger-style trace view.
- **API Health:** requests, 5xx rate and latency per endpoint, with alerts and a per-request list.
- **Services:** a service map with calls between services and external dependencies, per-service charts and endpoints.
- **Traces and logs search:** find traces by service, endpoint, status and duration; search logs by service, level and text, linked to their trace and issue.
- **Lite or Scale:** one container with SQLite by default, or add ClickHouse (`--profile scale`) to keep every trace and log.
- **Quotas** per project for events, spans and logs (429 + `Retry-After`), with a usage chart; a fair ingest queue so one busy project can't starve the others.
- **Overview** per project: events, new issues and users vs the previous period, charts, top issues, platforms; filter by range, release, environment, level and platform.
- **Issue detail:** stacktrace, breadcrumbs, device/OS/network/battery context, app permissions, affected users, event history.
- **Workflow:** resolve / ignore, regressions, assign to teammates, bulk delete, CSV export.
- **Alerts** to Discord on new issues, regressions, error spikes, ongoing errors (a summary per issue every minute while it keeps happening), and API rules (status codes such as 5xx or 403 as a share or count, p50/p95/p99 latency, per endpoint).
- **Teams:** projects with admin / member / viewer roles; invite by link (no email server), invitees pick their own username and password.
- **Accounts:** sign in with username or email; admins create one-time password reset links.
- **Retention** per project (max events and max age) with automatic cleanup.
- **Crash-safe ingest:** events are queued on disk before the SDK gets its `200`.
- Light and dark mode.

## Quick start (Docker)

```bash
git clone https://github.com/Fudci/bugtrail.git
cd bugtrail
PUBLIC_URL=http://localhost:4000 \
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='choose-a-long-password' \
docker compose up -d --build
```

Open `http://localhost:4000`, sign in, create a project and copy its DSN into your app:

```js
import * as Sentry from "@sentry/react-native";

Sentry.init({
  dsn: process.env.SENTRY_DSN, // the DSN shown in BugTrail project settings
});
```

`ADMIN_EMAIL` / `ADMIN_PASSWORD` only create the first admin on an empty database and are ignored afterwards.
Keep secrets in your server environment or an `.env` file next to `docker-compose.yml`, never in git.

### Scale mode (ClickHouse)

Lite keeps traces that contain an error plus a sample of slow ones. To keep **every** trace and log, add ClickHouse:

```bash
TELEMETRY_STORE=clickhouse \
CLICKHOUSE_PASSWORD='choose-a-long-password' \
docker compose --profile scale up -d --build
```

| | Lite (default) | Scale |
|---|---|---|
| Containers | 1 (BugTrail, `mem_limit` 384 MB) | 2 (+ ClickHouse, `CLICKHOUSE_MEM_LIMIT` default 4 GB) |
| Issues, events, users, API Health | SQLite | SQLite |
| OpenTelemetry traces | Error traces and sampled slow traces | Every trace |
| OpenTelemetry logs | SQLite, kept 3 days | ClickHouse, project retention |

Switching modes doesn't move data: traces start fresh in the new store. Details: [Lite or Scale mode](docs/self-hosting.md#lite-or-scale-mode).

### Ports

| Port | What |
|---|---|
| 4000 (`BUGTOOL_PORT`) | Dashboard, Sentry envelope ingest, OTLP/HTTP on `/otlp` |
| 4317 (`BUGTOOL_OTLP_GRPC_PORT`) | OTLP/gRPC, plain gRPC without TLS (put a HTTP/2 proxy in front for the internet) |

## Send OpenTelemetry data

Backends already using OpenTelemetry need no Sentry SDK. Take the key from
**Settings → Connect your app → OpenTelemetry** and set the standard exporter variables:

```bash
# OTLP/HTTP
OTEL_EXPORTER_OTLP_ENDPOINT=https://bugtrail.example.com/otlp   # the SDK appends /v1/traces and /v1/logs
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf                       # or http/json
OTEL_EXPORTER_OTLP_HEADERS=x-bugtrail-key=<project key>
OTEL_SERVICE_NAME=my-api

# or OTLP/gRPC
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_EXPORTER_OTLP_ENDPOINT=http://<server>:4317
```

Span exceptions become issues; every server request feeds API Health and the Services map.
BugTrail can be an extra destination next to SigNoz, Grafana or Jaeger, see [OpenTelemetry](docs/self-hosting.md#opentelemetry-backends).

## Documentation

The [self-hosting guide](docs/self-hosting.md) covers:

- [Requirements](docs/self-hosting.md#requirements) and [install](docs/self-hosting.md#install), [inviting your team](docs/self-hosting.md#invite-your-team)
- [Configuration](docs/self-hosting.md#configuration) (all environment variables) and [HTTPS](docs/self-hosting.md#https)
- [OpenTelemetry](docs/self-hosting.md#opentelemetry-backends), [OTLP over gRPC](docs/self-hosting.md#otlp-over-grpc), [Lite or Scale](docs/self-hosting.md#lite-or-scale-mode)
- [Source maps](docs/self-hosting.md#source-maps), [Alerts](docs/self-hosting.md#alerts), [API Health](docs/self-hosting.md#api-health), [Services](docs/self-hosting.md#services), [Traces](docs/self-hosting.md#traces), [Logs](docs/self-hosting.md#logs)
- [Quotas](docs/self-hosting.md#quotas-and-fair-processing), [Data retention](docs/self-hosting.md#data-retention), [Backups](docs/self-hosting.md#backups), [Updating](docs/self-hosting.md#updating)
- [Reliability](docs/self-hosting.md#reliability) and [Limitations](docs/self-hosting.md#limitations)

## Development

Requires Node.js 22 and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm db:generate
pnpm dev:api        # API on :4000
pnpm dev:web        # dashboard on :5173
```

```bash
pnpm typecheck
pnpm test           # unit tests
pnpm test:int       # integration tests (temporary SQLite database)
```

### Repository layout

```
apps/api        Fastify API: Sentry and OTLP (HTTP/gRPC) ingest, processing, dashboard API, source maps
apps/web        React + Vite dashboard
packages/db     Prisma schema, SQL migrations, SQLite helpers
bench/          k6 load-test scripts
brand/          logo and icon sources
docs/           self-hosting guide
```

## License

[MIT](LICENSE)
