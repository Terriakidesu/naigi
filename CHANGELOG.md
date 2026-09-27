# Changelog

## [Unreleased]

### Added

- Added authenticated profile image uploads for PNG, JPEG, GIF, WebP, and AVIF images, including animated GIFs, a 5 MB limit, and member-list avatars.
- Added a client-side profile image editor for square crop, zoom, output resizing, and animated GIF preservation.
- Added full local Twemoji rendering, complete Unicode emoji shortcode autocomplete, and bundled Twemoji artwork for offline use.
- Added a categorized, scrollable emoji picker with icon navigation and emoji search.
- Added customizable server roles with encrypted names, colors, ordering, permissions, channel access, role mentions, and moderation controls.
- Added an editable Everyone role with granular channel, invite, role, moderation, and message permissions applied to every server member by default.

### Changed

- Emoji-only messages now use larger typography, while reply previews stay above the sender row and a consistent right-aligned hover toolbar floats on the message edge without adding vertical gaps.
- Arrow keys, Enter, and Tab now navigate mention and emoji suggestions without scrolling the chat.
- Server settings now organize server management, roles, member assignments, channel gates, and moderation in a polished access-control workspace.
- Space invite management now keeps one active invite link and groups revoked links into collapsed history.
- Server management permissions can now be delegated independently instead of relying only on broad management shortcuts.
- Project and client messaging now clearly position Naigi as a self-hosted, privacy-focused chat app.
- Refreshed the client with a quiet graphite-and-slate visual language, rectangular space navigation, private-thread terminology, and an original N mark.
- Restored compact space navigation and moved account settings into the personal controls area, separate from active-space settings.
- Replaced text glyph controls with a consistent Lucide icon system, condensed the conversation people panel into role-based member rows, and split account and space settings into focused sections.

### Fixed

- Adjacent emoji shortcodes such as `:sob::sob:` now expand independently.
- Restored readable contrast for the bottom-left account control and applied role colors to message sender names and member lists.
- Transparent profile images now reveal the surrounding chat surface instead of the initials background.
- Space settings now render immediately and hydrate encrypted room names in the background instead of waiting for every room to finish preparing.
- Browser unlock failures now distinguish an encrypted local-store problem from unrelated chat startup errors instead of blaming every failure on the passphrase.
- Restored browser crypto stores when their local device ID was lost but the encrypted IndexedDB store and server device record remained available.
- Started realtime independently of slower conversation loading and added a timeout so a blocked WebSocket cannot leave the app stuck on “Connecting…”.
- Server request errors now include the method, route, error code, and stack trace in operator logs without logging request bodies or encrypted content.
- Conversation history now keeps the view at the newest messages after late encrypted media layout changes.

### Security

- Enforced role-based channel, upload, messaging, timeout, ban, and moderator deletion checks on the server while keeping message content end-to-end encrypted.
- Preserved owner and role-hierarchy protections while ensuring the Everyone role is restored for existing, rejoining, and newly created server members.
