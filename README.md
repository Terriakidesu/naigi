# Naigi

Self-hosted, privacy-focused chat for people who want to own their infrastructure and keep
their conversations private.

Naigi is an encrypted-first chat application designed to run on infrastructure you control.
Its goal is to provide a practical alternative to hosted chat services without giving up
modern channels, direct conversations, media, or role-based community management.

The server stores encrypted message envelopes and public device key material. It does not
accept plaintext message content or implement cryptography.

## Project principles

- **Self-hosted by default:** run the application, database, realtime services, and encrypted
  attachment storage under your own control.
- **Privacy-focused:** minimize server knowledge and keep message content, names, URLs, embeds,
  and media keys inside end-to-end encrypted payloads.
- **Usable security:** provide familiar chat features while keeping local keys and the local
  encryption passphrase in the browser.
- **Auditable boundaries:** keep authorization, delivery, and storage on the server while
  leaving cryptography and plaintext rendering to reviewed clients.

## Self-hosting

Copy `.env.example` to `.env` and set credentials for PostgreSQL and Redis. `ADMIN_DATABASE_URL`
must point to a PostgreSQL database distinct from `DATABASE_URL` (the default is the app database
name with `_admin` appended); make sure both databases exist before migrating. The example uses
`priv_chat` and `priv_chat_admin`. PostgreSQL and Redis are used as follows:

- PostgreSQL stores accounts, devices, memberships, and encrypted messages.
- The separate admin PostgreSQL database stores only host-operator identities and sessions.
- Redis is used for readiness checks, cross-instance pub/sub, and best-effort realtime notifications.
- Local development stores encrypted attachments under `ATTACHMENTS_DIR`; production should replace this with object storage.

Run the initial schema migration before starting the server:

```bash
bun run db:migrate
bun run dev
```

### Instance reports and host moderation

Instance-wide reports and account suspensions are controlled by host operators, separately from
space owners and moderators. After running `bun run db:migrate`, create a host-only identity with
`bun run admin-users -- create <username>`. The command prompts for a password without echoing it;
use `disable` or `enable` in place of `create` to revoke or restore an operator account. Operators
are stored only in the separate admin database: they cannot sign in to chat, have chat profiles, or
appear in member lists or recipient discovery. Use `password` to rotate an operator password and
revoke their active sessions. For non-interactive shells, add `--password-stdin` and pipe two
newline-separated password entries to the command; do not put passwords in command arguments.
The host-only console is at `/instance-admin`.

Reports contain the selected reason and account/message references. Reporters may separately
opt in to send details or a selected message excerpt encrypted in their browser to a host report
key. The server stores only the encrypted evidence envelope; it does not retrieve or decrypt the
reported conversation. The excerpt is supplied by the reporter and is not independently verified
as an authentic copy of the original message.

Generate the report key from the host console and store its passphrase-encrypted backup offline.
Keep the backup and passphrase separate, and share either only with trusted host operators. The
private key is unlocked in memory in an operator's browser and is not uploaded or saved in browser
storage. Keep retired-key backups to decrypt evidence encrypted before key rotation. If every copy
of a private-key backup is lost, its evidence cannot be recovered.

Account blocking prevents direct conversations in both directions and suppresses their realtime
events. It does not hide activity in shared spaces or remove either account from those spaces.
Instance moderation actions (report review, evidence access, message removal, suspension, and key
creation) are recorded in an instance-wide audit log. These controls provide moderation tools but
do not by themselves guarantee compliance with any particular jurisdiction's legal requirements.

To clear all local application data while preserving the schema and migrations:

```bash
bun run db:purge -- --yes
```

The purge refuses to run with `NODE_ENV=production` and does not remove files from
`ATTACHMENTS_DIR`.

## Servers and channels

The `/v1/servers` API provides invite-only Discord-style servers with ordered text channels,
memberships, owner/admin roles, and hashed expiring invites. Each channel has its own E2EE
conversation identity; channel messages use the existing conversation message and realtime
transport. Server, channel, and category names are client-encrypted opaque metadata, so the
backend only sees IDs, membership, roles, categories, and ordering. The full future-frontend contract is in
[`docs/api-v1.md`](docs/api-v1.md).

Private conversation recipients are limited to active members of a server that the creator also
belongs to. Naigi does not provide a global account directory or global user search.

The browser client supports safe Markdown rendering, cursor-based older-message loading, draft
preservation while navigating, server/category management, profile/password settings, and an
opt-in remembered local unlock. Remembered unlock stores only encrypted passphrase material and
a non-extractable Web Crypto key in IndexedDB; use “Forget remembered unlock” on shared devices.
On HTTPS or localhost, check **Remember this device** once on the unlock page to avoid
entering the passphrase again on subsequent visits. The checkbox is opt-in because
anyone with access to the browser profile can then unlock the encrypted key store.
The passphrase is never transmitted to the server.

### Access from another device

Use HTTPS when accessing Naigi from a LAN address or remote host. Browsers do not
enable the Web Crypto API required for remembered unlock on plain `http://` IP
addresses; serving an E2EE app over HTTP also lets a network attacker replace
the client code. Changing `HOST` or `NODE_ENV` does not make an HTTP origin secure.
For example, with a domain pointed at your server and a reverse proxy such as Caddy:

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Run Naigi with `HOST=127.0.0.1` behind the proxy and visit
`https://chat.example.com`. For LAN-only access, use a trusted local TLS
certificate or an HTTPS tunnel instead. If you have SSH access to the host,
you can forward its port without exposing an insecure HTTP origin:

