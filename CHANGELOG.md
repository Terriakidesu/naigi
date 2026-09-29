# Changelog

## [Unreleased]

## [0.18.0] - 2026-09-29

### Added

- A pure-black app theme for OLED displays, available alongside Dark, Dim, and Light and saved locally with the other browser preferences.
- Users can build local themes with live previews, custom colors, gradients or browser-local background images, layout and density options, corner/border/shadow styles, and safe animation/transition presets; validated share codes and theme files remain compatible with older presets.
- A MomoTalk-inspired appearance with a pink chat header, blue-gray navigation rail, lavender conversation list, white chat pane, and slate message bubbles.
- Admins can assign host operators Admin or Moderator access from the dashboard; operator changes are audited, and Moderators are limited to reports and chat-account moderation.
- Admins and Moderators can apply audited installation-wide send timeouts to chat accounts, with automatic expiry and a separate removal action.
- Host operators can activate or deactivate spaces using a reversible access freeze; changes record an operator, reason, and timestamp in paginated per-space audit history.

### Changed

- Theme edits now stay isolated to the live preview until app preferences are saved; the preview shows every palette color and the selected design settings.
- Shared form controls now use consistent theme-aware styling across the web app, including circular color pickers and custom checkboxes, sliders, selects, and file buttons.
- Space role previews now simulate the role-visible rooms, people access, and available controls in a read-only chat view; message history is never loaded or decrypted for previews.
- The host admin console now supports browser-local System, Light, and Dark themes across its dashboard pages.
- Host account management now requires a two-character username/display-name prefix search and uses bounded keyset pagination without full result counts or deep offset scans.
- Members can still see deactivated spaces in their space switcher and receive a clear status page when selecting one; room and message access remains blocked.
- The host Spaces directory exposes opaque IDs and minimal activation metadata only; deactivated spaces retain their data and memberships while blocking member access, realtime activity, uploads, and new joins.

## [0.17.0] - 2026-09-29

### Added

- The composer accepts pasted clipboard images and sends them through the existing encrypted attachment flow.
- The GIF picker opens with trending Klipy or GIPHY results and supports search; selected GIFs are added as encrypted attachments, and pasted Tenor, Klipy, and GIPHY links can render safe provider previews.
- Desktop notifications can be limited to verified direct or role mentions and suppressed during browser-local quiet hours; notification copy remains generic and never contains decrypted message content.
- Optional Firebase Cloud Messaging can deliver generic background alerts for users who enable “All new messages”; mention filtering and quiet hours remain browser-local.
- Encrypted images and videos can be set to load on request, message text size can be adjusted independently in pixels, and the encrypted message cache can be inspected and cleared without affecting keys or queued messages.
- Roles can opt into separate member-list groups; members with multiple separated roles appear under the highest-priority one, while other members remain under All members.
- Users can report accounts or messages to the installation host, optionally sharing reporter-supplied evidence encrypted to a host-managed public key.
- Users can block and unblock accounts to prevent direct conversations in either direction; account settings include a blocked-users list.
- Host operators have an instance-wide report queue with encrypted-evidence review, message removal, account suspension/restoration, and an audit log.
- Host operators have a separate searchable chat-account directory with instance-wide ban/restore actions, audited warnings, and per-account moderation history; warning notices are delivered in chat and can be acknowledged by the affected user.
- Space moderators can issue and revoke space-scoped warnings with reasons and optional expiry; affected users see and acknowledge warning notices in chat, and moderators can review warning history.
- Host operators have a separate Operations page with live CPU/RAM readings and on-demand service health, PostgreSQL sizes, approximate table counts, storage usage, and likely orphaned or missing file totals.
- Operations now includes aggregate account totals, recent authenticated-account and registration counts, cross-process connected users and WebSocket totals, spaces/rooms, encrypted-record estimates, and moderation counts.
- Operations now visualizes seven-day account, message, and upload-record trends plus a page-local rolling CPU and memory chart; the overview layout uses the available desktop width more efficiently.
- Host operators can quarantine old unreferenced storage files from a separate Maintenance page, restore them during a 30-day recovery window, and manually purge only expired files; each action is audited.

### Changed

