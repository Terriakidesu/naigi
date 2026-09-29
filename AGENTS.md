# Naigi agent notes

## Commands

- Copy `.env.example` to `.env`; local development needs the app and admin PostgreSQL databases plus Redis/Valkey. Run `bun run db:migrate` before `bun run dev`.
- `bun run build:client` bundles `client/*.ts` and copies the HTML/CSS/WASM assets into ignored `public/`; edit `client/`, never generated `public/` files.
- Verification commands are `bun run typecheck`, `bun test`, and `bun run test:e2ee`. The E2EE test builds the browser client, needs PostgreSQL/Redis and Playwright Chromium, and uses temporary app/admin PostgreSQL schemas.
- Run one unit-test file with `bun test path/to/file.test.ts`; `bun run db:purge -- --yes` is destructive local cleanup and must not be used against production.
- When a change is ready and the user requests it, stage all intended source and documentation changes, run the verification commands, and create one descriptive git commit; do not commit generated ignored `public/` files.

## Architecture and security

- `src/index.ts` starts the Bun/Elysia server; `src/app.ts` owns HTTP routes, `src/realtime.ts` owns WebSocket subscriptions, and `src/redis/client.ts` publishes best-effort notifications.
- `client/main.ts` is the chat UI; `client/crypto.ts` is the Matrix Olm/Megolm WASM adapter. The backend stores opaque encrypted envelopes and must never receive or log plaintext message content, names, URLs, embeds, or media keys.
- Redis realtime events are notifications only. PostgreSQL message history is authoritative; reconnect and catch-up paths must fetch encrypted envelopes with cursors.
- IndexedDB message caching stores encrypted envelopes only. Do not add plaintext message content or local passphrases to persistent browser storage.
- Private recipient discovery is limited to active members of a shared server; do not restore global username/user search.
- SQL migrations in `src/db/migrations/` are applied once in filename order by `src/db/migrate.ts`. Add a new numbered migration; do not edit an applied migration.

## Changelog and SemVer

- Keep a `CHANGELOG.md` with an `## [Unreleased]` section and links to one Markdown release file per version in `docs/changelogs/`. Release files should use concise `Added`, `Changed`, `Fixed`, `Removed`, or `Security` entries for user-visible, API, schema, or crypto changes.
- `package.json` is the authoritative application version (currently released `0.20.0`) and must follow `MAJOR.MINOR.PATCH` SemVer: patch for compatible fixes, minor for backward-compatible features, and major for breaking API/protocol/schema/crypto changes. Keep unreleased work grouped under one version instead of bumping for every individual change.
- For a backward-compatible feature release, increment `MINOR`, update the package/app version, move the `Unreleased` entries under the bumped version and date, and create `docs/changelogs/MAJOR.MINOR.PATCH.md` with concise `Added`, `Changed`, `Fixed`, `Removed`, or `Security` entries. Update the release list in `CHANGELOG.md`; there is no automatic changelog or release script.
