# How Naigi E2EE works

Naigi uses end-to-end encryption in the browser. The browser performs the cryptographic work with Matrix Olm/Megolm through `@matrix-org/matrix-sdk-crypto-wasm`; the backend stores, authorizes, orders, and delivers opaque encrypted data.

The same encrypted conversation mechanism is used for:

- 1-to-1 conversations
- Group conversations
- Space channels
- Encrypted space, channel, category, and role metadata

The difference between a direct conversation and a space channel is primarily the server-side membership and permission layer around the encrypted room.

## 1. Account authentication and local encryption are separate

Naigi has two separate secrets.

### Account password

The account password is used by the backend for authentication. It creates an authenticated HTTP session, normally represented by the `HttpOnly` `priv_chat_session` cookie.

The account password is not used to encrypt messages.

### Local encryption passphrase

The local encryption passphrase exists only in the browser. It unlocks the Matrix crypto store when the client initializes the `OlmMachine`:

```ts
OlmMachine.initialize(
  userId,
  deviceId,
  storeName,
  localPassphrase,
)
```

The passphrase is never sent to the backend.

The Matrix crypto state is kept in an encrypted IndexedDB store. This includes private identity keys, device keys, room sessions, and other cryptographic state.

The optional “Remember this device” feature stores an AES-GCM-encrypted copy of the local passphrase in a separate IndexedDB store. It is opt-in because anyone who can use that browser profile may then be able to unlock the local crypto store.

## 2. Each browser is a separate cryptographic device

Every browser receives its own device ID. Naigi maps the account and conversation identifiers into Matrix-style identifiers:

```text
User:   @<user UUID>:priv-chat
Device: <browser device UUID>
Room:   !<conversation UUID>:priv-chat
```

Opening Naigi in two browsers creates two devices for the same account. Each device has its own private keys and must receive the appropriate room keys.

The backend stores public device material such as:

- Device identity keys
- Signed prekeys
- One-time prekeys
- Fallback keys

Private keys never leave the browser’s encrypted crypto store.

The backend also records which authenticated account owns each device. This lets the message endpoint reject a request that tries to claim another user’s device ID.

If the browser loses the local device-ID value but retains its encrypted IndexedDB store, the client can compare authenticated device records and try to recover the original device ID.

## 3. Initial key exchange

When `CryptoClient` starts, the Matrix SDK may create outgoing requests for:

- Uploading public device keys
- Uploading one-time keys
- Uploading fallback keys
- Querying other users’ device keys
- Claiming one-time or fallback keys
- Sending encrypted to-device events

The client forwards those requests through these endpoints:

```text
POST /v1/crypto/keys/upload
POST /v1/crypto/keys/query
POST /v1/crypto/keys/claim
POST /v1/crypto/send-to-device/:eventType/:transactionId
GET  /v1/crypto/to-device?deviceId=...
POST /v1/crypto/to-device/ack
```

The server authenticates the HTTP request, validates the shape and ownership of the device data, and stores or returns it. It does not perform the Olm or Megolm operations.

### Olm

Olm is used for device-to-device communication, especially distributing room keys to individual devices.

### Megolm

Megolm is used for messages inside a conversation room. It is efficient for two-person, group, and space conversations because a room session can encrypt many events while room keys are distributed separately to participant devices.

The client configures the room with:

```text
Algorithm: MegolmV1AesSha2
History visibility: Shared
Rotation: 100 messages or 7 days
```

## 4. Preparing a conversation

Before sending or decrypting a conversation, the client calls:

```ts
prepareConversation(conversationId, members)
```

This is used for both DMs and space channels.

The client:

1. Fetches the current conversation members from the server.
2. Converts them into Matrix user IDs.
3. Adds the current user’s own Matrix user ID.
4. Configures the Matrix room.
5. Marks participant devices for key discovery.
6. Queries public device keys.
7. Claims one-time or fallback keys when necessary.
8. Shares the Megolm room key with all participant devices.
9. Processes pending encrypted to-device events.

