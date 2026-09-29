# Setup and deployment

Naigi runs as a Bun application backed by PostgreSQL and Redis/Valkey. The browser client is built
from `client/` and served by the application. Production deployments must serve the client over
HTTPS; Web Crypto and secure browser storage are not available on ordinary remote HTTP origins.

## Requirements

- Bun and the dependencies in `package.json`.
- PostgreSQL for application data and a **separate PostgreSQL database** for host-operator
  identities and sessions.
- Redis or Valkey for readiness checks, cross-instance pub/sub, realtime support, and optional voice
  token rate limiting.
- Persistent storage for `ATTACHMENTS_DIR` and `PROFILE_IMAGES_DIR`.
- A TLS-terminating reverse proxy for remote access.

## Local development

1. Start PostgreSQL and Redis/Valkey. Create an application database and a separate admin database.
   The sample uses `priv_chat` and `priv_chat_admin`.
2. Install dependencies and prepare the environment:

   ```bash
   bun install
   cp .env.example .env
   ```

   Edit `.env` if your database or Redis URLs differ. Keep real credentials out of source control.
   If `ADMIN_DATABASE_URL` is omitted, Naigi derives it by appending `_admin` to the application
   database name; the derived database must also exist.
3. Apply schema migrations, build the browser client, and start the development server:

   ```bash
   bun run db:migrate
   bun run build:client
   bun run dev
   ```

4. Open `http://localhost:3000/`. `localhost` is treated as a secure browser context for local
   development. Create a normal chat account at `/register`.

The generated `public/` files are build output and are intentionally ignored by Git. Edit files in
`client/` and rebuild with `bun run build:client`.

## Production deployment

1. Create separate PostgreSQL databases for chat data and host-operator data. Use dedicated database
   roles with only the access needed by Naigi and migrations. Do not point both variables at the same
   database.
2. Configure `.env` with production credentials and settings. At minimum, set `NODE_ENV=production`,
   `HOST=127.0.0.1`, `PORT=3000`, `DATABASE_URL`, `ADMIN_DATABASE_URL`, and `REDIS_URL`.
3. Use persistent, access-controlled storage for both directories:

   ```dotenv
   ATTACHMENTS_DIR=/var/lib/naigi/attachments
   PROFILE_IMAGES_DIR=/var/lib/naigi/profile-images
   ```

   These paths use the local filesystem; this release does not include an S3-compatible storage
   adapter. Multi-instance deployments need the same attachment and profile-image files available to
   every application instance.
4. Build the client, apply migrations, and start Naigi under a process supervisor:

   ```bash
   bun install --frozen-lockfile
   bun run build:client
   bun run db:migrate
   bun run start
   ```

5. Terminate TLS at a trusted reverse proxy and proxy requests to `127.0.0.1:3000`. For example,
   Caddy obtains and renews certificates automatically:

   ```caddyfile
   chat.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Keep PostgreSQL, Redis, and the application port private. Open only the public HTTPS port for
   Naigi. Optional LiveKit voice requires its own media/TURN firewall rules; see [Voice calls](VOICE.md).
6. Create the first host operator separately from normal chat accounts:

   ```bash
   bun run admin-users -- create operator-name
   ```

   The command prompts for the password without echoing it. The first operator is an Admin. Manage
   later operators at `/instance-admin/operators`. Host operators are not chat users.

The liveness endpoint is `/health/live`. Readiness at `/health/ready` checks PostgreSQL and Redis.
The first host operator must sign in at `/instance-admin`; regular users register at `/register`.

## Optional integrations

| Integration | Configuration | Notes |
| --- | --- | --- |
| Encrypted direct voice | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | All required together; use WSS in production. See [Voice calls](VOICE.md). |
| GIF search | `KLIPY_API_KEY`, `GIPHY_API_KEY` | These are public browser keys. Restrict them to your site origin; browsers contact the provider directly. |
| Web push | `FCM_SERVICE_ACCOUNT_JSON`, `FCM_WEB_CONFIG_JSON`, `FCM_VAPID_KEY` | All required together; needs HTTPS and browser permission. Push payloads are generic and cannot apply per-room mutes. |
| X/Twitter previews | `TWITTER_PREVIEW_PROVIDERS`, `TWITTER_PREVIEW_API_URL` | The default provider list includes `syndication`; configure an explicit provider list to control the exception. |

Consult `.env.example` for complete examples. Optional integrations are not needed for chat.
Integrations that require a complete credential set (LiveKit and FCM) fail startup if only part of
that set is configured.

## Upgrades, backups, and recovery

- Before upgrading, back up both PostgreSQL databases and the persistent attachment and profile-image
  directories. Apply migrations with `bun run db:migrate`, rebuild the client, then restart the app.
- Attachments are encrypted before upload; profile images are account profile media and are not part
  of the message encryption boundary. Protect both storage directories and backups accordingly.
- Users should export encrypted room-key recovery data from account settings and keep the backup
  passphrase separate and offline. A chat password reset cannot recreate lost device encryption keys.
- Host report-evidence private-key backups are separate from database backups. Store their backup and
  passphrase separately; without the private key, encrypted report evidence cannot be recovered.
- `bun run db:purge -- --yes` deletes local application data. It is not an upgrade or production
  maintenance command.

## Verification

```bash
bun run typecheck
bun test
bun run test:e2ee
```

The E2EE browser test requires PostgreSQL, Redis/Valkey, and Playwright Chromium. It creates temporary
schemas in the configured databases; run it only against databases reserved for development/testing.
