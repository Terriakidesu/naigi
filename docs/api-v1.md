# Naigi API v1

Naigi is a self-hosted, privacy-focused chat application. This API supports deployments
where the operator controls the application server, database, realtime service, and encrypted
attachment storage. It deliberately handles opaque encrypted payloads rather than plaintext
conversation content.

This document describes the client-independent contract for native, desktop, and web
frontends. The API is responsible for identity, authorization, ordering, and delivery of
opaque encrypted envelopes. A frontend is responsible for cryptography, secure local key
storage, photo compression, and rendering.

## Authentication

`POST /v1/auth/register` and `POST /v1/auth/login` set the `HttpOnly` session cookie
`priv_chat_session`. Native clients may send the same session token as a bearer token:

```http
Authorization: Bearer <session-token>
```

All protected endpoints return `{ "error": "stable_error_code" }` on failure. Clients
should branch on the HTTP status and error code rather than display server text.

`PATCH /v1/me` changes the display name. `PUT /v1/me/avatar` replaces the authenticated
user's profile image with a PNG, JPEG, GIF, WebP, or AVIF image up to 5 MiB; animated GIF,
WebP, and AVIF images are supported. `DELETE /v1/me/avatar` removes it. `GET
/v1/users/:userId/avatar` serves an authenticated user's image. `POST /v1/auth/password`
accepts the current password and a new password; changing it revokes the account's other
sessions.

`POST /v1/previews/twitter` is the only server-side link-preview exception. It accepts an
authenticated request containing an allowlisted `x.com`, `twitter.com`, or supported rewrite
domain status URL and returns a normalized public-post preview. The server sends only the
validated numeric status ID to the explicitly configured preview-provider chain; it does not
persist or log the URL or returned preview. The browser encrypts any returned card data inside
the message before sending it.

## Optional web push

When Firebase Cloud Messaging is configured, `GET /v1/push/config` returns the public Firebase
web-app configuration and VAPID key. Authenticated clients may register or remove a browser's
FCM registration token with `POST /v1/push/subscriptions` and
`POST /v1/push/subscriptions/remove`, respectively. The server stores tokens per account and sends
best-effort data-only events after new messages. Those event payloads contain only a generic event
type; they never include message content, room IDs, sender identity, or mentions. Browser-local
preferences decide whether to display a background notification. Because room IDs are omitted,
background push cannot honor per-room mute settings.

`GET /v1/gifs/providers` returns the explicitly configured Klipy and/or GIPHY browser integration
keys plus the encrypted attachment size limit to an authenticated client. Those are public,
origin-restricted browser keys: the browser contacts the provider directly for GIF searches and
downloads, then encrypts a selected GIF through the normal attachment flow. The server does not
receive, persist, proxy, or log search terms, provider URLs, GIF bytes, or media keys. Tenor's
retired API is not used; provider-page preview information remains inside encrypted message
content.

## Reports, account blocking, and instance administration

Reports are installation-wide and are reviewed by host operators provisioned in the separate admin
database. `POST /v1/instance-admin/auth/login` sets the `HttpOnly` cookie
`priv_chat_admin_session`; `GET /v1/instance-admin/auth/me` checks it and
`POST /v1/instance-admin/auth/logout` revokes it. This cookie and identity store are independent
from chat authentication and `priv_chat_session`. Host operators are not chat accounts and cannot
appear in chat profiles, member lists, or recipient discovery. Space ownership or a space-admin role
does not grant access to the instance moderation console or endpoints.

`GET /v1/reports/public-key` returns the active host evidence key (if configured). An authenticated
client submits a report with `POST /v1/reports`, including a target UUID and one of `spam`,
`harassment`, `threats`, `sexual_content`, `illegal_content`, `impersonation`, or `other`. Message
reports may also include `conversationId` and `messageId`; the server verifies that the reporter is
an active conversation member and that the message sender matches the target account. Reports
without a message reference are limited to accounts with whom the reporter shares an active server.
Open reports against one message may be submitted only once by a reporter, and each account has a
rate limit of ten reports per hour.

Message text and report details are never sent to the server in plaintext. The client leaves
`encryptedEvidence` out of the request unless the reporter explicitly opts in. When included, the
client encrypts the reporter-supplied evidence with an ephemeral AES-256-GCM key and wraps that key
to the host's RSA-OAEP-3072/SHA-256 public key. The server stores only the encrypted envelope and
key ID. A shared excerpt is supplied by the reporter and is not proof that the excerpt matches the
original encrypted message. Operators unlock an encrypted private-key backup locally in the
browser; private report keys are never uploaded or stored by the server. Retired public keys remain
available for existing evidence, so operators must keep their old private-key backups.

