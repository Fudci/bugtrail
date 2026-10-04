<p align="center">
  <img src="brand/wordmark.png" alt="BugTrail" width="360" />
</p>

<p align="center">
  Self-hosted, Sentry-compatible error tracking. One container, SQLite, MIT licensed.
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
- **Overview** per project: events, new issues and users vs the previous period, charts, top issues, platforms; filter by range, release, environment, level and platform.
- **Issue detail:** stacktrace, breadcrumbs, device/OS/network/battery context, app permissions, affected users, event history.
- **Workflow:** resolve / ignore, regressions, assign to teammates, bulk delete, CSV export.
- **Alerts** to Discord on new issues, regressions and error spikes.
- **Teams:** projects with admin / member / viewer roles, invite links.
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
See the [self-hosting guide](docs/self-hosting.md) for HTTPS, source maps, alerts, backups, updates and all environment variables.

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
apps/api        Fastify API: ingest, processing, dashboard API, source maps
apps/web        React + Vite dashboard
packages/db     Prisma schema, SQL migrations, SQLite helpers
bench/          k6 load-test scripts
brand/          logo and icon sources
docs/           self-hosting guide
```

## License

[MIT](LICENSE)
