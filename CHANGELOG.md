# Changelog

## [Unreleased]

### Added

- The composer accepts pasted clipboard images and sends them through the existing encrypted attachment flow.
- The GIF picker opens with trending Klipy or GIPHY results and supports search; selected GIFs are added as encrypted attachments, and pasted Tenor, Klipy, and GIPHY links can render safe provider previews.

### Changed

- Message actions now use a compact Discord-style hover pill above the message edge instead of taking an in-flow divider row.
- Account settings now use the workspace rail, sidebar, header, and mobile drawer visual shell used by chat.
- External destinations now use a polished confirmation dialog with the full URL and explicit Cancel/Open actions.
- Text attachments now show compact, scrollable inline previews with character counts and a single expand-to-view action.
- Recognized plaintext code attachments now receive safe client-side syntax highlighting in both inline and expanded previews.
- Files can be dragged into the chat area and are queued through the existing encrypted attachment flow.

### Fixed

- Encrypted media download controls now stay positioned over the displayed image or video instead of the wider attachment card.
- Tenor short `.gif` links now load as images instead of being placed in iframes that Tenor blocks; unavailable links leave a clear open-on-Tenor fallback.
- Direct image URLs are hidden when rendered as embeds; images align with message text and open in a screen-fitted viewer without external-link confirmation.
- Cached chat history now stays mounted when confirmed by the server, and encrypted metadata updates refresh message text without restarting embedded media.

### Security

- GIF search terms and GIF downloads go directly between the browser and configured providers, while Naigi stores only the resulting encrypted attachment and encrypted preview metadata. The retired Tenor API is not called.

## [0.16.0] - 2026-09-28

### Added

- Server settings now support member-visible icon and banner branding, an encrypted welcome-screen editor, encrypted custom emoji uploads/removal, and a permission-scoped audit log.
- Profile settings now support banners, encrypted room-key recovery export/import, and explicit local-data cleanup controls.
- Space landing-room selection is independent from encrypted join-announcement routing; empty landing rooms can render the configured encrypted welcome heading, message, rules, and acknowledgement prompt.

### Changed

- Space icons now appear in the workspace rail and branding uploads are managed separately from encrypted conversation media.
- Custom emoji are decrypted only in memory on authorized browsers and render locally in encrypted messages; recovery passphrases and local cleanup state never leave the device.

### Security

- Custom emoji bytes are encrypted in the browser before upload; the server stores only opaque bytes, encrypted metadata, IDs, timestamps, and action codes. Audit logs never include message content, room names, URLs, embeds, or media keys.

## [0.15.0] - 2026-09-28

### Added

- Categories can now grant inherited view and upload access to roles; rooms in a category enforce those grants while preserving room-specific access rules.
- Server settings can choose or disable the room used for encrypted join announcements, with the first room selected by default.
- Invite acceptance now returns the configured onboarding room, and the browser can publish a client-encrypted “joined” notice without exposing its plaintext to the server.

### Changed

- Role previews and role management now show category-level inherited access alongside direct room access.

### Security

- Category permissions are enforced by the server for channel listing, membership synchronization, message history, uploads, and sends; onboarding stores only a channel ID and never stores plaintext notices.

## [0.14.0] - 2026-09-28

### Added

- Profile settings now include a separate device-local App Settings surface for theme, accent color, interface scale, compact spacing, motion, sounds, media autoplay, external previews, and Enter-to-send behavior.
- Rooms and categories now expose pointer and keyboard context menus for opening, unread markers, local room mute, link copying, collapsing categories, creating rooms, and settings navigation.

### Security

- App preferences and room mutes remain local to the browser and are never uploaded, persisted in PostgreSQL, or included in encrypted message content.

## [0.13.0] - 2026-09-28

### Added

- Room autocomplete now recognizes `#room` references in encrypted conversations, with room labels hydrated locally and clickable references that open the room.
- X/Twitter status links, including supported rewrite domains such as FixupX, now use encrypted custom cards with post text, author details, timestamps, images, and videos when a configured preview provider can supply them.
- YouTube links now render a privacy-hosted preview player without showing the external-visit warning when the video is played.

### Changed

- Direct and encrypted media previews now preserve their intrinsic dimensions without fixed letterboxing; Twitter cards retain their existing media presentation.

### Security

- X/Twitter preview requests are authenticated, restricted to allowlisted status URLs, sent only as numeric IDs to configured providers, and are not persisted or logged before the returned card is encrypted client-side.

## [0.12.0] - 2026-09-27

### Changed

- Website links now render automatic encrypted cards containing only the site title and available `twitter:image`/`og:image`, while direct image and video URLs render as media previews.
- External links no longer require a separate preview action and now show a confirmation warning before opening outside Naigi.
- The encrypted composer now supports up to ten attachments per send, per-file previews, spoiler flags, progress and retry state, dedicated downloads, automatic near-viewport image loading, and safe plaintext previews for source, Markdown, and text files.
- Consecutive encrypted image and video attachments now render as compact albums with tile previews, spoiler covers, per-item downloads, and keyboard-friendly browsing in the media viewer.
- Batch uploads now publish one encrypted message with an ordered attachment manifest instead of one message per file; the album has one message toolbar rather than a toolbar on every tile.
- Media attachment cards and the composer queue now use a quieter image-first layout, with redundant composer shortcut and encryption hints removed.
- Unpasted messages are limited to 4,000 characters; pasted text over that limit is converted into an encrypted `.txt` attachment instead of being inserted into the composer.
- Composer input now renders Unicode emoji with the bundled Twemoji artwork instead of platform emoji glyphs while preserving normal text editing and sending behavior.
- Composer focus styling now highlights the complete input container instead of outlining only the textarea.
- Conversation details now occupy a dedicated column beside the messages and composer instead of covering the composer width.
- The jump-to-latest control now stays centered above the composer and switches to a mention indicator when a new encrypted message pings the current user.
- Role settings now provide a read-only “View as role” preview for room access and allowed or blocked actions without impersonating members or decrypting history.
- Conversation loading now overlaps opaque history and encrypted-cache reads with membership and room-key preparation, batches client-side decryption, and reuses bounded in-memory results only while unlocked.

Released versions are maintained as one Markdown file per version under
[`docs/changelogs/`](docs/changelogs/).

## Releases

- [0.16.0](docs/changelogs/0.16.0.md) — 2026-09-28
- [0.15.0](docs/changelogs/0.15.0.md) — 2026-09-28
- [0.14.0](docs/changelogs/0.14.0.md) — 2026-09-28
- [0.13.0](docs/changelogs/0.13.0.md) — 2026-09-28
- [0.12.0](docs/changelogs/0.12.0.md) — 2026-09-27
- [0.11.0](docs/changelogs/0.11.0.md) — 2026-09-27
- [0.10.0](docs/changelogs/0.10.0.md) — 2026-09-27
- [0.9.0](docs/changelogs/0.9.0.md) — 2026-09-27
