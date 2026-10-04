# Security and privacy

Naigi is designed so the backend stores and delivers encrypted conversation content without
implementing message cryptography. That does not make every datum private from the host or protect a
compromised browser. This guide summarizes the intended boundary and operator responsibilities.

## What is encrypted end to end

- Conversation message bodies, replies, mentions, reactions and other message payloads.
- Chat attachments, including images and videos, before they are uploaded.
- Space/channel/category/role names and other metadata carried through the client crypto protocol.
- Direct-call signaling and the audio media key. LiveKit audio frames are encrypted in the browser
  before they are sent to the relay.
- Optional report details or selected message excerpts only when the reporter opts in; the browser
  encrypts that evidence to the host-managed report public key.

The local crypto passphrase is never sent to the server. The browser keeps private crypto state in
its encrypted IndexedDB store. Optional remembered unlock is still local to that browser profile and
should not be enabled on shared devices.

## What services can still observe

The Naigi server needs and can observe account usernames/display names, account and session state,
conversation/space/channel IDs, membership, roles and access configuration, message ordering, message
and attachment sizes, timestamps, and network/request metadata. Channel labels may be encrypted,
but IDs and access configuration are not hidden. Realtime, database, and application operators can
observe their service metadata.

Profile avatars and banners are server-managed profile media, not encrypted conversation
attachments. Assume the service can access those files; do not use them for content that requires
chat-message E2EE.

Optional integrations add their own visibility:

- GIF searches and downloads contact the configured provider directly from the browser. The provider
  receives search terms and network metadata.
- The X/Twitter preview exception sends a validated numeric public-post ID to the configured
  server-side provider. The resulting card is encrypted by the browser before it enters chat.
- Firebase Cloud Messaging receives a device registration token and delivery timing. Message text,
  room IDs, sender identity, and mention data are not included in the push payload.
- LiveKit sees participant network addresses, call timing, traffic volume, and encrypted audio frames.
  A TURN server may relay packets but does not receive the media key.

## Blocks and profile media

A block is enforced on conversation content, direct-message creation, voice access, attachments, and
now profile media. Reading your own avatar or banner is unaffected. Profile images remain readable by
other members of a space you share, so a block is a boundary between two people rather than a way to
hide an image from an entire server.

## Trust assumptions and limitations

- Use HTTPS for every remote browser session. On plain HTTP, a network attacker could replace the
  JavaScript client before it encrypts or decrypts messages. Localhost is suitable only for local
  development.
- A self-hosting operator controls the server and the browser code it serves. A malicious or
  compromised server can deliver altered client code, deny service, observe metadata, or change
  authorization. E2EE does not protect against a compromised endpoint or client device.
- Conversation recipients can copy, screenshot, record, or share content after decrypting it.
- Lost browser data or crypto keys may make old messages unreadable. Password reset does not recover
  encryption keys. Users should create and safely store the encrypted room-key recovery export where
  available.
- Host report-evidence private keys are separate from chat keys. Keep their encrypted backup and
  passphrase offline and separate; losing the private key prevents evidence recovery.
- Voice supports direct one-to-one calls and joinable space audio rooms. It does not include video
  calls or host-tuned adaptive quality. A room key is shared with members who can access the voice
  channel; removing a member cannot revoke keys already obtained by that member.

## Operator checklist

- Terminate TLS at a trusted reverse proxy; keep PostgreSQL, Redis/Valkey, and the app port private.
  Redis holds the authentication rate-limit counters and notification fan-out, so a remote Redis must
  be reached over `rediss://`; the app refuses to start otherwise in production. Redis is also a hard
  dependency for authentication, since limiting fails closed rather than admitting an unthrottled
  attempt.
- Store database passwords, LiveKit secrets, FCM service-account credentials, and report-key backups
  outside source control. Restrict file and backup access.
- Keep the chat database and host-operator database separate. Provision the first Admin using
  `bun run admin-users`; do not use a regular chat account for host administration.
- Back up both databases and persistent media directories. Verify restore procedures before relying
  on backups; encrypted attachments are useful only alongside their database references and the
  recipients' decryption keys.
- Keep Bun and dependencies patched, limit exposure of optional provider keys, and monitor the health
  endpoints without logging request bodies or decrypted browser content.

## Browser protections

Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and a `Permissions-Policy` that grants only the microphone, which
encrypted voice rooms need. HSTS is added only when the request actually arrived over HTTPS, since
sending it over plain HTTP is ignored by browsers and misleading in a log.

State-changing requests are additionally refused with `403 cross_origin_request_rejected` when the
browser identifies them as cross-origin, via `Sec-Fetch-Site` or an `Origin` comparison. This is
the second layer behind the `SameSite` cookies, not a replacement: `SameSite=Lax` already blocks a
cross-site form post. A request that carries neither header is allowed, because native clients send
neither. The WebSocket upgrade applies the same comparison, which closes cross-site socket hijacking
for clients that would otherwise attach a session to a foreign page.

Content Security Policy is emitted **report-only** in this release. The Olm/Megolm adapter is
WebAssembly and LiveKit runs a worker, so the policy must permit `wasm-unsafe-eval` and
`worker-src blob:`; a mis-scoped directive would otherwise break message decryption or calling
outright. Enforcement should follow once the collected reports are clean.

`Set-Cookie` carries `Secure` whenever the request arrived over HTTPS rather than whenever
`NODE_ENV=production`, so an HTTPS instance outside production is protected too. Plain HTTP yields
no `Secure` attribute, because a browser discards such a cookie and local development would break.

## Throttling and rate limiting

Login, registration, admin login, and password change are throttled to resist credential stuffing and
brute force. Two independent budgets apply:

- A per-account budget counts **failed** attempts only, so a legitimate user is never locked out by
  their own successful logins. Unknown usernames are charged identically to real ones, so the
  response cannot be used to test whether an account exists.
- A per-IP budget counts **every** attempt, which bounds the password-hashing work an unauthenticated
  caller can force the server to perform.

Refused requests carry a `Retry-After` header. A limiter that cannot reach Redis fails **closed** on
authentication routes: they return `503 auth_temporarily_unavailable` rather than admitting an
unthrottled attempt. Redis is therefore a required dependency for authentication, which matches
`/health/ready` already reporting `503` while Redis is down. Registering also rejects passwords that
lead public credential-stuffing lists or that are derived from the username or display name.

Counters are namespaced by instance, derived from the database host, port, and name, so deployments
that share one Redis do not spend each other's budget. No credential is ever placed in a key.

Budgets are fixed in code rather than configurable, so the values cannot be widened by an
environment mistake. Registration allows 5 accounts per address per hour, user login allows 30
attempts per address and 10 failures per account per 15 minutes, admin login is stricter at 10 per
address and 5 failures per account, and password change allows 5 attempts per account.

Two consequences worth planning for:

- Per-IP limits resolve the client address from `X-Forwarded-For` **only** when
  `TRUSTED_PROXY_HOPS` is set to the number of proxies that append to that header. Left at `0`, the
  header is ignored and the transport address is used, so a client cannot spoof its address to evade a
  budget. Getting this wrong is the difference between per-IP limits that work and limits that a
  determined caller can bypass with one header.
- Because a per-account budget refuses even a correct password once the failure count is reached, an
  attacker who knows a victim's username can deny that victim *new* logins for the length of the
  window. Existing sessions are unaffected and the lockout expires on its own.

For the exact API and payload boundaries, see [API v1](api-v1.md). When reporting a suspected
vulnerability, avoid including real user content, credentials, or private keys in public reports.