The reference client uses the Matrix SDK’s `CollectStrategy.allDevices()`, so a participant’s active browsers can all receive the room key.

The server sees public key material and encrypted transport envelopes, but not private keys or plaintext room keys.

## 5. Sending a text message

Suppose Alice writes:

```text
Hello Bob
```

The text exists in the browser first. The client constructs a content object similar to:

```json
{
  "msgtype": "m.text",
  "body": "Hello Bob",
  "embeds": [],
  "mentions": []
}
```

Replies, mentions, URLs, embed data, edits, reactions, pins, and related message metadata are also placed inside the content object before encryption.

The client then asks the Matrix SDK to encrypt the room event:

```ts
encryptRoomEvent(
  roomId,
  "m.room.message",
  JSON.stringify(content),
)
```

The SDK returns encrypted Megolm content. The client wraps it in an encrypted Matrix event:

```json
{
  "type": "m.room.encrypted",
  "content": {
    "...": "encrypted Megolm payload"
  },
  "sender": "@alice:priv-chat",
  "room_id": "!conversation-id:priv-chat"
}
```

The event is serialized and base64url-encoded. The message request sent to the backend looks like:

```json
{
  "senderDeviceId": "device-uuid",
  "clientMessageId": "message-uuid",
  "protocol": "matrix-v1",
  "ciphertext": "base64url ciphertext"
}
```

The backend never receives the plaintext body.

## 6. What the server does with a message

The message endpoint performs server-side checks before storing the envelope:

- Authenticated session
- Conversation membership
- Space/channel visibility
- Send-message permission
- Timeout or moderation restrictions
- Sender-device ownership
- Base64 and size validation
- Duplicate client-message detection

It then stores the opaque values in PostgreSQL:

```text
conversation_id
sender_device_id
client_message_id
protocol
ciphertext
protocol_metadata
server_sequence
created_at
```

The backend does not parse the Matrix event, decrypt it, or inspect its content.

The server assigns a monotonically ordered `server_sequence`. This gives clients a reliable cursor for history synchronization without requiring the backend to understand the message.

## 7. Realtime delivery and history synchronization

PostgreSQL is the authoritative message store. Redis and WebSockets are only used for notifications.

After storing a message, the server publishes a notification such as:

```json
{
  "type": "message.created",
  "conversationId": "...",
  "messageId": "...",
  "serverSequence": "42"
}
```

The notification does not contain the ciphertext or plaintext.

The recipient’s client then requests the encrypted envelope from:

```text
GET /v1/conversations/:conversationId/messages
```

The client:

1. Base64-decodes the ciphertext.
2. Reconstructs the encrypted Matrix event.
3. Passes it to `decryptRoomEvent`.
4. Uses the local Megolm room session.
5. Receives the plaintext event content.
6. Renders the result in the browser.

If realtime is unavailable, history still works through PostgreSQL cursors. On reconnect, the client fetches messages after its latest known sequence instead of trusting Redis as the source of truth.

## 8. One-to-one conversations

A direct conversation is represented as:

```text
conversation.kind = "dm"
```

The server requires exactly one other member. It also prevents arbitrary global user discovery: the creator and recipient must share an active space when the DM is created.

The server serializes DM creation for a pair so two simultaneous requests do not create duplicate direct-message rooms.

The DM then follows the ordinary conversation flow:

```text
Alice device(s) + Bob device(s)
              ↓
       Megolm room session
              ↓
       encrypted room events
```

When Alice sends a message:

1. Alice’s browser encrypts it with the DM’s Megolm room session.
2. The backend stores the opaque ciphertext.
3. A realtime notification is sent to Bob’s authorized user channel.
4. Bob’s browser downloads the ciphertext through the history API.
5. Bob’s local crypto store decrypts it.

Bob’s other active browsers can decrypt the conversation because the room key is distributed to all of Bob’s devices.