The host-only web console is at `/instance-admin`. Its APIs are:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/instance-admin/auth/login` | Sign in with a host-operator identity |
| `GET` | `/v1/instance-admin/auth/me` | Get the authenticated host operator |
| `POST` | `/v1/instance-admin/auth/logout` | Revoke the host-operator session |
| `GET` | `/v1/instance-admin/reports?status=open` | List report metadata (no message body or evidence ciphertext) |
| `GET` | `/v1/instance-admin/reports/:reportId` | Read one report and its optional encrypted evidence envelope |
| `PATCH` | `/v1/instance-admin/reports/:reportId` | Set report status to `open`, `reviewing`, `resolved`, or `dismissed` |
| `POST` | `/v1/instance-admin/reports/:reportId/evidence-access` | Record that an operator decrypted evidence locally |
| `POST` | `/v1/instance-admin/reports/:reportId/remove-message` | Remove the referenced encrypted message from server history |
| `POST` | `/v1/instance-admin/users/:userId/suspend` | Revoke sessions and suspend an account, optionally resolving a matching report |
| `DELETE` | `/v1/instance-admin/users/:userId/suspension` | Restore a suspended account |
| `GET` | `/v1/instance-admin/report-keys` | List active and retired public-key IDs |
| `POST` | `/v1/instance-admin/report-keys` | Register and activate an RSA public key |
| `GET` | `/v1/instance-admin/audit` | Read the instance-wide admin audit log |

Report detail views, evidence-access actions, report status changes, message removal, account
suspension/restoration, and key creation are recorded with actor, action, report/user references,
and timestamps. Audit rows do not contain message plaintext or report evidence. The host operator
is responsible for evidence-key backup and access policy; these tools do not establish legal
compliance for a particular jurisdiction.

`GET /v1/users/blocked` lists the caller's blocks. Authenticated clients can block and unblock with
`POST /v1/users/:userId/block` and `DELETE /v1/users/:userId/block`. A block is enforced both ways
for direct conversations: direct-message creation, message history, attachments, and realtime
delivery are denied while a block exists. Shared-space membership and shared-space messages are
unchanged.

## Servers and channels

Servers are invite-only. Server membership, roles, channel order, IDs, and timestamps are
visible to the backend for authorization. Server and channel names/descriptions are not:
`encryptedMetadata` is unpadded base64url-encoded ciphertext supplied by the frontend.
The server treats it as opaque bytes.

The browser reference client encrypts metadata in the channel's Matrix room and puts a
small JSON object such as `{ "name": "general", "kind": "text" }` inside the encrypted
event. Other frontends may use the same Matrix room identity or another reviewed protocol;
the backend does not depend on that representation.

### Server endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/servers` | List active server memberships |
| `POST` | `/v1/servers` | Create a server and its initial `general` channel |
| `GET` | `/v1/servers/:serverId` | Fetch one authorized server |
| `PATCH` | `/v1/servers/:serverId` | Replace encrypted server metadata and/or set the join-announcement and landing rooms (owner/admin) |
| `GET` | `/v1/servers/:serverId/branding/:asset` | Serve an authenticated `icon` or `banner` asset |
| `PUT` | `/v1/servers/:serverId/branding/:asset` | Replace a server icon or banner (manage server) |
| `DELETE` | `/v1/servers/:serverId/branding/:asset` | Remove a server icon or banner (manage server) |
| `GET` | `/v1/servers/:serverId/categories` | List ordered active categories |
| `POST` | `/v1/servers/:serverId/categories` | Create a category (owner/admin) |
| `PATCH` | `/v1/servers/:serverId/categories/:categoryId` | Replace metadata or set `position` |
| `DELETE` | `/v1/servers/:serverId/categories/:categoryId` | Archive a category and uncategorize its channels |
| `PATCH` | `/v1/servers/:serverId/roles/:roleId/categories/:categoryId` | Grant or replace inherited role access to a category |
| `DELETE` | `/v1/servers/:serverId/roles/:roleId/categories/:categoryId` | Remove inherited role access from a category |
| `GET` | `/v1/servers/:serverId/members` | List active members and roles |
| `GET` | `/v1/servers/:serverId/invites` | List invite metadata (owner/admin) |
| `POST` | `/v1/servers/:serverId/invites` | Replace the current active invite with a hashed, expiring invite (owner/admin) |
| `DELETE` | `/v1/servers/:serverId/invites/:inviteId` | Revoke an invite |
| `GET` | `/v1/servers/:serverId/emojis` | List opaque custom-emoji metadata for members |
| `POST` | `/v1/servers/:serverId/emojis` | Create an encrypted custom-emoji upload (manage custom emoji) |
| `PUT` | `/v1/servers/:serverId/emojis/:emojiId/file` | Upload encrypted custom-emoji bytes |
| `GET` | `/v1/servers/:serverId/emojis/:emojiId/file` | Download encrypted custom-emoji bytes |
| `DELETE` | `/v1/servers/:serverId/emojis/:emojiId` | Remove a custom emoji |
| `GET` | `/v1/servers/:serverId/audit-logs` | Read authorization-scoped management activity (view audit logs) |
| `POST` | `/v1/invites/:token/accept` | Join using a one-time-presented invite token |
| `PATCH` | `/v1/servers/:serverId/members/:userId` | Owner changes `admin`/`member` role |
| `DELETE` | `/v1/servers/:serverId/members/:userId` | Owner/admin removes a member |
| `POST` | `/v1/servers/:serverId/leave` | Leave a server; ownership must be transferred first |

