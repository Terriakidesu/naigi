# Naigi API v1

Naigi is a self-hosted, privacy-focused chat application. This API supports deployments
where the operator controls the application server, database, realtime service, and encrypted
attachment storage. It deliberately handles opaque encrypted payloads rather than plaintext
conversation content.

This document describes the client-independent contract for native, desktop, and web
frontends. The API is responsible for identity, authorization, ordering, and delivery of
opaque encrypted envelopes. A frontend is responsible for cryptography, secure local key
storage, photo compression, and rendering.

## Server information

`GET /v1/version` is public and returns the Naigi server's application version and supported
API version. For example:

```json
{"name":"Naigi","version":"0.24.0","apiVersion":1}
```

Clients should display the server version separately from their own application version.

## Authentication

`POST /v1/auth/register` and `POST /v1/auth/login` set the `HttpOnly` session cookie
`priv_chat_session`. Native clients may send the same session token as a bearer token:

```http
Authorization: Bearer <session-token>
```

All protected endpoints return `{ "error": "stable_error_code" }` on failure. Clients
should branch on the HTTP status and error code rather than display server text.

Authentication endpoints are throttled and may return `429 rate_limited` with a
`Retry-After` header, or `503 auth_temporarily_unavailable` when the rate-limit backend is
unreachable. Registration and password change additionally reject weak passwords with
`422 password_too_common` or `422 password_too_similar`.

These codes are new in 0.27.0 and the pinned browser client does not yet map them to prose, so a
user on the current client sees the raw code (for example `password_too_common (422)`) rather
than a sentence. Treat that as cosmetic: clients should branch on the code as documented here,
and the message strings belong in the shared frontend repository.

A state-changing request that the browser identifies as cross-origin is refused with
`403 cross_origin_request_rejected`, answered by `Sec-Fetch-Site` or by comparing `Origin` against
the request's own origin. A request carrying neither header is allowed, so native clients are
unaffected. A WebSocket handshake identified as cross-origin is closed with code `4003` and reason
`cross_origin_rejected` before the session is looked up.

Responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
no-referrer`, and a `Permissions-Policy` granting only `microphone=(self)`. `Strict-Transport-Security`
is added when the request arrived over HTTPS. A report-only `Content-Security-Policy` is also sent;
it permits the WebAssembly crypto adapter and blob workers and is not yet enforcing.

`GET /v1/users/:userId/devices/keys` is withdrawn and now returns `410 endpoint_removed`
with `Deprecation: true` and a `Link` header pointing at the successor. It published the key
bundles of any account in the instance and consumed one-time prekeys on read. Use
`POST /v1/crypto/keys/claim`, which is scoped to the requesting account. The route is deleted
in the next release.

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
database. The first host identity created by `bun run admin-users -- create <username>` is an Admin.
Admins can provision and manage additional operators in the console. Moderators can review reports
and manage chat accounts, but cannot access platform controls, maintenance, report evidence or key
management, or operator management. `POST /v1/instance-admin/auth/login` sets the `HttpOnly` cookie
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
original encrypted message. Admins unlock encrypted private-key backups locally in the browser and
manage report keys; private keys are never uploaded or stored by the server. Retired public keys
remain available for existing evidence, so Admins must keep their old private-key backups.

The host-only web console is at `/instance-admin`. Its APIs are:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/instance-admin/auth/login` | Sign in with a host-operator identity |
| `GET` | `/v1/instance-admin/auth/me` | Get the authenticated host operator |
| `POST` | `/v1/instance-admin/auth/logout` | Revoke the host-operator session |
| `GET` | `/v1/instance-admin/reports?status=open` | List report metadata (no message body or evidence ciphertext) |
| `GET` | `/v1/instance-admin/reports/:reportId` | Read one report; only Admins receive its optional encrypted evidence envelope |
| `PATCH` | `/v1/instance-admin/reports/:reportId` | Set report status to `open`, `reviewing`, `resolved`, or `dismissed` |
| `POST` | `/v1/instance-admin/reports/:reportId/evidence-access` | Admin-only audit record that evidence was decrypted locally |
| `POST` | `/v1/instance-admin/reports/:reportId/remove-message` | Remove the referenced encrypted message from server history |
| `POST` | `/v1/instance-admin/users/:userId/suspend` | Revoke sessions and suspend an account, optionally resolving a matching report |
| `DELETE` | `/v1/instance-admin/users/:userId/suspension` | Restore a suspended account |
| `GET` | `/v1/instance-admin/users` | Search and page through chat accounts as a host operator |
| `GET` | `/v1/instance-admin/users/:userId` | Read an account's instance warning and action history |
| `POST` | `/v1/instance-admin/users/:userId/warnings` | Issue an instance-wide warning |
| `DELETE` | `/v1/instance-admin/warnings/:warningId` | Revoke an instance-wide warning |
| `POST` | `/v1/instance-admin/users/:userId/timeout` | Apply or update an audited installation-wide send timeout (60 seconds to 30 days) |
| `DELETE` | `/v1/instance-admin/users/:userId/timeout` | Remove an active installation-wide send timeout |
| `GET` | `/v1/instance-admin/spaces?status=all&limit=50&cursor=…` | Admin-only list of opaque space IDs and minimal activation metadata using bounded keyset pagination |
| `PATCH` | `/v1/instance-admin/spaces/:serverId/activation` | Admin-only activation or deactivation with a required audited reason |
| `GET` | `/v1/instance-admin/spaces/:serverId/audit?limit=50&cursor=…` | Admin-only paginated host and space audit entries without message or encrypted space content |
| `GET` | `/v1/instance-admin/report-keys` | Admin-only list of active and retired public-key IDs |
| `POST` | `/v1/instance-admin/report-keys` | Admin-only registration and activation of an RSA public key |
| `GET` | `/v1/instance-admin/audit` | Admins read the full instance audit log; Moderators receive only report/account moderation events |
| `GET` | `/v1/instance-admin/operations` | Admin-only on-demand, read-only service, database, and storage snapshot |
| `GET` | `/v1/instance-admin/operations/overview` | Admin-only aggregate account, community, activity, moderation, and live-connection counts |
| `GET` | `/v1/instance-admin/operations/live` | Admin-only live process/host CPU and RAM metrics |
| `GET` | `/v1/instance-admin/maintenance/summary` | Admin-only aggregate quarantine and recovery status |
| `POST` | `/v1/instance-admin/maintenance/preview` | Admin-only storage scan and aggregate eligible-file estimates |
| `POST` | `/v1/instance-admin/maintenance/quarantine` | Admin-only fresh-scan, recheck, and quarantine of up to 500 eligible files |
| `POST` | `/v1/instance-admin/maintenance/restore` | Admin-only restore of up to 500 quarantined files |
| `POST` | `/v1/instance-admin/maintenance/purge` | Admin-only permanent deletion of up to 500 expired quarantined files |
| `GET` | `/v1/instance-admin/operators` | Admin-only list of host operators (bounded to 200) |
| `POST` | `/v1/instance-admin/operators` | Admin-only create an Admin or Moderator identity |
| `PATCH` | `/v1/instance-admin/operators/:operatorId` | Admin-only change role or enable/disable an operator; protected against self-change and removing the last active Admin |
| `GET` | `/v1/instance-admin/operators/audit?limit=50` | Admin-only, bounded recent operator access history |

