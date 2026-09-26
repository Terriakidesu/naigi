# priv-chat API v1

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
| `PATCH` | `/v1/servers/:serverId` | Replace encrypted server metadata (owner/admin) |
| `GET` | `/v1/servers/:serverId/members` | List active members and roles |
| `POST` | `/v1/servers/:serverId/invites` | Create a hashed, expiring invite (owner/admin) |
| `DELETE` | `/v1/servers/:serverId/invites/:inviteId` | Revoke an invite |
| `POST` | `/v1/invites/:token/accept` | Join using a one-time-presented invite token |
| `PATCH` | `/v1/servers/:serverId/members/:userId` | Owner changes `admin`/`member` role |
| `DELETE` | `/v1/servers/:serverId/members/:userId` | Owner/admin removes a member |
| `POST` | `/v1/servers/:serverId/leave` | Leave a server; ownership must be transferred first |

### Channel endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/servers/:serverId/channels` | List ordered active text channels |
| `POST` | `/v1/servers/:serverId/channels` | Create a text channel (owner/admin) |
| `PATCH` | `/v1/servers/:serverId/channels/:channelId` | Replace metadata or set `position` |

Every channel includes a `conversationId`. This is the E2EE room identity and is used with
the generic conversation endpoints below. It is distinct from the channel ID so a future
frontend can keep navigation and cryptographic room state separate.

## Encrypted conversations

The existing conversation transport is used for both DMs/groups and server text channels:

- `GET /v1/conversations/:conversationId/members`
- `GET /v1/conversations/:conversationId/messages?limit=100&before=<sequence>`
- `POST /v1/conversations/:conversationId/messages`
- `POST /v1/conversations/:conversationId/attachments`
- `PUT /v1/attachments/:attachmentId`
- `GET /v1/attachments/:attachmentId`

Message requests contain a sender device ID, client UUID, protocol identifier, ciphertext,
and optional protocol metadata. URLs, embed data, text, photo keys, and message metadata
must already be encrypted by the client. History is cursor-paginated by `serverSequence`;
PostgreSQL is authoritative after realtime reconnects.

New server members are added to current channels but are not granted prior cryptographic
history by this API. Removing a member stops future authorization and marks their channel
memberships inactive; it cannot revoke plaintext or keys already obtained. Frontends must
rotate room keys before sending further channel messages after membership changes.

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