### Channel endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/servers/:serverId/channels` | List ordered active text channels |
| `POST` | `/v1/servers/:serverId/channels` | Create a text channel (owner/admin) |
| `PATCH` | `/v1/servers/:serverId/channels/:channelId` | Replace metadata, category, or `position` |
| `DELETE` | `/v1/servers/:serverId/channels/:channelId` | Archive a channel |

The original channel created with a server is retained as the reference client's encrypted
metadata anchor; it cannot be archived. The server also always retains at least one active
text channel.

Every channel includes a `conversationId`. This is the E2EE room identity and is used with
the generic conversation endpoints below. It is distinct from the channel ID so a future
frontend can keep navigation and cryptographic room state separate.

Category IDs and channel ordering are server-visible for navigation. Category names and
descriptions remain inside `encryptedMetadata`; the reference browser client encrypts
category metadata in the first active channel room.

Roles may receive category-level view/upload grants. Active channels in that category inherit
those grants in addition to any channel-specific grants. `PATCH /v1/servers/:serverId` accepts
`onboardingChannelId` (or `null` to disable join notices); a new server defaults it to its first
active channel. The API exposes this ID as `onboardingChannelId`. The server only stores the
channel ID and never creates or reads the encrypted join notice; the browser that accepts an
invite may publish the notice as an encrypted `m.notice` event.
`landingChannelId` independently controls the room opened when a member selects the space; it
also defaults to the first active channel and may be `null` to use the first visible room.

Server icon and banner bytes are authenticated account-style assets. Custom emoji files are
different: the reference client encrypts them with a browser-generated key before upload and
stores the key only inside the encrypted emoji metadata. Audit rows contain stable action codes
and UUID targets; they never contain message content, encrypted payloads, room names, URLs, or
media keys.

## Encrypted conversations

The existing conversation transport is used for both DMs/groups and server text channels:

- `GET /v1/conversations/:conversationId/members`
- `GET /v1/users/:userId`
- `GET /v1/users/:userId/avatar`
- `GET /v1/users/:userId/banner`
- `PUT /v1/me/banner`
- `DELETE /v1/me/banner`
- `GET /v1/conversations/:conversationId/messages?limit=50&before=<sequence>`
- `GET /v1/conversations/:conversationId/messages?limit=50&after=<sequence>`
- `POST /v1/conversations/:conversationId/messages`
- `POST /v1/conversations/:conversationId/attachments`
- `PUT /v1/attachments/:attachmentId`
- `GET /v1/attachments/:attachmentId`

Message requests contain a sender device ID, client UUID, protocol identifier, ciphertext,
and optional protocol metadata. URLs, embed data, text, media keys, and message metadata
must already be encrypted by the client. History is cursor-paginated by `serverSequence`;
`before` returns older messages and `after` returns newer messages; only one cursor may be
provided per request. Encrypted `m.redaction` events mark a message deleted without exposing
plaintext or mutating the append-only ciphertext history. PostgreSQL is authoritative after
realtime reconnects.

New server members are added to current channels but are not granted prior cryptographic
history by this API. Removing a member stops future authorization and marks their channel
memberships inactive; it cannot revoke plaintext or keys already obtained. Frontends must
rotate room keys before sending further channel messages after membership changes.

Profile images are account metadata rather than message attachments. They are stored separately
from encrypted conversation media and are only served to authenticated users.

## Realtime

Open `GET /v1/realtime` as a WebSocket with the authenticated cookie/token, then send:

```json
{"type":"subscribe","conversationId":"<channel-conversation-id>"}
```

Realtime payloads are notifications only. Fetch the encrypted message envelope from
PostgreSQL after receiving `message.created`. Reconnect and synchronize with the history
cursor; Redis is not the source of truth.

## Crypto transport

Browser Matrix Olm/Megolm clients use:

- `POST /v1/crypto/keys/upload`
- `POST /v1/crypto/keys/query`
- `POST /v1/crypto/keys/claim`
- `POST /v1/crypto/send-to-device/:eventType/:transactionId`
- `GET /v1/crypto/to-device?deviceId=...`
- `POST /v1/crypto/to-device/ack`

Private keys never leave the frontend. Crypto and metadata payloads are stored as opaque
JSON or bytes and are not decrypted or inspected by the backend.
