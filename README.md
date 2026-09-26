# Naigi

Secret conference, private consultation — a private discussion behind closed doors.

An encrypted-first text chat backend built with Bun, Elysia, PostgreSQL, and Redis.

The server stores encrypted message envelopes and public device key material. It does not
accept plaintext message content or implement cryptography.

## Local configuration

Copy `.env.example` to `.env` and set credentials for the PostgreSQL and Redis instances
running on your machine. PostgreSQL and Redis are used as follows:

- PostgreSQL stores accounts, devices, memberships, and encrypted messages.
- Redis is used for readiness checks, cross-instance pub/sub, and best-effort realtime notifications.
- Local development stores encrypted attachments under `ATTACHMENTS_DIR`; production should replace this with object storage.

Run the initial schema migration before starting the server:

```bash
bun run db:migrate
bun run dev
```

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

The browser client supports safe Markdown rendering, cursor-based older-message loading, draft
preservation while navigating, server/category management, profile/password settings, and an
opt-in remembered local unlock. Remembered unlock stores only encrypted passphrase material and
a non-extractable Web Crypto key in IndexedDB; use “Forget remembered unlock” on shared devices.

The liveness endpoint does not require either dependency. Readiness is available at
`/health/ready`.

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

## Getting Started
To get started with this template, simply paste this command into your terminal:
```bash
bun create elysia ./elysia-example
```

## Development
To start the development server run:
```bash
bun run dev
```

Open http://localhost:3000/ with your browser to see the result.
