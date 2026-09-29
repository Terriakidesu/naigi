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
- Voice calls currently cover direct one-to-one audio only. They do not support space voice rooms,
  video calls, or host-tuned adaptive quality.

## Operator checklist

- Terminate TLS at a trusted reverse proxy; keep PostgreSQL, Redis/Valkey, and the app port private.
- Store database passwords, LiveKit secrets, FCM service-account credentials, and report-key backups
  outside source control. Restrict file and backup access.
- Keep the chat database and host-operator database separate. Provision the first Admin using
  `bun run admin-users`; do not use a regular chat account for host administration.
- Back up both databases and persistent media directories. Verify restore procedures before relying
  on backups; encrypted attachments are useful only alongside their database references and the
  recipients' decryption keys.
- Keep Bun and dependencies patched, limit exposure of optional provider keys, and monitor the health
  endpoints without logging request bodies or decrypted browser content.

For the exact API and payload boundaries, see [API v1](api-v1.md). When reporting a suspected
vulnerability, avoid including real user content, credentials, or private keys in public reports.
