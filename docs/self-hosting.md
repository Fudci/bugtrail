# Self-hosting BugTrail

BugTrail runs as **one container**: the API, the event processor and the dashboard. Data lives in a single
SQLite file (`/data/bugtool.db`) on the Docker volume `bugtool-data`. There is no separate database, queue
or cache to run.

- [Requirements](#requirements)
- [Install](#install)
- [Connect your app](#connect-your-app)
- [Configuration](#configuration)
- [HTTPS](#https)
- [Source maps](#source-maps)
- [Alerts](#alerts)
- [Data retention](#data-retention)
- [Backups](#backups)
- [Updating](#updating)
- [Reliability](#reliability)
- [Limitations](#limitations)

## Requirements

- Docker with Docker Compose.
- About **400 MB RAM** for the container (the compose file sets `mem_limit: 384m`) and disk for your events.
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

Running `create-admin.js` again for an existing email resets that user's password.

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

## Configuration

Set these as environment variables on the container (in `docker-compose.yml` or a `.env` file next to it).

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:4000` | Public URL of BugTrail. Used in DSNs and invite links. When it starts with `https://`, the login cookie is marked `Secure`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | First admin, created on start only while there are no users. |
| `BUGTOOL_PORT` | `4000` | Port published on the host. |
| `INGEST_BACKLOG_MAX` | `100000` | Maximum number of received but unprocessed events (queued on disk). Above this, ingest answers `429` and the SDKs retry later. |
| `INGEST_BATCH_SIZE` | `200` | Events written per SQLite transaction. |
| `LOG_LEVEL` | `warn` | Set to `info` for per-request logs (uses more CPU under load). |
| `RETENTION_INTERVAL_MS` | `600000` | How often the retention job runs (default every 10 minutes). |
| `SOURCEMAP_CACHE_MB` | `32` | Size budget for parsed source maps kept in memory. Parsed maps take several times their file size in RAM, so raise `mem_limit` together with this. |

## HTTPS

Run BugTrail behind the reverse proxy you already use (Caddy, Nginx, Traefik) and forward to port 4000.
With Caddy, this is the whole config:

```
bugtrail.example.com {
    reverse_proxy localhost:4000
}
```

Set `PUBLIC_URL` to the `https://` address so DSNs and invite links use it.

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

Only `discord.com` / `discordapp.com` webhook URLs are accepted. Use **Send test** to check the webhook.
Alerts still waiting to be sent when the container stops are not resent. The events themselves are safe.

## Data retention

- Per project, under **Settings → Data retention**: maximum number of events and maximum age
  (default 10,000 events / 90 days). The job runs every 10 minutes. Issues left without events are removed
  too, and disk space is returned to the system.
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
- **Not supported yet:** email alerts, Slack and generic webhooks, and native crash symbolication
  (Java/Kotlin/Swift crashes outside JavaScript).
