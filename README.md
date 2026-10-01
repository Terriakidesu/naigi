# Naigi

**Self-hosted, privacy-focused chat—with encrypted conversations, spaces, media, and voice.**

Naigi puts your chat infrastructure under your control. Browser clients encrypt messages and
room metadata before upload; the backend handles authentication, authorization, delivery, and
opaque encrypted storage. Private chat keys and the local encryption passphrase stay in the browser.

[Quick start](#quick-start) · [Features](#features) · [History recovery](#history-recovery) ·
[Documentation](#documentation) · [Changelog](CHANGELOG.md)

## Features

### Conversations and media

- End-to-end encrypted direct conversations and invite-only spaces with text and voice rooms.
- Safe Markdown, replies, reactions, custom emoji, and encrypted photos, videos, and files.
- Selecting composer text opens an icon-only formatting toolbar. Use Ctrl/⌘+B for bold,
  Ctrl/⌘+I for italic, Ctrl/⌘+Shift+X for strikethrough, and Ctrl/⌘+Shift+S for spoilers.
- Cursor-based older-message loading, encrypted local message caching, and draft preservation
  while navigating.
- Compact same-space message references that show the room name and jump to the linked message.
- Private recipient discovery limited to active members of a shared space—no global user directory.

### Spaces and moderation

- Ordered rooms and categories, permission-aware drag sorting, and a styled room-creation dialog
  with text/voice choices and category selection.
- Role hierarchies, room access controls, list-first role management, and anchored member-role pickers.
- Searchable management lists and compact member action menus for profiles, direct messages,
  blocking, role assignment, warnings, timeouts, kicks, bans, and copying user IDs.
- Encrypted space names, descriptions, welcome text, rules, and custom emoji metadata.
- Custom emoji previews and renaming without reuploading encrypted images.
- Separate space moderation and host-operator administration, with permission restrictions and audit logs.

### Voice and audio

- Encrypted one-to-one audio calls and joinable space voice rooms through a self-hosted LiveKit relay.
- Microphone/output selection, input/output volume, local per-participant mute and volume,
  a silence threshold, and a local microphone test.
- Page-focused push-to-talk; manual mute takes priority over push-to-talk.
- Speaker activity, voice-room membership in the sidebar, permanent footer audio controls,
  and in-room controls with disconnect kept separate.
- Automatic voice-room rejoining after reload or connection recovery, retaining tab-local audio
  choices. Leaving, locking, or losing room access cancels rejoining.

### Settings and recovery

- Profile, account security, devices, privacy, blocked users, and local-data management.
- Separate **Appearance**, **Accessibility**, **Chat & media**, **Notifications**, and **Voice & audio**
  settings, including custom themes, interface scale, message text size, and reduced motion.
- Compact account and space settings with close buttons, Escape shortcuts, and unsaved-change guards.
- Trusted-device history approval through a private QR/link and matching verification codes.
- Automatic encrypted room-key backups, restoration with a separate generated recovery key,
  and manual encrypted file export/import.
- Optional remembered local unlock, notification quiet hours, GIF search, and Firebase web push.

See [Features](docs/FEATURES.md), [Voice](docs/VOICE.md), and
[History recovery](docs/history-recovery.md) for details and limitations.

## Quick start

### Requirements

- [Bun](https://bun.sh/).
- Node.js 22.12+ and npm for the shared user frontend.
- PostgreSQL with **two separate databases**: one for chat and one for host-operator identities.
- Redis or Valkey.
- Persistent filesystem storage for attachments and profile images.
- HTTPS for remote access; localhost is suitable for development.

### Configure and run

1. Copy `.env.example` to `.env` and edit the configuration:

   ```bash
   cp .env.example .env
   ```

2. Create the databases named by `DATABASE_URL` and `ADMIN_DATABASE_URL` before migrating.
   The example uses `priv_chat` and `priv_chat_admin`; these must be distinct databases.
   Set `REDIS_URL` for your Redis/Valkey service.

3. Install dependencies, migrate both databases, build the browser client, and start development:

   ```bash
    bun install
    git submodule update --init --recursive
    npm --prefix shared-frontend ci
   bun run db:migrate
   bun run build:client
   bun run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000), register, and choose a local encryption passphrase.
   **This passphrase is separate from your account password and is never sent to the backend.**

For deployment and upgrades, use the [operator setup guide](docs/SETUP.md). Build the client and
apply migrations when upgrading; run `bun run start` rather than the development watcher in production.
The user UI comes from the pinned [naigi-frontend](https://github.com/Terriakidesu/naigi-frontend)
submodule at `shared-frontend/`. After pulling, run `git submodule update --init --recursive`
and `npm --prefix shared-frontend ci` before rebuilding. The instance-admin console remains
in this repository and is built separately by the same `build:client` command. Existing
user files in `client/` are retained during integration, but are no longer the user build source.
Version 0.23.0 adds migration `028_history_recovery` for encrypted backups and temporary device transfers.

### Storage and health

| Service | Responsibility |
| --- | --- |
| App PostgreSQL | Accounts, devices, memberships, permissions, and encrypted messages/backups |
| Admin PostgreSQL | Separate host-operator identities, sessions, and administration data |
| Redis/Valkey | Readiness checks, cross-instance pub/sub, and best-effort realtime notifications |
| `ATTACHMENTS_DIR` | Encrypted chat attachment files |
| `PROFILE_IMAGES_DIR` | Server-managed profile images |

Keep both filesystem directories on persistent storage. There is no object-storage adapter.
Liveness is at `/health/live`; readiness at `/health/ready` checks PostgreSQL and Redis.

## History recovery

Signing in on another device **does not automatically unlock old messages**. The device needs
their room keys; an account password or a new local passphrase cannot recreate missing keys.

Open **Settings → Recovery** and unlock that browser:

1. **Preferred: approve from an existing device.** Request approval on the new device, then scan
   the QR or open the private link on a device that already reads your history. Compare both
   verification codes and approve only a device you control. Requests expire after ten minutes.
2. **Fallback: restore an encrypted backup.** On a trusted device, generate a recovery key,
   save it in a password manager, and enable automatic backup. Enter that key on the new device
   to restore available history keys.
3. **Offline alternative: use a manual file backup.** Export/import a passphrase-protected room-key
   file from the expandable manual section.

Enabled, unlocked devices merge and back up known room keys every minute; **Back up now** performs
an immediate sync. Revision checks prevent silent concurrent overwrites. The server stores only
encrypted backup/transfer payloads, and locally remembered backup data keys are encrypted under the
browser's local passphrase. Recovery secrets are separate from account passwords.

Backups recover **keys**, not deleted messages, and can only include keys known to participating
devices. If every usable device, recovery key, and manual backup is lost, Naigi cannot recover the
history. See [History recovery](docs/history-recovery.md) for the full workflow and security limits.

## Deployment and optional services

### HTTPS and remote devices

Use HTTPS for LAN addresses and remote hosts. Plain HTTP IP origins lack the secure browser APIs
needed for encryption and remembered unlock, and HTTP lets a network attacker replace client code.
Changing `HOST` or `NODE_ENV` does not make an origin secure.

For example, place Naigi behind Caddy and run the app with `HOST=127.0.0.1`:

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

For LAN-only use, choose a trusted TLS certificate or an HTTPS tunnel. An SSH port forward is
another option:

```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
```

Then open `http://localhost:3000` on your own device. Browser storage belongs to the exact origin;
changing domains or ports does not transfer local keys or remembered unlock.

### Optional integrations

| Integration | Configuration | Notes |
| --- | --- | --- |
| Self-hosted LiveKit | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Configure all three to enable voice. Audio frames are encrypted in the client; the relay receives no media keys. Capacity depends on the relay deployment. |
| GIF search | `KLIPY_API_KEY` and/or `GIPHY_API_KEY` | Browser-restricted public keys. Browsers search providers directly; selected GIF bytes use the encrypted attachment flow. Tenor's retired API is not used. |
| Firebase Cloud Messaging | `FCM_SERVICE_ACCOUNT_JSON`, `FCM_WEB_CONFIG_JSON`, `FCM_VAPID_KEY` | Opt-in web push over HTTPS. Keep service-account credentials secret and restrict the web API key to your origin. |

Naigi runs without these integrations. GIF providers can observe searches made to them.
Firebase receives a device registration token and delivery timing, but no message content, room ID,
sender identity, or mention data.

Background push requires browser permission and **All new messages**. **Mentions only** works while
the app is open. The service worker applies browser-local quiet hours; closed-app alerts cannot
apply per-room mutes because Firebase receives no room IDs.

See [Setup](docs/SETUP.md), [Voice](docs/VOICE.md), and [Security](docs/SECURITY.md) before enabling
optional services.

## Privacy and security boundaries

- **Client-side encryption:** Matrix Olm/Megolm through `@matrix-org/matrix-sdk-crypto-wasm`,
  with private state in encrypted IndexedDB. Supported photos are resized/compressed before
  encryption; the server stores encrypted media without inspecting its contents.
- **Server-visible metadata:** account/device identifiers, membership, permissions, ordering,
  and delivery metadata are not hidden by message encryption. Profile images are server-managed;
  not every piece of account information is end-to-end encrypted.
- **Authoritative history:** PostgreSQL stores encrypted message envelopes. Redis and WebSocket
  events are notifications only; reconnecting clients fetch history using cursors.
- **Remembered unlock:** opt-in on HTTPS or localhost, storing encrypted passphrase material and
  a non-extractable Web Crypto key in IndexedDB. Anyone with access to that browser profile may
  then unlock it; use **Forget remembered unlock** on shared devices.
- **External previews:** third-party requests have privacy costs. The optional X/Twitter preview
  exception sends a validated public-post ID to configured providers; see the security guide.
- **Trust limits:** encryption does not protect an unlocked browser from compromised client code
  or a compromised device. Protect TLS, deployment credentials, backups, and browser profiles.

Read the [security and privacy guide](docs/SECURITY.md) for the complete boundaries.

## Host administration

Host operators are separate from space owners and moderators. After migrating, bootstrap an operator:

```bash
bun run admin-users -- create <username>
```

The command prompts for a password without echoing it. Use `enable`, `disable`, or `password`
to manage an operator; password rotation revokes active sessions. For automation, use
`--password-stdin` with two newline-separated password entries—never put passwords in arguments.

| Console | Purpose |
| --- | --- |
| `/instance-admin` | Report review and host moderation |
| `/instance-admin/users` | Account search, warnings, bans, and installation-wide send timeouts |
| `/instance-admin/spaces` | Opaque space IDs, reversible access freezes, and audit history |
| `/instance-admin/operators` | Admin/Moderator identity management |
| `/instance-admin/operations` | Read-only live operations and resource measurements |
| `/instance-admin/maintenance` | Guarded filesystem scans, quarantine, restoration, and manual purge |

Operator identities live only in the admin database and cannot sign in to chat or appear in member
discovery. Moderator operators have restricted permissions; evidence keys, platform controls,
maintenance, and operator management require Admin access.

Reporters may opt in to encrypt details or a selected message excerpt to a host report key. The server
does not decrypt the conversation, and reporter-supplied excerpts are not independently verified.
Keep passphrase-encrypted evidence-key backups offline; the operator browser unlocks private keys
only in memory. Losing every backup makes that evidence unrecoverable.

Account blocking prevents direct conversations and their realtime events in both directions,
but does not hide shared-space activity. Moderation tools and audit logs do not by themselves
guarantee legal compliance. See [Setup](docs/SETUP.md) and [Security](docs/SECURITY.md) for operator details.

## Development

Edit user browser sources in `shared-frontend/` (the shared repository), and server-owned admin sources in `client/`, not generated `public/` assets. Rebuild after browser changes:

```bash
bun run build:client
bun run dev
```

### Verification

```bash
bun run typecheck
bun run test
bun run test:e2ee
```

Focused checks are also available:

```bash
bun run test:history-recovery
bun run test:space-settings
bun run test:create-room
bun run test:member-roles
bun run test:voice-audio
bun run test:composer-formatting
```

The full E2E and history-recovery tests require PostgreSQL, Redis/Valkey, and Playwright Chromium;
they use temporary app/admin schemas. The current full E2E suite still reports two
`404 /v1/crypto/to-device` errors under investigation; passing focused tests is not a substitute
for resolving that failure.

### Local cleanup

**Destructive, development-only:** clears application data while preserving schemas and migrations.

```bash
bun run db:purge -- --yes
```

The purge refuses to run with `NODE_ENV=production` and does not remove files from `ATTACHMENTS_DIR`.

## Documentation

| Guide | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Guides by role |
| [Setup](docs/SETUP.md) | Configuration, deployment, upgrades, and backups |
| [Features](docs/FEATURES.md) | User workflows and current limits |
| [History recovery](docs/history-recovery.md) | Trusted-device approval, encrypted backups, and recovery keys |
| [Voice](docs/VOICE.md) | LiveKit deployment and voice encryption |
| [Security](docs/SECURITY.md) | Privacy boundaries and operator responsibilities |
| [Architecture](docs/ARCHITECTURE.md) | Browser, API, database, Redis, and relay responsibilities |
| [API v1](docs/api-v1.md) | HTTP/WebSocket contracts, device keys, and crypto transport |
| [Changelog](CHANGELOG.md) | Version history and unreleased work |
| [0.23.0 notes](docs/changelogs/0.23.0.md) | Recovery, audio, and settings improvements |

## License

Naigi's original source code is available under the [MIT License](LICENSE).
Third-party dependencies and bundled assets retain their own licenses; Twemoji graphics are
licensed under [CC BY 4.0](client/assets/twemoji/LICENSE-GRAPHICS).
