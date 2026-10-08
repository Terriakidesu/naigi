# Architecture

Naigi separates authorization and delivery from message cryptography. The browser is the trusted
cryptographic client; PostgreSQL is the source of truth for encrypted history; Redis is a
best-effort notification bus.

## Components

| Component | Responsibility | Data it handles |
| --- | --- | --- |
| `shared-frontend/` | Pinned shared user UI, local crypto, attachment encryption, browser preferences | Plaintext while the user is using the app; private crypto state in encrypted local storage |
| `client/` | Server-owned instance-admin console and retained legacy user source | Host-operator UI; legacy user files are not built for chat |
| `src/app.ts` | Application assembly: global middleware and route registration order | Nothing; it holds no domain logic |
| `src/http/` | Request and response plumbing: error shape, cookies, static files, input validation, audit writers, rate-limit glue, row-to-API shapes | Opaque passthrough only |
| `src/routes/` | Static client assets, health probes, push configuration, third-party integrations | No user data |
| `src/admin/routes/` | Host-operator console, one module per capability | Instance-wide moderation and operator records |
| `src/auth/`, `src/users/` | Account creation and sign-in; own account, profile media, blocks, reports | Account/profile records, opaque report evidence |
| `src/servers/` | Spaces, channels, categories, roles and grants, invites, moderation | Memberships, permissions, opaque encrypted metadata |
| `src/conversations/`, `src/attachments/` | Conversations, message history, encrypted attachment upload and download | Ciphertext, opaque metadata |
| `src/devices/`, `src/crypto/` | Device registration and the Matrix key relay | Public keys and prekeys only |
| `src/voice/`, `src/realtime/` | Call token issuance, and authenticated WebSocket subscriptions | Connection metadata; ciphertext signalling payloads |
| `src/db/` | PostgreSQL queries and ordered migrations | Accounts, memberships, permissions, encrypted message envelopes, device public keys |
| `src/admin-db/` | Separate host-operator database | Host operator accounts and sessions |
| Redis/Valkey | Cross-instance pub/sub, realtime support, and rate-limit counters | Short-lived notifications, connection state, and throttling counters; not authoritative history |
| `ATTACHMENTS_DIR`, `PROFILE_IMAGES_DIR` | Persistent filesystem-backed media storage | Encrypted chat attachments and server-managed profile images respectively |
| Optional LiveKit | Self-hosted WebRTC SFU/relay for direct calls and joinable voice rooms | Encrypted media frames and connection metadata; never the call/room media key |

## Source layout

`src/app.ts` registers the domain route modules in the order their paths first appeared and owns the
global cross-origin guard, response-header hook, and error mapper. Each module under the directories
above owns one concern end to end, so a change to, say, role permissions touches
`src/servers/permissions.ts` and the route module that calls it rather than a single large file.

Two rules keep the split honest:

- A module must not import from a sibling that imports it back. Where that would happen, the shared
  shape is expressed structurally instead — for example the role-hierarchy check takes
  `{ position, is_system }` rather than the full role row, which is what stops `permissions.ts` and
  `roles.ts` depending on each other.
- Asset paths are resolved through `publicAssetFile()` in `src/http/static-files.ts` rather than
  built from `import.meta.dir`, because a route module's own depth would otherwise silently change
  where `public/` is found.

## Message flow

1. The browser prepares the conversation's Matrix Olm/Megolm session and encrypts message content.
   Attachments are encrypted in the browser before upload.
2. Naigi validates the authenticated sender, active conversation membership, limits, and attachment
   references. PostgreSQL stores the opaque encrypted envelope and ordering cursor.
3. Redis publishes a best-effort event so subscribed clients know that history may have changed. The
   event is not the message itself and does not replace the PostgreSQL history endpoint.
4. Clients fetch envelopes by cursor, reconcile them with their encrypted local cache, and decrypt
   locally. A reconnect always catches up from the authoritative history cursor.

Message content, plaintext names, URLs, embeds, and media keys must not be added to backend logs or
persistent browser caches. Redis notifications are not a durable queue.

## Identity, authorization, and crypto

- Chat sessions use the `priv_chat_session` cookie; native clients may use the same session as a
  bearer token. Host-operator sessions use a different cookie and a separate database.
- Server authorization checks conversation membership, active space membership, role permissions,
  channel access, blocks, and account moderation state before protected operations.
- Device endpoints publish public identity keys and prekeys. Private Olm/Megolm state is owned by the
  client crypto adapter and remains in its encrypted IndexedDB store.
- Server/channel/category/role metadata is encrypted by clients even though the server needs IDs and
  access configuration to authorize requests.

See [API v1](api-v1.md) for the client-independent HTTP contract and [Security and privacy](SECURITY.md)
for known trust limits.

## Voice flow

Direct-call signaling is encrypted inside the direct conversation; voice-room join requests and
media keys use the encrypted voice-channel conversation. Redis relays ciphertext only. A browser
generates the room key and shares it only through that encrypted conversation. Naigi authorizes
voice-channel access and returns short-lived tokens restricted to microphone publishing. Direct-call
rooms have two participants; voice rooms omit an application-wide participant limit and let the
self-hosted LiveKit deployment enforce its available capacity. Browser clients enable LiveKit E2EE
before connecting; the LiveKit service sees encrypted media and connection metadata.

## Operational implications

- PostgreSQL is required for message history and authorization; Redis outages may interrupt realtime
  delivery, but clients recover by fetching history.
- Each app instance needs the same database, Redis, and persistent attachment/profile files. Do not
  use ephemeral container storage for uploaded files.
- Schema changes are numbered SQL migrations in `src/db/migrations/` and are applied once in filename
  order.
- The build copies browser assets and the LiveKit E2EE worker into ignored `public/`; edit source
  assets, not generated output.
