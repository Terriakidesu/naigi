# priv-chat

An encrypted-first text chat backend built with Bun, Elysia, PostgreSQL, and Redis.

The server stores encrypted message envelopes and public device key material. It does not
accept plaintext message content or implement cryptography.

## Local configuration

Copy `.env.example` to `.env` and set credentials for the PostgreSQL and Redis instances
running on your machine. PostgreSQL and Redis are used as follows:

- PostgreSQL stores accounts, devices, memberships, and encrypted messages.
- Redis is used for readiness checks, cross-instance pub/sub, and best-effort realtime notifications.

Run the initial schema migration before starting the server:

```bash
bun run db:migrate
bun run dev
```

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

## Encryption boundary

The message endpoint accepts only base64url-encoded ciphertext, protocol identifiers, and
opaque protocol metadata. Text, URLs, embed previews, photo keys, and other user content
must be encrypted by a client before they reach this server. No cryptographic protocol is
implemented in the backend.

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