```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
```

Then open `http://localhost:3000` on your own device. Browser storage is scoped to the exact
origin, so a previously remembered unlock on `localhost` cannot be reused on
a different domain or port.

### Optional GIF search

Set `KLIPY_API_KEY` and/or `GIPHY_API_KEY` to enable the browser GIF picker.
These must be browser-restricted public integration keys: authenticated browsers receive the
configured key and contact the provider directly, so search terms and provider URLs do not pass
through Naigi. Selected GIF bytes enter the normal browser-encrypted attachment flow. Tenor's
retired API is not used; pasted Tenor page links remain external previews when previews are
enabled.

### Optional Firebase Cloud Messaging

Web push is opt-in and requires HTTPS (localhost is suitable for development). Configure a
Firebase web app with Cloud Messaging and a Web Push certificate, then set
`FCM_SERVICE_ACCOUNT_JSON`, `FCM_WEB_CONFIG_JSON`, and `FCM_VAPID_KEY` in the server environment.
The service account needs permission to send Firebase Cloud Messaging messages; keep its private
key secret and restrict the Firebase web API key to your Naigi origin. Apply database migrations
after enabling FCM with `bun run db:migrate`.

Users must grant browser notification permission and choose **All new messages** for background
push. **Mentions only** remains client-side and alerts only while Naigi is open. Quiet hours are
stored in that browser and applied by the service worker. Pushes are data-only generic events: the
payload sent to Firebase contains no message content, room ID, sender identity, or mention data.
As a result, closed-app alerts cannot apply per-room mutes.
Firebase does receive the device registration token and delivery timing, so enabling FCM adds that
third-party dependency to the notification path.

GIF search and Firebase Cloud Messaging are optional and are not required to run Naigi.
Liveness is available at `/health/live`; readiness, which checks PostgreSQL and Redis, is
available at `/health/ready`.

## Realtime

Authentication responses set an `HttpOnly` `priv_chat_session` cookie. A client can open
`/v1/realtime` with that cookie and subscribe to authorized conversations:

```json
{"type":"subscribe","conversationId":"conversation-uuid"}
```

Realtime events contain only message IDs and ordering metadata. A client must fetch the
encrypted envelope from PostgreSQL using the message history endpoint. Redis is not the
source of truth; reconnecting clients must always synchronize using a cursor.

## Device key directory

After authenticating, a client registers its public identity key, signed prekey, and a
batch of one-time prekeys with `POST /v1/devices`. A sender fetches active device bundles
from `GET /v1/users/:userId/devices/keys`; one unused prekey is atomically consumed for
each device. Private keys never reach this API. The client protocol is intentionally not
implemented by the backend and must use a reviewed E2EE library.

## Encryption boundary

The message endpoint accepts only base64url-encoded ciphertext, protocol identifiers, and
opaque protocol metadata. Text, URLs, embed previews, media keys, profile-related message content, and other user content
must be encrypted by a client before they reach this server. No cryptographic protocol is
implemented in the backend.

## Photos, videos, and attachments

The client must compress and optionally resize a photo before encryption. A recommended
photo path is a maximum dimension of 2048 pixels and JPEG/WebP quality around 0.8; the
client may create an encrypted thumbnail at the same time. The backend receives and stores
only the resulting encrypted bytes, so it never performs image compression, decoding, OCR,
or content inspection. Users who need the original file can send it as a separate attachment.

Images are resized/recompressed where supported; videos and other files retain their
client-selected MIME type and extension. All media is encrypted before upload. Create an attachment with
`POST /v1/conversations/:conversationId/attachments`, upload the encrypted bytes with
`PUT /v1/attachments/:attachmentId`, and download them with
`GET /v1/attachments/:attachmentId`.

## Matrix crypto transport

The browser crypto adapter can use the Matrix SDK WASM state machine through these
transport endpoints:

- `POST /v1/crypto/keys/upload`
- `POST /v1/crypto/keys/query`
- `POST /v1/crypto/keys/claim`
- `POST /v1/crypto/send-to-device/:eventType/:transactionId`
- `GET /v1/crypto/to-device?deviceId=...`
- `POST /v1/crypto/to-device/ack`
- `GET /v1/conversations/:conversationId/members`

These endpoints store public device keys and encrypted to-device payloads. They do not
decrypt, validate, or log message content. The WASM package is Apache-2.0 licensed and is
initialized in the browser, with private state kept in its encrypted IndexedDB store.

## Browser client

Build the browser bundle and start the backend:

```bash
bun run build:client
bun run dev
```

Then open `http://localhost:3000/`. The browser client uses Matrix Olm/Megolm through
`@matrix-org/matrix-sdk-crypto-wasm`, keeps private state in an encrypted IndexedDB store,
compresses supported photos before encrypting them, supports encrypted video attachments,
and only renders allowlisted YouTube and X previews after an explicit user action. The local
encryption passphrase is separate from the server password and
is never sent to the backend. The client is split into separate views instead of loading
every workflow into one page:

- `/` — sign in
- `/register` — create an account
- `/unlock` — unlock the local browser key store
- `/app` — active encrypted conversations
- `/new` — create a conversation
- `/settings` — profile and device management

The generated `public/` bundle is intentionally not tracked.

## Development

To start the development server run:

```bash
bun run dev
```

Open http://localhost:3000/ with your browser to see the result.
