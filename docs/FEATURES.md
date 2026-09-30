# Features

Naigi is a self-hosted chat application with browser-side end-to-end encryption. Use the [setup
guide](SETUP.md) to deploy it and [security and privacy](SECURITY.md) to understand what the server
and connected services can observe.

## Conversations and spaces

- Create direct and group conversations. Private recipient discovery is limited to active members of
  a shared space; there is no global account search.
- Create invite-only spaces with text channels, categories, invitations, roles, and channel/category
  access rules.
- Use encrypted messages with replies, edits, deletions, reactions, pins, search, mentions, and
  channel references.
- Space owners and moderators have space-scoped management tools. Host operators use a separate
  `/instance-admin` console for installation-wide moderation and operations.

## End-to-end encrypted content

- Conversation messages are encrypted in the browser using the Matrix Olm/Megolm WASM adapter.
  Private device keys and crypto state stay in the browser's encrypted local store.
- Attachments are encrypted before upload. Images can be resized/compressed in the browser; videos
  and other files use the same encrypted attachment flow.
- Server, channel, category, and role labels are client-encrypted metadata. The server still sees
  conversation and space IDs, membership, role/access configuration, and traffic metadata.
- Account names, usernames, profile images, and banners are account/profile data, not encrypted chat
  messages.
- Users can inspect or clear the local encrypted message cache without removing their crypto keys.
  Account settings include encrypted room-key recovery export/import.

## Media and previews

- Send up to ten attachments in one message, with encrypted image/video albums, spoiler covers,
  downloads, and a keyboard-friendly media viewer. The default per-file limit is 25 MiB and can be
  configured up to 100 MiB.
- Optional Klipy and GIPHY integrations provide browser-side GIF search. Search terms and downloads
  go directly from the browser to the selected provider; selected media is encrypted before Naigi
  stores it.
- Safe website cards and direct image/video previews can be displayed from encrypted message content.
  External destinations show a confirmation before opening. YouTube playback uses a privacy-hosted
  embed.
- X/Twitter status previews are an explicit server-side exception: Naigi requests a validated public
  post by numeric ID from a configured provider, then the browser encrypts the returned card inside
  the message.
- Text messages are limited to 4,000 characters. Longer pasted text is sent as an encrypted text
  attachment.

## Voice

When the host configures a self-hosted LiveKit service, users can make one-to-one audio calls in direct
conversations and joinable audio rooms in spaces. Voice-room creation is available under Space
Settings → Rooms by choosing the Voice room type. Call signaling and media keys use the existing
encrypted conversation; audio is frame-encrypted in the browser before the LiveKit relay receives it.
The relay cannot decrypt media, and Naigi does not impose an app-wide participant cap on voice rooms.
Video calls and host-tuned adaptive quality are not yet available. See [Voice calls](VOICE.md).

## Personalization and notifications

- Choose built-in themes or create local themes with color, layout, density, image, motion, and
  typography options. Preferences and room mutes are local to each browser.
- Adjust interface scale, message text size, sounds, media autoplay, external previews, Enter-to-send,
  and reduced motion.
- Enable desktop notifications with browser permissions. Mention-only filters and quiet hours are
  applied locally.
- Optional Firebase Cloud Messaging can deliver generic background alerts while the app is closed.
  Firebase receives a registration token and delivery metadata, not message text, room IDs, sender
  identity, or mentions. Closed-app alerts cannot honor per-room mutes.

## Trust and service boundaries

- The Naigi backend authorizes membership and stores encrypted envelopes, device public keys, and
  opaque metadata; it does not decrypt chat messages.
- PostgreSQL history is authoritative. Redis carries best-effort realtime notifications, not message
  history.
- The host can observe account identity, membership, role/access settings, message/attachment sizes
  and timing, and network metadata. Profile images and banners are server-managed profile media.
- A self-hosted deployment controls its server and browser assets. Use HTTPS and keep the client,
  host, and dependencies trusted; E2EE does not protect a compromised endpoint or a recipient's
  device.
