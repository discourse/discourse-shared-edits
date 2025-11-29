# Discourse Shared Edits Plugin – AI Coding Agent Guide

- Always start by reading ../../AGENTS.md to understand Discourse-wide conventions.
- While working on the plugin always feel free to consult Discourse source for best practices, patterns, and utilities.
- NEVER make commits to the repo, always leave it to humans to commit the code.

## Scope & Feature Flags
- Lives at `plugins/discourse-shared-edits`; everything here only runs when `SiteSetting.shared_edits_enabled` (defined in `config/settings.yml`) is true and the per-post custom field `shared_edits_enabled` has been toggled via `SharedEditRevision.toggle_shared_edits!`.
- Guardian hook (`lib/discourse_shared_edits/guardian_extension.rb`) restricts enable/disable/reset/recover endpoints to staff or trust level 4+. Reuse `guardian.ensure_can_toggle_shared_edits!` for any new privileged action.
- API routes live under `/shared_edits` (`plugin.rb`). Do not rename them without updating the Ember service and the Pretender fixtures in `test/javascripts`.

## Backend Architecture & Expectations
- `app/controllers/discourse_shared_edits/revision_controller.rb` is the only HTTP surface. Every new server feature must enforce `requires_plugin`, `requires_login`, and `ensure_shared_edits` guards, and must return JSON (never 204 when clients expect a body). Respond with `message_bus_last_id` whenever clients need to subscribe after fetching state.
- `app/models/shared_edit_revision.rb` stores every Yjs update. Treat `raw` as the authoritative, base64-encoded document snapshot and `revision` as the individual update payload. Always use the provided class methods (`init!`, `revise!`, `commit!`, `toggle_shared_edits!`, `reset_history!`, etc.) so Redis scheduling (`ensure_will_commit` + `Jobs::CommitSharedRevision`), message bus fan-out, editor attribution, and compaction invariants stay intact.
- `lib/discourse_shared_edits/state_validator.rb` is the gatekeeper for base64/Yjs safety, `max_post_length`, health reports, and corruption recovery. Any code that manipulates Yjs blobs must run through the validator helpers (or add new helpers here) so that errors surface as `StateCorruptionError` and can trigger automatic recovery.
- `lib/discourse_shared_edits/yjs.rb` wraps a shared `MiniRacer::Context` that executes the bundled `public/javascripts/yjs-dist.js`. Never eval ad-hoc scripts elsewhere; if you need a new primitive, add it to this wrapper so both Ruby and Ember flows stay aligned on how docs are encoded.
- Background commits: updates are throttled client-side, but the server still schedules `Jobs::CommitSharedRevision` 10 seconds out using a Redis key per post. If you change commit timing, update both `ensure_will_commit` and the job to avoid duplicate commits or missed flushes.
- Recovery + maintenance endpoints: `health`, `recover`, and `reset` all use `StateValidator` and emit `/shared_edits/:post_id` message-bus resync events. When adding new maintenance operations, emit the same payload shape (`{ action: "resync", version: <int> }`) so the Ember service understands it.
- Database: migrations live in `db/migrate`. The original table creation (`20200721001123_migrate_shared_edits.rb`) plus the column resize (`20251124000123_resize_shared_edit_columns.rb`) show expectations: always provide `down` paths, mark large operations `algorithm: :concurrently` when indexing, and protect edits on large tables.

## Frontend Architecture & Expectations
- `assets/javascripts/discourse/services/shared-edit-manager.js` is the heart of the client: it lazy-loads Yjs via `/plugins/discourse-shared-edits/javascripts/yjs-dist.js`, mirrors composer text into a shared `Y.Doc`, throttles PUTs to `/shared_edits/p/:post_id`, and subscribes to `/shared_edits/:post_id` on `messageBus`. Preserve: message payload keys (`version`, `update`, `client_id`, `user_id`, `user_name`), selection/cursor broadcasting, throttling constants (`THROTTLE_SAVE`, `THROTTLE_SELECTION`), and cleanup of DOM listeners/cursor overlays to avoid leaks.
- Composer integration lives in `assets/javascripts/discourse/initializers/shared-edits-init.js` and `extend-composer-service.js`. Always guard new behavior with `siteSettings.shared_edits_enabled`, register hooks via `withPluginApi`, and respect `creatingSharedEdit`/`editingPost` semantics so we never leave the composer in a half-shared state.
- UI pieces: the post action replacement is in `components/shared-edit-button.gjs`; the composer “Done” button lives in `connectors/composer-fields-below/shared-edit-buttons.gjs`; shared styles are under `assets/stylesheets/common/discourse-shared-edits.scss`; cursor rendering utilities are in `assets/javascripts/discourse/lib/{caret-coordinates,cursor-overlay}.js`. Keep strings translatable (`shared_edits.*` keys exist on both client and server locales).
- Asset bundling: `public/javascripts/yjs-dist.js` is generated via `bin/rake shared_edits:yjs:build` (`lib/tasks/yjs.rake` wraps `pnpm exec esbuild …`). Never hand-edit the bundled file; re-bundle whenever `yjs` changes and commit the new artifact.

## Testing, Linting & Tooling
- Ruby specs cover validators, model behavior, controller endpoints, and basic system flows. Run `bin/rspec plugins/discourse-shared-edits/spec/<area>` (requires `LOAD_PLUGINS=1` when running outside the full suite). `spec/system` relies on page objects; avoid raw Capybara finders for new tests.
- Ember acceptance tests live at `plugins/discourse-shared-edits/test/javascripts/acceptance`. Execute them with `bin/qunit plugins/discourse-shared-edits/test/javascripts/acceptance/composer-test.js` (or the directory to run them all).
- Lint every file you touch: `bin/lint plugins/discourse-shared-edits/<path>` for Ruby/JS/SCSS and `pnpm --filter discourse-shared-edits lint` if you need the plugin-level configs from `package.json`. Stylelint and template lint configs already live alongside the plugin—respect them when adding files.
- Node tooling: the plugin pins Node ≥ 22 and pnpm 9 (`package.json`). Use `pnpm install` inside the plugin when you add JS dependencies so lockfiles stay in `plugins/discourse-shared-edits/pnpm-lock.yaml`.

## Operational Tips & Utilities
- Manual QA: `plugins/discourse-shared-edits/support/fake_writer` uses Playwright to simulate concurrent editors. Run `support/fake_writer POST_ID --speed=fast --headless=false` against a dev instance to reproduce race conditions before shipping protocol changes.
- Message bus hygiene: `SharedEditRevision::MESSAGE_BUS_MAX_BACKLOG_*` caps backlog size/age. Keep any new channels under the same limits or we risk unbounded Redis usage.
- Edit reasons: `SharedEditRevision.update_edit_reason` builds `shared_edits.reason` strings listing everyone who contributed between commits. If you change commit batching or editor attribution, update both the method and translations.
- Recovery workflow: corruption is surfaced in logs and bubbled to the client via `state_recovered` / `state_corrupted` error codes. When adding new error states, expose translated messaging in `config/locales/client.*` and wire them into the composer UI.
- Selection sharing: the Ember service currently attempts to PUT `/shared_edits/p/:post_id/selection`. The endpoint is not implemented yet, so requests are best-effort and errors are ignored; reuse that route if you decide to ship cursor/selection sync so the client code does not need changing.
- Knowledge sharing: keep this file current whenever you add new entry points, commands, or conventions. After completing any task that touches this plugin, spawn a review agent to compare your diff against `plugins/discourse-shared-edits/AGENTS.md` and confirm the instructions remain accurate.