Operations and maintenance endpoints require an Admin-role host-operator cookie. The snapshot endpoint returns database
sizes and approximate row counts, plus aggregate storage-integrity totals. The live endpoint returns
CPU percentages (app-process CPU normalized against OS-reported logical cores and host-wide CPU),
RAM, uptime, and load averages; the console samples it every three seconds while Operations is open.
Operations APIs never return file paths, storage keys, file names, or stored message/attachment content.
The overview reports an exact total chat-account count (host operators are excluded because their
identities are stored separately), exact space/active-room and moderation totals, and PostgreSQL
estimates for message and upload records. “Authenticated in last 24h” counts distinct chat accounts
with an unexpired session used during that window; it is an activity proxy, not proof of human
activity. Connected users are distinct chat accounts with active authenticated WebSockets across
app processes; socket leases renew every 15 seconds and expire within 45 seconds after a process
stops renewing. A user with multiple tabs counts once as connected and multiple times in the socket
total. The dashboard refreshes aggregate counts every 30 seconds while visible. Only hashed account
identifiers and opaque connection IDs are held in Redis for the short connection-lease window; no
identifiers are returned by the API. The overview includes seven database-calendar-day counts for
new accounts, message envelopes, attachments, and custom emoji records; these are record counts only
(attachment records include pending uploads), are cached for up to one minute, and require the
activity indexes from migration `023_operations_activity_indexes.sql`. The live CPU/memory chart is
sampled by the page every three seconds and kept only in browser memory until the page is closed.
Files newer than one hour are excluded from likely-orphan totals; incomplete scans report warnings
instead of claiming a complete missing-file count. Operations is read-only and does not alter
application content or files.

Host user management is available only to host operators and searches chat-account username and
display-name prefixes of at least two characters (select the search field). Results use indexed,
bounded keyset pagination in the matching prefix order;
the directory does not compute a full matching-account count or use offset scans. Host operator
identities remain separate. An instance ban blocks future sign-ins,
deletes existing chat sessions and push subscriptions, and closes active chat sockets. Restoring a
ban permits a later sign-in but does not restore deleted sessions. Instance warnings are separate
from space moderation and do not restrict access. Both warning scopes store a moderator-supplied
reason and optional expiry, preserve revoked/expired history, and expose unacknowledged notices only
to the affected user. Space warning creation and revocation use the `warn_members` and
`revoke_warnings` permissions (or legacy `manage_members`) and are included in the space audit log.
Unacknowledged space warnings are also available across all of a user's spaces so they remain visible
in chat even while the user is viewing a direct conversation or is no longer an active space member.
An instance-wide send timeout blocks a chat account from uploading or sending encrypted message
envelopes in all spaces and direct conversations until expiry or moderator removal; the account can
still sign in, read history, and receive realtime messages. Timeout replacement, removal, reason, and
expiry are recorded in moderation history. Moderation reasons are administrative records, not chat
messages; no encrypted message content or report evidence is returned by these routes.

The host Spaces page shows opaque IDs, active-member totals, activation status, and paginated safe
audit metadata only; decrypted space names are never requested or displayed. Deactivation is a
reversible access freeze: existing members cannot read, send, upload, or use realtime in the space,
and new members cannot join through invites. Data and memberships are retained, and reactivation
restores access. Existing members continue to see a deactivated space in their space switcher and
receive a status-only page when selecting it; room, message, and realtime access remains blocked.
Every host activation change records the operator, reason, action, and timestamp in the selected
space's audit history alongside ordinary space audit entries.

### User warning endpoints

These endpoints use the affected chat user's session, not a host-operator session:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/me/instance-warnings` | Read unacknowledged instance warnings |
| `PATCH` | `/v1/me/instance-warnings/:warningId/acknowledge` | Acknowledge an instance warning owned by the signed-in user |
| `GET` | `/v1/me/server-warnings` | Read unacknowledged space warnings across spaces |
| `PATCH` | `/v1/me/server-warnings/:warningId/acknowledge` | Acknowledge a space warning owned by the signed-in user |

Storage maintenance is available separately to authenticated host operators. Only unreferenced files
at least 24 hours old are eligible; quarantine is blocked unless database references and both
filesystem scans are complete, and the quarantine action repeats the scan and rechecks each file's
references and identity immediately before moving it. Each action handles at most 500 files. Files
are moved into a reserved quarantine directory on the same filesystem, remain recoverable for 30
days, and can only be permanently purged by a separate manual action after expiry. Restore and purge
never overwrite or follow non-regular files. Maintenance API responses contain aggregate counts and
bytes only—never storage paths, keys, or file names—and actions are recorded in the instance admin
audit log.

