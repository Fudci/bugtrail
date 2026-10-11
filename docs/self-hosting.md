# Self-hosting BugTrail

BugTrail runs as **one container**: the API, the event processor and the dashboard. Data lives in a single
SQLite file (`/data/bugtool.db`) on the Docker volume `bugtool-data`. There is no separate database, queue
or cache to run.

- [Requirements](#requirements)
- [Install](#install)
- [Invite your team](#invite-your-team)
- [Connect your app](#connect-your-app)
- [OpenTelemetry (backends)](#opentelemetry-backends)
- [Lite or Scale mode](#lite-or-scale-mode)
- [Configuration](#configuration)
- [HTTPS](#https)
- [Source maps](#source-maps)
- [Alerts](#alerts)
- [API Health](#api-health)
- [Services](#services)
- [Traces](#traces)
- [Logs](#logs)
- [Quotas and fair processing](#quotas-and-fair-processing)
- [Data retention](#data-retention)
- [Backups](#backups)
- [Updating](#updating)
- [Reliability](#reliability)
- [Limitations](#limitations)

## Requirements

- Docker with Docker Compose.
- **Lite mode (default):** about **400 MB RAM** for the container (the compose file sets `mem_limit: 384m`) and disk for your events.
- **Scale mode (optional, with ClickHouse):** see [Lite or Scale mode](#lite-or-scale-mode) for sizing.
- A domain with HTTPS for production. The Sentry SDKs in your apps must be able to reach it.

## Install

```bash
git clone https://github.com/Fudci/bugtrail.git
cd bugtrail

PUBLIC_URL=https://bugtrail.example.com \
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='choose-a-long-password' \
docker compose up -d --build
```

Then open `PUBLIC_URL` and sign in with the admin account.

- `ADMIN_EMAIL` and `ADMIN_PASSWORD` create the first admin **only when the database has no users**. On later
  starts they are ignored, so a restart never overwrites a password you changed. The password needs at least 10 characters.
- Prefer not to put the password in an environment variable? Leave them out and create the admin interactively
  (the password is prompted and not echoed):

  ```bash
  docker compose exec bugtool node create-admin.js
  ```

Running `create-admin.js` again for an existing email or username resets that user's password.
The first admin signs in with the part of the email before `@` as username (e.g. `you`), or with the email.

### Invite your team

No email server is needed. In **Settings → Members → Invite**, pick a role (viewer, member or admin) and, optionally,
an email, then **Create invite link** and send the link yourself (WhatsApp, Slack, …).

- The person opening the link chooses a **username** (3–32 characters: lowercase letters, numbers, `.` `_` `-`) and a
  **password** (at least 10 characters); name and email are optional. They sign in with the username (or the email).
- Someone who is already signed in just clicks **Join project** with their current account.
- An invite with an email can only be accepted by that email; if the email already has an account, they sign in first.
- Links **work once**, expire after 7 days and can be revoked from the members list. Anyone holding a link can use it,
  so send admin invites privately.
- **Forgotten password:** in the members list, a project admin clicks the key icon next to the person and sends them the
  **password reset link**. They choose a new password and are signed in; their other signed-in devices are signed out.
  The link works once and expires after 24 hours; a new link cancels the previous one.
  A project admin can only reset accounts that are not global admins and whose projects they all manage; a global admin
  can reset anyone. Your own password, or a locked-out admin: `docker compose exec bugtool node create-admin.js` with
  the username or email (this also makes the account a global admin).

## Connect your app

1. In BugTrail, create a project and pick your platform.
2. Copy the **DSN** shown on the project's **Settings** page.
3. Use it in the official Sentry SDK. No BugTrail-specific SDK is needed:

   ```js
   import * as Sentry from "@sentry/react-native";

   Sentry.init({
     dsn: process.env.SENTRY_DSN, // keep the DSN in your app's environment config
     release: "my-app@1.4.2",     // optional, enables the Releases page and release filters
     environment: "production",   // optional, enables the environment filter
   });
   ```

BugTrail stores **error events**. Performance transactions, sessions and attachments sent by the SDK are
accepted but discarded.

## OpenTelemetry (backends)

Backends that already use OpenTelemetry don't need the Sentry SDK. Add BugTrail as an extra OTLP
destination (HTTP or gRPC); your existing exporter to SigNoz, Grafana or Jaeger can stay as it is.

- **Exceptions** recorded on spans (`span.recordException(err)`, or by auto-instrumentation) become BugTrail
  issues, with grouping, alerts and assignment like any other error. The same error recorded on several spans
  of one trace counts once.
- **Traces that contain an error** are kept and shown in the issue's **Trace** tab (timeline, span attributes,
  exception events). Traces without errors are not stored in Lite mode (see [What gets stored](#what-gets-stored)).
- **Logs** sent with the OTLP logs exporter show up on the **Logs** page. Logs that carry a trace ID are also
  shown on that trace and on the issue whose event has the same trace ID (see [Logs](#logs)).
- **Every server request** is counted for [API Health](#api-health) and the [Services](#services) map, also in Lite mode.

Find the endpoint and key in **Settings → Connect your app → OpenTelemetry**. With environment variables:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://bugtrail.example.com/otlp   # the SDK appends /v1/traces and /v1/logs
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf                       # or http/json; both work (gRPC: see below)
OTEL_EXPORTER_OTLP_HEADERS=x-bugtrail-key=<project key>          # keep it in your secrets
OTEL_SERVICE_NAME=my-api
```

Or, to send to BugTrail **in addition** to an existing destination (Node.js):

```js
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

const toBugTrail = new BatchSpanProcessor(new OTLPTraceExporter({
  url: `${process.env.BUGTRAIL_OTLP_ENDPOINT}/v1/traces`,
  headers: { "x-bugtrail-key": process.env.BUGTRAIL_KEY },
}));
// new NodeSDK({ spanProcessors: [toYourCurrentBackend, toBugTrail], ... })
```

Notes:

- **OTLP/HTTP with protobuf or JSON** is accepted (`http/protobuf`, `http/json`) on `/otlp/v1/traces` and
  `/otlp/v1/logs`; responses use the same encoding, and protobuf errors are `google.rpc.Status` messages as the
  OTLP spec requires.
- **OTLP/gRPC** is served on port 4317 for traces and logs (see [OTLP over gRPC](#otlp-over-grpc)).
- Stack traces are parsed from the Node.js format. Other languages still create issues, but frames may be
  missing, so grouping falls back to the error type and message.
- The key is the project's DSN public key. It can also be sent as `Authorization: Bearer <key>`.
- When BugTrail is overloaded it answers `429`/`503` with `Retry-After` (gRPC: `RESOURCE_EXHAUSTED` with
  `RetryInfo`, or `UNAVAILABLE`), and OTLP exporters retry.
- Tested with `@opentelemetry/sdk-node` 0.222 and `@opentelemetry/auto-instrumentations-node` 0.80 (Express 5),
  with both `@opentelemetry/exporter-trace-otlp-http` (JSON) and `@opentelemetry/exporter-trace-otlp-proto` (protobuf).
  gRPC and logs were tested with `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/exporter-logs-otlp-grpc`
  and `@opentelemetry/exporter-logs-otlp-proto` 0.223.0, with and without gzip.

### OTLP over gRPC

BugTrail serves OTLP/gRPC (`TraceService/Export` and `LogsService/Export`) on port **4317**, published by the
compose file (`BUGTOOL_OTLP_GRPC_PORT` to change the host port, `OTLP_GRPC_PORT=0` to turn it off).

```bash
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.bugtrail.example.com   # or http://<server>:4317 on a private network
OTEL_EXPORTER_OTLP_HEADERS=x-bugtrail-key=<project key>
```

- The key goes in gRPC metadata: `x-bugtrail-key`, or `authorization: Bearer <key>`.
- Port 4317 speaks **plain gRPC (no TLS)**. Over the internet, put a proxy with HTTP/2 in front (below) or keep
  the port on a private network or VPN.
- Errors map to gRPC codes: missing key → `UNAUTHENTICATED`, wrong key → `PERMISSION_DENIED`, bad payload →
  `INVALID_ARGUMENT`, over quota or queue full → `RESOURCE_EXHAUSTED` with `RetryInfo`, storage down → `UNAVAILABLE`.

**TLS with Caddy** (forwards to BugTrail over cleartext HTTP/2, `h2c`):

```
otlp.bugtrail.example.com {
    reverse_proxy h2c://localhost:4317
}
```

**TLS with Nginx** (`http2 on;` needs Nginx 1.25.1 or newer; older versions use `listen 443 ssl http2;`):

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name otlp.bugtrail.example.com;
    # ssl_certificate / ssl_certificate_key as for your other sites
    location / {
        grpc_pass grpc://127.0.0.1:4317;
    }
}
```

These two snippets follow the Caddy and Nginx documentation; they weren't run as part of BugTrail's tests,
so check them against your proxy version.

**With an OpenTelemetry Collector** (optional): useful to sample, or to send only error spans to BugTrail while
everything goes to another backend. Forward over HTTP:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  otlp_http/bugtrail:                  # "otlphttp" on older Collector versions
    endpoint: https://bugtrail.example.com/otlp   # /v1/traces and /v1/logs are appended
    headers:
      x-bugtrail-key: ${env:BUGTRAIL_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_http/bugtrail]
    logs:
      receivers: [otlp]
      exporters: [otlp_http/bugtrail]
```

The exporter name and appended paths are from the Collector's `otlphttp` exporter README; check the `headers`
setting against the docs of your Collector version.

### What gets stored

| Data | Lite mode (SQLite, default) | Scale mode (ClickHouse) |
|---|---|---|
| Exceptions on spans | **Always**, every one, as issues | Same |
| Traces that contain an error | **Up to 20 per issue per hour** (`OTLP_TRACES_PER_ISSUE_HOUR`) | **All** |
| Slow traces without an error (server span ≥ the project's slow threshold, default 1,000 ms) | **Up to 10 per endpoint per hour** (`OTLP_SLOW_TRACES_PER_ENDPOINT_HOUR`) | **All** |
| Other traces without an error | **No**, dropped after a few seconds | **All** |
| Request and response bodies | Only if your backend adds them as span attributes | Same |
| Logs | **All** (within the log quota), kept **3 days** (`OTLP_LOG_RETENTION_DAYS`) | **All**, kept for the project's retention days |

In both modes the same error recorded on several spans of one trace counts once, and BugTrail never
captures bodies itself: redact secrets in your backend before they're sent.

Why Lite caps stored traces: a bug that fires thousands of times would otherwise store thousands of nearly
identical traces. Twenty recent examples per hour are enough to debug, and the error count, charts and alerts
still use every event. The counter lives in memory and resets when BugTrail restarts.

Slow traces work the same way: a trace is slow when any server span in it takes at least the threshold set in
**Settings → Data retention → Keep slow traces ≥ … ms** (50–600,000 ms, default 1,000; untick to turn it off).
The cap is per endpoint (method + route), so one slow endpoint can't crowd out the others. A trace that also
has an error only counts against the error cap. Rows in API Health and Traces get a **slow** tag when the
request took at least the current threshold and did not fail (shown in Scale mode too, for information).

### Limits of OpenTelemetry on SQLite

BugTrail is an **error tracker that accepts OpenTelemetry**, not a replacement for a tracing backend.
Read this before sending production traffic:

| | What it means |
|---|---|
| **Only error and slow traces are kept** | Other traces are dropped after a few seconds. To keep every trace, use [Scale mode](#lite-or-scale-mode). |
| **One SQLite writer** | Everything is written by one process to one file. CPU is the limit, not memory (see the measurements below). |
| **Disk grows with error volume** | Each stored error trace takes space (about 1 KB per span). Stored traces are capped per issue (above), so this mostly matters with many *different* errors. Before the cap, 15,000 spans/s with 5% errors added ~57 MB in 2.5 minutes. Lower the retention days, or sample, if errors are frequent. |
| **Node.js stack traces** | `exception.stacktrace` is parsed from the Node.js format. Other languages still create issues, but grouping falls back to type + message. |
| **No breadcrumbs** | OpenTelemetry has no breadcrumbs. Use [Logs](#logs) with trace IDs to see what happened around an error. |

Measured with `bench/otlp.js` on the production image (memory limit 384 MiB, 50 spans per request, 5% of traces with an error):

| Load | Spans/s | Peak memory | CPU (avg) | p95 latency | Failed |
|---|---|---|---|---|---|
| idle | – | 116 MiB | 0% | – | – |
| 20 req/s | 1,000 | 142 MiB | 6% | 9 ms | 0% |
| 100 req/s | 5,000 | 151 MiB | 16% | 7 ms | 0% |
| 300 req/s | 15,000 | 170 MiB | 35% (peaks ~1 core) | 330 ms | 0% |

Above roughly 10,000 spans/s, sample in your backend (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`,
`OTEL_TRACES_SAMPLER_ARG=0.2`) or send only error spans through an OpenTelemetry Collector.

## Lite or Scale mode

BugTrail stores **issues, events, users, settings, API Health and Services data in SQLite in both modes**.
The mode only decides where **OpenTelemetry traces and logs** go.

| | Lite (default) | Scale |
|---|---|---|
| Containers | 1 (BugTrail) | 2 (BugTrail + ClickHouse) |
| OpenTelemetry traces kept | Traces with an error (max 20 per issue per hour) and slow traces (max 10 per endpoint per hour) | Every trace |
| Retention of traces | Project retention days | Project retention days, counted from when the span was received (ClickHouse TTL) |
| OpenTelemetry logs | SQLite, kept 3 days (`OTLP_LOG_RETENTION_DAYS`) | ClickHouse, project retention days (TTL) |
| Choose it when | You want error tracking, and trace examples for errors | You also want to keep every request's trace |

### Turn on Scale mode

```bash
TELEMETRY_STORE=clickhouse \
CLICKHOUSE_PASSWORD='choose-a-long-password' \
docker compose --profile scale up -d --build
```

- The `scale` profile adds the official `clickhouse/clickhouse-server` image. It is **not published on the host**;
  only BugTrail talks to it over the compose network.
- `CLICKHOUSE_PASSWORD` is **required**: BugTrail refuses to start in Scale mode without it, with a one-line error.
  Keep it in your server's environment or an `.env` file next to `docker-compose.yml`, never in git.
- On startup BugTrail waits up to 60 seconds for ClickHouse, creates the `bugtrail` database and the
  `otel_spans` and `otel_logs` tables if needed, and logs `trace storage: clickhouse (all traces), log storage: clickhouse`.
- `/health` reports `traceStore` (`ok` / `unreachable`) and `spanQueue` (spans waiting on disk).
- Settings → Connect your app → OpenTelemetry shows which mode is active.

Switching modes doesn't move data: issues and events stay, and traces start fresh in the new store.

### How Scale mode keeps traces safe

Spans are written to a queue table in SQLite **before** the exporter gets its `200`, then copied to ClickHouse
in batches of about 5,000 spans. Logs use a second queue table that works the same way (`LOG_QUEUE_MAX`,
default 2,000,000 logs).

- **ClickHouse down or restarting:** spans wait on disk and are retried every 5 seconds. Ingest keeps answering
  `200`. When the queue reaches `SPAN_QUEUE_MAX` spans (default 2,000,000) BugTrail answers `429` and
  exporters retry.
- **BugTrail killed:** queued spans are resumed on the next start.
- **No duplicates on retry:** each batch is sent with a deduplication token (a hash of its content), so a
  batch resent after a lost response is ignored by ClickHouse.
- **Rows ClickHouse rejects** (malformed data) are dropped one by one and logged, so they can't block the queue.
- Retention counts from **when BugTrail received the span**, not from the span's own timestamp, so spans from
  a server with a wrong clock, or resent late, are kept for the full retention period.

Tested with docker compose at 50 requests/s × 50 spans:

- ClickHouse stopped for 15 seconds mid-load: 0 failed requests, 100,050 of 100,050 spans stored.
- BugTrail killed with `kill -9` mid-load: every acknowledged span stored, 1,100 queued spans resumed on restart.

### Measured resource use

`bench/otlp.js`, production images on one machine (Docker Desktop), 50 spans per request, 5% error traces.

| Mode | Load | Spans/s | Failed | p95 | BugTrail RAM | ClickHouse RAM |
|---|---|---|---|---|---|---|
| Lite | 300 req/s | 15,000 | 0% | 87 ms | 168 MiB | – |
| Scale | 100 req/s | 5,000 | 0% | 7 ms | 190 MiB | 646 MiB |
| Scale | 300 req/s | 15,000 | 0% | 93 ms | 177 MiB | 748 MiB |

ClickHouse used **27.7 MiB of disk per million spans** (10.2× compression) for these spans. Your size depends
on how many attributes your spans carry.

Rough disk for Scale mode, from that figure:

| Spans per second | Per day | 7-day retention | 30-day retention |
|---|---|---|---|
| 1,000 | ~2.3 GB | ~16 GB | ~70 GB |
| 5,000 | ~12 GB | ~80 GB | ~350 GB |
| 15,000 | ~35 GB | ~245 GB | ~1 TB |

Suggested starting point for a Scale VPS: **2 vCPU, 4 GB RAM, SSD sized from the table above**. The compose file
limits ClickHouse with `CLICKHOUSE_MEM_LIMIT` (default `4g`). Sample in your backend
(`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.2`) to cut disk and CPU.

### Dashboard speed with large data

Measured on a laptop (Apple Silicon, ClickHouse in Docker Desktop with a 4 GB limit); a server will differ, but the
relative numbers hold. Median of 5 runs, 7-day range (the slowest); 24-hour ranges are faster.

| Data | API Health (requests, totals, status chips, top errors) | Traces search, totals, status chips | Logs search | Open a trace |
|---|---|---|---|---|
| **Scale:** 5 million spans (1 million traces in 7 days) + 2 million logs | 170–390 ms | 110–480 ms | 250–440 ms | ~12 ms |
| **Lite:** 1 million stored spans (200,000 error/slow traces in 7 days) + 3 million logs (3 days) | < 10 ms | < 35 ms | < 5 ms | < 1 ms |

How it stays fast:

- HTTP method, route and status are computed once when a span arrives (ClickHouse `MATERIALIZED` columns; SQLite
  generated columns with indexes), not parsed from JSON on every query.
- Trace search reads root spans in time order and only groups the few traces whose root wasn't stored.
- In Lite mode every query runs on the server's only thread, so a slow query would also pause ingest; these
  indexes keep them in milliseconds. They make each stored span and log a bit slower to write (still about 18,000
  logs/s, far above the default quota).

Run it yourself: `apps/api/scripts/bench-clickhouse/` (seed.ts, then run.ts) and `apps/api/scripts/bench-sqlite/run.ts`.

### Backups in Scale mode

Back up SQLite as described in [Backups](#backups); it holds your issues and settings. ClickHouse only holds
traces, which expire anyway. If you need to keep them, snapshot the `clickhouse-data` volume while the
`clickhouse` container is stopped.

## Configuration

Set these as environment variables on the container (in `docker-compose.yml` or a `.env` file next to it).

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:4000` | Public URL of BugTrail. Used in DSNs and invite links. When it starts with `https://`, the login cookie is marked `Secure`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | First admin, created on start only while there are no users. |
| `BUGTOOL_PORT` | `4000` | Port published on the host. |
| `DATABASE_URL` | `file:/data/bugtool.db` | SQLite file inside the container. Keep it on the `/data` volume. |
| `INGEST_BACKLOG_MAX` | `100000` | Maximum number of received but unprocessed events (queued on disk). Above this, ingest answers `429` and the SDKs retry later. |
| `INGEST_BATCH_SIZE` | `200` | Events written per SQLite transaction. Each batch is shared fairly across the projects that have queued events (see [Quotas](#quotas-and-fair-processing)). |
| `LOG_LEVEL` | `warn` | Set to `info` for per-request logs (uses more CPU under load). |
| `RETENTION_INTERVAL_MS` | `600000` | How often the retention job runs (default every 10 minutes). |
| `SOURCEMAP_CACHE_MB` | `32` | Size budget for parsed source maps kept in memory. Parsed maps take several times their file size in RAM, so raise `mem_limit` together with this. |
| `OTLP_TRACES_PER_ISSUE_HOUR` | `20` | Maximum error traces stored per issue per hour for the Trace tab (OpenTelemetry). Errors themselves are always counted. |
| `OTLP_SLOW_TRACES_PER_ENDPOINT_HOUR` | `10` | Lite mode: maximum slow traces (no error, server span ≥ the project's slow threshold) stored per endpoint per hour. |
| `TELEMETRY_STORE` | `sqlite` | `sqlite` (Lite) or `clickhouse` (Scale, needs the `scale` compose profile). |
| `CLICKHOUSE_PASSWORD` | – | Required in Scale mode. Used by both BugTrail and the `clickhouse` service. |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_DATABASE` | set by compose | `http://clickhouse:8123`, `bugtrail`, `bugtrail`. Change only for an external ClickHouse. |
| `CLICKHOUSE_MEM_LIMIT` | `4g` | Memory limit of the `clickhouse` container. |
| `SPAN_QUEUE_MAX` | `2000000` | Scale mode: spans waiting on disk before OTLP answers `429`. |
| `LOG_QUEUE_MAX` | `2000000` | Scale mode: logs waiting on disk before OTLP answers `429`. |
| `OTLP_LOG_RETENTION_DAYS` | `3` | Lite mode: days to keep OTLP logs, counted from when they were received. `0` keeps them forever. |
| `OTLP_GRPC_PORT` | `4317` | Port of the OTLP/gRPC receiver inside the container. `0` turns it off. |
| `BUGTOOL_OTLP_GRPC_PORT` | `4317` | Host port that compose publishes for OTLP/gRPC. |
| `API_PORT` | `4000` | Port of the HTTP server inside the container. |
| `WEB_URL` | `PUBLIC_URL` (set by compose) | Address of the dashboard used in links (alerts, invite links, CSV export). Change only if the dashboard is served from a different address than the API. |
| `WEB_DIST` | `/app/web` | Folder with the built dashboard. Leave unset to serve the API only. |

## HTTPS

Run BugTrail behind the reverse proxy you already use (Caddy, Nginx, Traefik) and forward to port 4000.
With Caddy, this is the whole config:

```
bugtrail.example.com {
    reverse_proxy localhost:4000
}
```

Set `PUBLIC_URL` to the `https://` address so DSNs and invite links use it. OTLP/HTTP goes through the same
address (`/otlp`). For OTLP/gRPC with TLS, see [OTLP over gRPC](#otlp-over-grpc).

## Source maps

Release builds (minified JavaScript, Hermes) produce unreadable stack traces. Upload source maps with
`sentry-cli` and BugTrail translates them back to your original files, functions and lines.

1. **Settings → Source maps → Create token.** The token is shown only once.
2. Give the build (CI) these variables. For React Native you can also put them in `android/sentry.properties`
   and `ios/sentry.properties`:

   ```
   SENTRY_URL=https://bugtrail.example.com
   SENTRY_ORG=bugtool               # any value, BugTrail ignores it
   SENTRY_PROJECT=<project slug>
   SENTRY_AUTH_TOKEN=<token>        # keep it in CI secrets, never commit it
   ```

3. Upload:
   - **Web / Node:** `sentry-cli sourcemaps inject dist/ && sentry-cli sourcemaps upload dist/`
   - **React Native:** the Sentry SDK's Gradle and Xcode plugins upload automatically on release builds.

Stack traces are translated **when the event arrives**, so issue titles and **issue grouping use the real
function names**. An issue stays the same across releases even though minified names change. Events that
arrived before their source map was uploaded are translated when you open them. The original minified stack
trace stays available in the **Minified** tab.

Tested with `sentry-cli` 3.8.0 and `@sentry/node` 11.4.0 (an esbuild bundle with a 4.2 MB source map).
**Not yet tested with a real Hermes build.** If you try it, please report the result.

## Alerts

**Settings → Discord alerts:** paste a Discord webhook URL and choose the triggers:

- **New issue**
- **Regression:** a resolved issue receives new events
- **Error spike:** at least N events within M minutes (with a cooldown of at least 30 minutes)
- **Ongoing errors:** while an issue keeps receiving events, one summary per issue every 30 s, 1, 5 or 15 minutes
  (default 1 minute) with the number of events and users since the last message and how long it has been going on.
  It stops when the issue is quiet for a full interval.
  - **Slow down after 10 minutes** (on by default): a long-running error is then repeated every 15 minutes instead.
  - At most **20 messages per minute per project**; the rest are summed up in one "+N more ongoing issues" message
    (Discord rate-limits webhooks, and a flood of messages delays the important ones).
  - A brand-new issue already gets a **New issue** message, so its first interval is skipped when that alert is on.
    Ignored issues are never sent.

Only `discord.com` / `discordapp.com` webhook URLs are accepted. Use **Send test** to check the webhook.
Alerts still waiting to be sent when the container stops are not resent. The events themselves are safe.

### API alert rules

Under the same card, **API alert rules** watch your backend's HTTP requests (OpenTelemetry server spans, the same
data as [API Health](#api-health)). All rules of a project go to the project's Discord webhook. Up to 20 rules per project.

| Rule type | Condition | Example |
|---|---|---|
| **Status codes**, share | ≥ X% of an endpoint's requests have one of the chosen codes, with at least N requests | `5xx` ≥ 5% in 5 min, min 20 requests |
| **Status codes**, count | ≥ X requests with one of the chosen codes | `403` ≥ 20 requests in 5 min |
| **Latency** | p50, p95 or p99 ≥ X ms, with at least N requests | p95 ≥ 1,000 ms in 5 min, min 20 requests |

- **Status codes** use the same tokens as the API Health filter: a class (`5xx`, `4xx`), exact codes (`401`, `403`, `429`)
  or a range (`520-529`).
- **Scope:** every endpoint (each one is checked on its own and alerts separately) or one endpoint (method + route).
- **Window:** 1–60 minutes. Rules are checked every minute. At most one alert per rule and endpoint every 30 minutes;
  editing a rule resets that.
- The message names the rule and endpoint, shows the most frequent matching codes, and links to API Health filtered on
  that endpoint and status. **Send test** on a rule posts a sample message.
- A low minimum (below about 10 requests) means a single failed request can alert. 4xx codes such as 401 and 404 are
  often normal (wrong password, bots), so prefer a count, or one endpoint, for them.
- Latency percentiles are approximate (the upper bound of a latency bucket), as in API Health.
- Upgrading from a version with the single "Endpoint 5xx rate" alert turns that setting into a rule named **5xx rate**.

## API Health

The **Health** page shows requests, error rate and latency per endpoint (method + route) of your backend.
It works in Lite and Scale mode with no extra configuration: the data is stored in the core SQLite database
in both modes.

- **What it needs:** HTTP server spans (kind `SERVER`) sent via OTLP to `/otlp/v1/traces`, with
  `http.route` (otherwise the span name is used) and `http.response.status_code` (or the older `http.status_code`).
- **How it is counted:** per minute, by receive time, written to the database every 10 seconds.
  Requests that BugTrail answers with 429 or 503 are not counted.
- **Ranges:** 1h, 24h and 7d. Minute data is kept for about 2-3 hours, then folded into hourly rows.
  Hourly rows are kept for 90 days.
- **Endpoint limit:** at most 500 endpoints (per service) per project; the rest is grouped as `* (other)`.
- **Per service:** counts are kept per `service.name`, so the same route in two services stays separate on the
  [Services](#services) page. The Health page adds all services together. Data recorded before an upgrade to
  this version has no service and only appears on the Health page.
- **Percentiles are approximate:** p50/p95/p99 are the upper bound of a latency bucket
  (5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000 ms, and >10 s).
- **Alerts:** see [API alert rules](#api-alert-rules) (status codes, error share, latency). The red markers on the
  Health page use the first enabled `5xx` percentage rule for all endpoints, or 5% with 20 requests when there is none.
- **Top errors (Lite):** on an endpoint's detail, Lite mode computes top errors over the latest 2,000 sampled
  requests that match the filter (to keep the dashboard fast). Scale mode looks at up to 50,000.

## Services

The **Services** page draws a map of your services and the calls between them, from OpenTelemetry spans.
It works in Lite and Scale mode: like API Health, it is counted when spans arrive, so it sees every request even
when Lite mode doesn't store the trace.

- **Services** are named by the `service.name` resource attribute. Requests = incoming `SERVER` and `CONSUMER`
  spans; errors = span status `ERROR` or HTTP 5xx.
- **Calls between services:** a `CLIENT`/`PRODUCER` span of service A whose child `SERVER`/`CONSUMER` span belongs
  to service B. Each service exports its own spans, so BugTrail waits up to **60 seconds** for the other side.
- **External dependencies** (databases, third-party APIs): client calls with no matching server span are drawn as
  external nodes, named from `peer.service`; a database as `<system> · <database name>` (`db.namespace`/`db.name`,
  else the server address), e.g. `mssql · MWS-PIS`, so two databases of the same kind stay separate; otherwise
  `messaging.system`, `server.address` or `rpc.service`. They appear about a minute after the call, once the wait is over.
  At most 200 distinct external destinations per project; the rest are grouped as `(other)`. DNS lookups are ignored.
  On the map these nodes are labelled **database** (known `db.system` values) or **not instrumented**: they don't send
  traces themselves. That says nothing about the network; a database on your private network is shown the same way.
- **Call latency** is measured by the caller (client span). Percentiles are approximate, as in API Health.
- Click a service for its chart, who calls it, what it calls and its HTTP endpoints (each links to API Health).
  Red marks a service or call with at least 5% errors and 20 requests.
- Same storage rules as API Health: per minute, folded into hourly rows after 2-3 hours, hourly rows kept 90 days.

## Traces

The **Traces** page searches stored traces by time range, service, endpoint text (route or span name),
HTTP status and minimum duration, or jumps straight to a trace ID.

**Status chips** (Traces and the API Health requests table) show how many requests or traces each status
code has in the current filters. Select several at once: a class (`5xx`), exact codes (`500`, `502`), or a
custom code or range with **+** (`499`, `520-529`); on Traces, **Errors** = span error or HTTP 5xx. The URL
keeps the selection as `status=500,502` (API: comma-separated tokens, at most 20; invalid → 400).

- **Lite mode** only stores sampled traces that contain an error or are slow, so the search only finds those.
  **Scale mode** stores all spans and finds every trace.
- **Endpoint text search** is case-insensitive for ASCII letters only in Lite (SQLite `LIKE`);
  in Scale it is case-insensitive for full UTF-8.

## Logs

The **Logs** page shows OpenTelemetry log records, newest first. Filter by time range (15 min to 7 days),
service, minimum level and text in the message; click a log for its attributes and resource.

- **Sending logs:** use the OTLP logs exporter of your SDK with the same endpoint and key as traces
  (`/otlp/v1/logs`, or gRPC on port 4317). With the Node.js SDK, add a log record processor with
  `@opentelemetry/exporter-logs-otlp-proto` (or `-grpc`) next to your span processor.
- **Linked to traces:** logs that carry a trace ID (the SDK adds it when you log inside an active span) are listed
  on that trace's page and in the **Logs** tab of an issue whose event has the same trace ID. This also works for
  events from the Sentry SDK when they share the trace ID.
- **Levels:** the OTLP `severity_number` (1-24); when it's missing, the `severity_text` is used (`warn`, `error`, …).
  Structured bodies (maps, arrays) are stored as JSON. Bodies are cut at 16 KB and attribute values at 2 KB.
- **Lite mode:** logs are stored in SQLite and kept for 3 days (`OTLP_LOG_RETENTION_DAYS`). Text search is
  case-insensitive for ASCII letters only. **Scale mode:** logs go to ClickHouse through a disk queue and are kept
  for the project's retention days; text search is case-insensitive for full UTF-8.
- **Quota:** 6,000 logs per minute per project by default (see [Quotas](#quotas-and-fair-processing)).
- BugTrail doesn't scrub log bodies: redact secrets in your backend before they're sent.

## Quotas and fair processing

Per project, under **Settings → Quotas & usage** (project admins):

| Setting | Default | Range |
|---|---|---|
| Error events per minute (Sentry SDK envelope endpoint) | 6,000 | 1–10,000,000 or Unlimited |
| OTLP spans per minute | 600,000 | 1–10,000,000 or Unlimited |
| OTLP logs per minute | 6,000 | 1–10,000,000 or Unlimited |

- Counting uses fixed one-minute windows kept in memory. A restart resets the counters.
- A request that would go over the quota is rejected **as a whole** (never partly accepted) with
  `429 Too Many Requests` and `Retry-After: <seconds until the next minute>`. Sentry envelope responses also carry
  `X-Sentry-Rate-Limits: <seconds>:error:project`, so Sentry SDKs pause sending errors until then.
  Sentry SDKs drop a rate-limited envelope; OTLP exporters retry after `Retry-After`, so a retried batch may be counted as
  dropped more than once.
- The span quota counts every span in an OTLP request, and the log quota every log record. Rejected requests are
  not counted in API Health.
  Exceptions inside OTLP spans are not counted against the event quota.
- Dropped counts are kept per project per hour (written every 10 seconds, kept 30 days). The card shows a 24-hour
  usage chart (accepted in grey, dropped in red). "Events" in the chart are error events stored (after de-duplication
  and retention); "Spans" are OTLP spans accepted.
- When a project starts dropping data, a Discord message is sent (if the project has a webhook), at most once per hour
  per project: *Quota exceeded in &lt;project&gt;: N events / M spans dropped in the last hour* (plus */ K logs* when logs
  were dropped). Dropped logs are also listed under the usage chart; the chart itself shows events and spans.
- Overview and API Health show a banner while the project has dropped data in the last hour.
- **Fair processing:** queued error events are processed in batches that are split across all projects with queued events
  (oldest first per project). A project with a large backlog no longer delays other projects. The disk backlog limit
  (`INGEST_BACKLOG_MAX`) is still shared by all projects; quotas keep one project from filling it.
  In Scale mode, the span queue to ClickHouse is still processed in arrival order (it is written in large batches, so a
  backlog clears quickly once ClickHouse is reachable).

## Data retention

- Per project, under **Settings → Data retention**: maximum number of events and maximum age
  (default 10,000 events / 90 days). The job runs every 10 minutes. Issues left without events are removed
  too, and disk space is returned to the system.
- The same card sets the slow trace threshold (**Keep slow traces ≥ … ms**). Lite mode only; Scale mode keeps every trace.
- OTLP logs: 3 days in Lite mode (`OTLP_LOG_RETENTION_DAYS`), the project's retention days in Scale mode.
- Unused source maps are removed after 90 days.
- Project admins can delete issues (one or in bulk). Only a global admin can delete a project.
  **All deletes are permanent.**

## Backups

The database runs in SQLite WAL mode, so **do not copy the raw file while BugTrail is running.**
Use SQLite's online backup instead:

```bash
docker compose exec bugtool node -e "require('better-sqlite3')('/data/bugtool.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp bugtool:/data/backup.db ./bugtrail-$(date +%F).db
```

To restore, stop the container and put the backup file back as `/data/bugtool.db` on the volume.

## Updating

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically on start. Take a backup before updating.

## Reliability

Every event is written to a queue table in SQLite **before** the SDK receives its `200` response. If the
container dies suddenly (out of memory, `kill -9`, power loss), the remaining queue is processed on the next
start. In a test, 11,313 events were acknowledged before a `kill -9`, and all 11,313 were stored after restart.

## Limitations

- **One Node.js process with SQLite.** That's plenty for internal apps and small-to-medium products, but it isn't
  built for very high volumes. The `bench/` folder has the k6 scripts to measure it on your own hardware.
- **Not supported yet:** email alerts, Slack and generic webhooks, one webhook per alert rule, native crash symbolication
  (Java/Kotlin/Swift crashes outside JavaScript), OTLP metrics, TLS on the gRPC port itself (use a proxy), and
  server-side scrubbing of sensitive data in spans and logs.
