# Changelog

## [Unreleased]

_No unreleased changes._

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

- [0.14.0](docs/changelogs/0.14.0.md) — 2026-09-28
- [0.13.0](docs/changelogs/0.13.0.md) — 2026-09-28
- [0.12.0](docs/changelogs/0.12.0.md) — 2026-09-27
- [0.11.0](docs/changelogs/0.11.0.md) — 2026-09-27
- [0.10.0](docs/changelogs/0.10.0.md) — 2026-09-27
- [0.9.0](docs/changelogs/0.9.0.md) — 2026-09-27