- Host moderation now uses host-only identities and sessions in a separate admin database instead of `INSTANCE_ADMIN_USER_IDS` and chat-account sessions. Configure `ADMIN_DATABASE_URL`, run migrations, and provision operators with `bun run admin-users`.
- The host console now uses consistent navigation, tighter report empty/error states, prominent Operations integrity alerts, grouped and collapsed database tables, and an explicit step-by-step Maintenance flow with migration guidance.
- Space ban, timeout, and warning dialogs now collect an explicit reason and duration instead of using a hidden fixed timeout.
- Message actions now use a compact Discord-style hover pill above the message edge instead of taking an in-flow divider row.
- Account settings use the shared sidebar, header, and mobile drawer shell without the redundant workspace rail.
- External destinations now use a polished confirmation dialog with the full URL and explicit Cancel/Open actions.
- Text attachments now show compact, scrollable inline previews with character counts and a single expand-to-view action.
- Recognized plaintext code attachments now receive safe client-side syntax highlighting in both inline and expanded previews.
- Files can be dragged into the chat area and are queued through the existing encrypted attachment flow.
- The jump-to-latest control now uses responsive show/hide thresholds to avoid appearing on short scrolls or flickering near its boundary; unread and mention counts remain available when it appears.
- Spoiler images and videos now show a heavily blurred preview that preserves their intrinsic aspect ratio and dimensions until revealed.
- The conversation privacy shield is vertically centered beside its explanatory text.
- The interface scale slider now has labeled ticks; message text size uses a pixel-based slider with labeled ticks.
- Account settings now use an open, card-free layout with grouped navigation, clear section hierarchy, a redesigned profile preview, and preference rows; Profile and App show save or discard actions only when there are unsaved changes.
- Profile popups now present the cover, avatar, account name, handle, join date, and an in-context edit action in a more complete profile layout.
- The rooms sidebar now uses clearer room and category icons, category counts, visible unread states, and browser-local mute indicators.
- App preferences now include a live chat preview that reflects the selected interface scale and message text size.
- Leaving App preferences with unsaved changes now offers Save, Discard, or Stay choices.

### Fixed

- Muted text, role-colored labels, message text, and avatar initials now remain readable across themes and custom accent colors.
- Encrypted media download controls now stay positioned over the displayed image or video instead of the wider attachment card.
- Tenor short `.gif` links now load as images instead of being placed in iframes that Tenor blocks; unavailable links leave a clear open-on-Tenor fallback.
- Direct image URLs are hidden when rendered as embeds; images align with message text and open in a screen-fitted viewer without external-link confirmation.
- Cached chat history now stays mounted when confirmed by the server, and encrypted metadata updates refresh message text without restarting embedded media.

### Security

- GIF search terms and GIF downloads go directly between the browser and configured providers, while Naigi stores only the resulting encrypted attachment and encrypted preview metadata. The retired Tenor API is not called.
- FCM receives only a data-only generic event; message content, room IDs, sender identity, and mention data are not sent to Firebase.
- Reports never include decrypted message content unless the reporter explicitly opts in; the browser encrypts shared evidence to a host public key, and the server cannot decrypt it.
- Host operators now use identities and sessions stored in a separate admin database; chat accounts and space roles cannot grant instance-wide moderation access.
- Blocking suppresses direct-message history and realtime access without changing shared-space access.

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

- [0.18.0](docs/changelogs/0.18.0.md) — 2026-09-29
- [0.17.0](docs/changelogs/0.17.0.md) — 2026-09-29
- [0.16.0](docs/changelogs/0.16.0.md) — 2026-09-28
- [0.15.0](docs/changelogs/0.15.0.md) — 2026-09-28
- [0.14.0](docs/changelogs/0.14.0.md) — 2026-09-28
- [0.13.0](docs/changelogs/0.13.0.md) — 2026-09-28
- [0.12.0](docs/changelogs/0.12.0.md) — 2026-09-27
- [0.11.0](docs/changelogs/0.11.0.md) — 2026-09-27
- [0.10.0](docs/changelogs/0.10.0.md) — 2026-09-27
- [0.9.0](docs/changelogs/0.9.0.md) — 2026-09-27
