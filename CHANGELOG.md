# Changelog

## [Unreleased]

### Added

- Room autocomplete now recognizes `#room` references in encrypted conversations, with room labels hydrated locally and clickable references that open the room.

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

- [0.12.0](docs/changelogs/0.12.0.md) — 2026-09-27
- [0.11.0](docs/changelogs/0.11.0.md) — 2026-09-27
- [0.10.0](docs/changelogs/0.10.0.md) — 2026-09-27
- [0.9.0](docs/changelogs/0.9.0.md) — 2026-09-27
