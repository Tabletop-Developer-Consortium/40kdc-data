# CLAUDE.md — `examples/`

Demo web apps that consume `@alpaca-software/40kdc-data`. They double as the
package's real-world exercisers — most data/export/import bugs surface here first
(e.g. the ATC-2026 format that silently went missing from a hardcoded picker
list). Read this before working in any app; the conventions below are shared.

## The apps

`data-explorer`, `hull-tracer`, `layout-editor`, `list-builder`, `mission-matrix`,
`salvo`, `teams-planner`. `_shared/` is a library, not an app.

Every app is the **same stack**: Svelte 5 (runes — `$state`/`$derived`/`$props`/
`$effect`), Vite 6, TypeScript strict, vitest. Tailwind v4 via `@tailwindcss/vite`
with tokens in a `@theme` block in `src/app.css` (list-builder, hull-tracer,
mission-matrix, teams-planner); the rest use plain CSS. PWA (`vite-plugin-pwa` via
`_shared/pwa-config.ts`) on mission-matrix and teams-planner.

## `_shared/` — relative-import source library

`@40kdc/example-shared` is **private, never published, has no build step**. Apps
import its `.svelte`/`.ts` **by relative path** (`../../_shared/AppHeader.svelte`,
depth varies by file). Consequences:
- Renaming or moving a `_shared/` file means updating **every** relative import
  that references it — there's no alias to lean on (list-builder's `$lib` alias is
  for its *own* `src/lib`, not `_shared`).
- It holds app chrome (`AppHeader`/`AppFooter`/`Modal`), the sync/entitlement/
  doc-session clients, `build-stamp.ts`, `pwa-config.ts`, and `tokens.css`.

## Consuming the data package

Apps depend on the workspace package (`"@alpaca-software/40kdc-data": "*"`) and use
the linked API: `Dataset.embedded()` for game data, plus typed exports
(`exportRoster`, `EXPORT_FORMATS`, `encodeShareToken`/`decodeShareToken`, the
entity types).

**Two rules that bite if ignored:**

1. **Node-only stub in `vite.config.ts` is mandatory.** The package barrel
   re-exports `schema-loader` and `validate`, which touch `node:fs`/`node:url` at
   module-load. Browser builds break unless each app's `stubNodeOnlyModules()`
   Vite plugin stubs `node:fs`/`fs/promises`/`path`/`url` + the package's
   `schema-loader.js`/`validate.js`/`bundle-schemas.js`, and polyfills `node:zlib`'s
   `gunzipSync` through `fflate` (ListForge URLs are gzipped). The canonical copy is
   `list-builder/vite.config.ts` (lifted from `salvo`). If the package changes which
   exports touch Node, update the stub's match list — don't delete the stub.

2. **Never hand-maintain a parallel list of export formats.** Derive the export
   picker from the package's `EXPORT_FORMATS` (`tools/src/export/index.ts`), which
   is built from the registered serializers so it always equals what `exportRoster`
   can produce. A hardcoded format array is exactly what hid `atc-2026` from the
   list-builder picker. The package's own doc comment says it: UIs iterate
   `EXPORT_FORMATS`, they don't re-declare it.

## Dev / build / test

Standard per app: `npm run dev` (Vite, :5173) · `build` → `dist/` · `preview` ·
`check` (svelte-check) · `test` (vitest run). Extras:
- `list-builder`: `test:e2e` (Playwright, dev server on :4292, `e2e/*.spec.ts`).
- `teams-planner`: `test:e2e` (Playwright) + `gen:icons`.
- `mission-matrix`: `gen:icons` (PWA icons via sharp; output is committed).
- `salvo`: `inspect` (headless Playwright screenshots at 3 viewports).

**Staleness gotcha:** anything serving built `dist/` (Salvo, a `preview`/deploy,
SPA probing) shows the *last build*, not your edits — `npm run build` first or
you'll debug a phantom. Apps inject `__DATA_VERSION__`/`__BUILD_SHA__` via
`_shared/build-stamp.ts`, so a stale deploy is detectable by comparing the stamped
version against the package version.

## Deploy

Each app is an assets-only Cloudflare Worker: `wrangler.jsonc` with
`assets.directory: ./dist`, `not_found_handling: "single-page-application"`, and a
custom `*.alpacasoft.dev` route. `wrangler deploy` from the app dir. `base`
honours `TOOLLET_BASE` for subpath hosting (unused in prod — alpacasoft.dev is
root).

## Note

These apps are **not** in `just preflight` (the package's CI gate). When you touch
an app, run its own `check`/`test`/`test:e2e`. The one existing design doc is
`mission-matrix/DESIGN.md`.