The shared-space requirement is primarily a server-side recipient-discovery and authorization boundary. The actual message encryption still happens locally in the two participants’ browsers.

## 9. Space channels

A space channel is represented as a conversation with:

```text
conversation.kind = "channel"
```

Each channel has two identifiers:

```text
channel.id             navigation and authorization ID
channel.conversationId E2EE room identity
```

The `conversationId` is used for encryption, messages, attachments, membership, and realtime subscriptions.

Every channel has its own room identity and room session. For example:

```text
#general → Room A → Megolm session A
#private → Room B → Megolm session B
#staff   → Room C → Megolm session C
```

A user who can access one channel does not automatically receive the room key for another channel.

### Server-side channel membership

The backend calculates channel access from:

- Active space membership
- Assigned roles
- `view_channels`
- Per-role channel access
- Owner protection
- Moderation state

It synchronizes authorized users into `conversation_members`. This controls whether a user can:

- Fetch encrypted history
- Subscribe to realtime notifications
- Send messages
- Upload attachments

These are server authorization checks. They do not decrypt the channel.

### Space metadata

Space and channel names are encrypted metadata, not plaintext fields.

For example, the client may encrypt a metadata content object containing:

```json
{
  "msgtype": "m.priv-chat.metadata",
  "body": "{\"name\":\"general\",\"kind\":\"text\"}"
}
```

The encrypted result is stored in fields such as:

```text
servers.encrypted_metadata
channels.encrypted_metadata
categories.encrypted_metadata
server_roles.encrypted_metadata
```

The server stores and returns those fields as opaque bytes.

The first active channel acts as the metadata anchor for space-level metadata such as:

- Space name
- Category names
- Role names

The client decrypts that metadata after preparing the appropriate room.

Role permissions, role hierarchy, role colors, channel IDs, category IDs, and ordering remain server-visible because the backend needs them to enforce authorization and construct navigation.

## 10. New members and removed members

When a new space member joins:

1. The backend adds the member to the space.
2. The backend adds the member to channels allowed by their roles.
3. The client discovers the updated conversation member list.
4. Existing clients prepare the room again.
5. The Matrix SDK shares current room keys to the new member’s devices.

The API does not decrypt or replay old plaintext history for the new member.

When a member is removed:

1. The backend marks their space membership inactive.
2. Their channel conversation membership becomes inactive.
3. Future history, message, attachment, and realtime requests are rejected.
4. Any ciphertext, plaintext, or room keys already present on that device remain there.

Server-side removal cannot remotely erase keys from a device that already received them.

Strict exclusion from future messages requires room-key rotation after membership changes. The client has scheduled Megolm rotation after 100 messages or 7 days, and the API documentation requires frontends to rotate room keys when membership changes. Authorization removal by itself is not retroactive cryptographic revocation.

## 11. Encrypted media

Media uses a separate attachment-encryption layer before the encrypted message layer.

Before upload:

1. The browser optionally resizes or compresses an image.
2. The browser encrypts the bytes with the Matrix attachment API.
3. The client receives encrypted bytes and media encryption information.
4. The encrypted bytes are uploaded to the backend.
5. The media encryption information is placed inside the encrypted message content.

The message content is similar to:

```json
{
  "msgtype": "m.image",
  "filename": "private-photo.jpg",
  "info": {
    "mimetype": "image/jpeg"
  },
  "file": {
    "url": "/v1/attachments/<id>",
    "...": "media encryption information"
  }
}
```

That complete object is then encrypted with Megolm. The filename and media key are not sent as plaintext message fields.

When displaying the media:

1. The client decrypts the message event.
2. It extracts the attachment URL and media encryption information.
3. It downloads the encrypted bytes.
4. It decrypts them locally.
5. It creates a browser Blob for display.

The backend never receives the media key or clear media bytes.

The backend can still see limited transport metadata:

- Attachment ID
- Encrypted byte size
- Declared MIME type
- File extension
- Upload time
- Owning conversation

## 12. Offline sending and browser caching

If encryption succeeds but the backend is temporarily unavailable, the client stores the already-encrypted message in the IndexedDB outbox.

The outbox contains:

- Conversation ID
- Sender device ID
- Client message ID
- Protocol identifier
- Ciphertext
- Attachment ID, if applicable

It does not contain the plaintext message body.

The message-history cache also stores encrypted envelopes only. Plaintext is created only after the local crypto client decrypts an envelope for rendering.

## 13. What the server can see

The server can see:

- Account IDs, usernames, and profile display names
- Space membership
- Conversation membership
- Whether a conversation is a DM, group, or channel
- Space, channel, category, and role IDs
- Role permissions and hierarchy
- Channel ordering
- Message timestamps and sequence numbers
- Sender device and sender account
- Ciphertext sizes
- Attachment MIME type, extension, size, and timing
- Presence, typing, and realtime subscriptions
- Whether a user is allowed to fetch or send

The server also performs moderation and authorization using this visible metadata.

## 14. What the server cannot see from encrypted payloads

The server cannot read from the encrypted message or metadata payloads:

- Message text
- Message URLs
- Embed data
- Reply text
- Message mentions
- Encrypted space, channel, or category names
- Encrypted role names
- Attachment filenames inside message content
- Media encryption keys
- Image, video, or file contents
- Plaintext message edits, reactions, pins, and redactions

Account profile display names and membership data are not E2EE-hidden; they are needed for account management and authorization.

## 15. Trust limitations

This implementation protects message content from ordinary backend storage, database, attachment-storage, and transport inspection. It does not solve every trust problem.

### The browser client must be trusted

If a malicious server operator changes the JavaScript bundle, the altered client could capture plaintext or private keys. HTTPS protects against a network attacker replacing the client during delivery, but a compromised server can still serve compromised application code.

### Devices are not manually verified by users

The client is configured to allow untrusted devices:

```ts
onlyAllowTrustedDevices = false
TrustRequirement.Untrusted
```

There is no user-facing safety-number or fingerprint-verification flow. This is more usable, but it means users are not required to manually verify every device out of band.

### Relationship metadata remains visible

E2EE hides content, not the membership graph required for server authorization. The server still knows which accounts share spaces and conversations.

### Membership removal is not cryptographic deletion

Removing a member blocks future server access, but it cannot erase plaintext or keys that the member’s device already received. Room-key rotation is required for strong post-removal exclusion.

## End-to-end summary

```text
User types plaintext
        ↓
Browser constructs message content
        ↓
Olm/Megolm encryption in the browser
        ↓
Opaque ciphertext envelope
        ↓
Authenticated server authorization and storage
        ↓
Opaque ciphertext notification/history delivery
        ↓
Recipient browser downloads ciphertext
        ↓
Recipient’s local Olm/Megolm store decrypts it
        ↓
Recipient sees plaintext
```

For a 1-to-1 conversation, the participants are the two users and all of their active devices. For a space channel, the same cryptographic room flow is surrounded by server-side role, channel-visibility, upload, moderation, and membership checks.

Relevant implementation areas are:

- `client/crypto.ts` — browser Matrix Olm/Megolm adapter
- `client/main.ts` — conversation preparation, sending, receiving, and metadata handling
- `client/message-cache.ts` — encrypted history cache
- `client/outbox.ts` — encrypted retry queue
- `src/app.ts` — authentication, authorization, crypto transport, message storage, and attachments
- `src/realtime.ts` — notification-only WebSocket subscriptions
- `src/db/migrations/001_initial.sql` — conversations, devices, messages, and memberships
- `src/db/migrations/003_crypto_transport.sql` — public device keys and encrypted to-device events
- `src/db/migrations/005_servers_channels.sql` — spaces and channels
- `src/db/migrations/008_server_roles.sql` — role and channel-access data