Report detail views, evidence-access actions, report status changes, message removal, account
suspension/restoration, key creation, and storage maintenance are recorded with actor, action,
applicable references, and timestamps. Maintenance audit details contain aggregate counts and bytes
only—not storage keys, paths, file names, message plaintext, or report evidence. The host operator
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
| `GET` | `/v1/servers` | List memberships, including deactivated spaces with their `deactivatedAt` status |
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
| `GET` | `/v1/servers/:serverId/moderation` | Read active bans/timeouts and warning history (view moderation records) |
| `POST` | `/v1/servers/:serverId/members/:userId/warnings` | Issue a space warning (warn members) |
| `DELETE` | `/v1/servers/:serverId/warnings/:warningId` | Revoke a space warning (revoke warnings) |
| `POST` | `/v1/servers/:serverId/members/:userId/ban` | Ban a member from the space, optionally with an expiry |
| `DELETE` | `/v1/servers/:serverId/bans/:userId` | Revoke a space ban (unban members) |
| `POST` | `/v1/servers/:serverId/members/:userId/timeout` | Apply a space timeout with a duration and optional reason |
| `DELETE` | `/v1/servers/:serverId/timeouts/:userId` | Remove a space timeout (remove timeouts) |
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
| `GET` | `/v1/servers/:serverId/channels` | List ordered active text and voice channels, including each channel's `kind` |
| `POST` | `/v1/servers/:serverId/channels` | Create a channel (owner/admin); `kind` is `text` by default or `voice` |
| `PATCH` | `/v1/servers/:serverId/channels/:channelId` | Replace metadata, category, or `position` |
| `DELETE` | `/v1/servers/:serverId/channels/:channelId` | Archive a channel |

The original text channel created with a server is retained as the reference client's encrypted
metadata anchor; it cannot be archived. The server also always retains at least one active channel.

Every channel includes a `conversationId`. This is the E2EE room identity and is used with
the generic conversation endpoints below. It is distinct from the channel ID so a future
frontend can keep navigation and cryptographic room state separate.

Category IDs and channel ordering are server-visible for navigation. Category names and
descriptions remain inside `encryptedMetadata`; the reference browser client encrypts
category metadata in the first active channel room.

Voice channels use the same channel authorization and conversation membership as text channels.
They are selected and opened like rooms but do not expose a message composer in the reference UI.
Message history and sends are disabled for voice channels. The LiveKit room and access tokens are
created only when a member joins.

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

The browser may send `{"type":"voice.signal","conversationId":"…","ciphertext":"…"}` for
direct-call signaling or voice-room key exchange. `ciphertext` is encrypted by the client inside the
conversation before it reaches the server or Redis; the server checks direct-call membership or
active voice-channel access before publishing it.

## Voice

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/voice/token` | Issue a short-lived, microphone-only token for an authorized two-person direct call |
| `POST` | `/v1/voice/check` | Recheck direct-call access during a call |
| `POST` | `/v1/voice/room-token` | Issue a short-lived, microphone-only token for an accessible voice channel; `canStart` elects one client to initialize an empty room |
| `POST` | `/v1/voice/room-check` | Recheck voice-channel access during a room session |

Voice-room tokens do not contain the end-to-end encryption key. The client shares that key only in
encrypted channel signaling. Naigi does not impose a voice-room participant limit; LiveKit deployment
capacity applies. The server receives no room media key and cannot decrypt audio.

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

`POST /v1/crypto/send-to-device/:eventType/:transactionId` accepts at most 100 recipient
users, at most 100 devices per recipient, and at most 200 device events in total. A single
event larger than 64 KiB is rejected with `413 to_device_event_too_large`; exceeding the
recipient, device, or event counts returns `400 invalid_to_device_message`.
