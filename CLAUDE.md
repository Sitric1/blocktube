# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BlockTube is a Manifest V3 WebExtension (Chrome + Firefox) that filters/blocks YouTube content
*before* the DOM renders, by intercepting YouTube's own JSON responses. Plain vanilla JS, no
runtime dependencies, no bundler — there is no `package.json`.

## Commands

```bash
# Build a packaged zip into dist/<browser>/
./tools/build.sh chrome
./tools/build.sh firefox
./tools/build.sh firefox_selfhosted
./tools/build.sh                       # no arg: just cleans dist/

# Lint (ESLint config exists but is not installed locally — run via npx)
npx eslint src/
```

`build.sh` copies `src/`, `assets/`, `LICENSE`, `VERSION` and the per-browser
`platform/<browser>/manifest.json` into `dist/<browser>/`, substitutes the `{EXT_VERSION}`
placeholder (in `manifest.json` and `src/ui/options.html`) with the contents of the `VERSION`
file, then zips. There is no minification or transpilation — source ships as-is.

To test changes: load the unpacked `dist/<browser>/` directory (Chrome) or `dist/firefox/` as a
temporary add-on (Firefox).

### Releasing

Bump the `VERSION` file, then push a git tag `v*`. `.github/workflows/release.yml` builds the
`chrome` and `firefox_selfhosted` packages, creates the GitHub release, and auto-commits an
updated `.updates/ff/updates.json` (the Firefox self-hosted update manifest) back to `master`.

## Architecture

Three content scripts are injected at `document_start`, `all_frames`, on `*.youtube.com`:

- **`src/scripts/content_script.js`** — runs in the **isolated** world. The only script with
  `chrome.*` API access. Connects to the background via `chrome.runtime.connect()` port, relays
  filter data into the page via `window.postMessage` (`from: BLOCKTUBE_CONTENT`), and relays
  context-menu block requests back up to the background.
- **`src/scripts/seed.js`** — runs in the **main** world and *must execute before any YouTube
  script*. Hooks `window.fetch`, `window.Polymer`, `window.writeEmbed`, `loadInitialData`,
  `yt.player.Application`, spfjs `request`, and custom-element menu renderers. YouTube callbacks
  that fire before BlockTube is ready are queued and replayed on the `blockTubeReady` event
  (`window.btDispatched` flag). Calls into `window.btExports`, which `inject.js` populates.
- **`src/scripts/inject.js`** — runs in the **main** world. The ~2100-line filtering engine.

`src/scripts/background.js` is the service worker (Chrome) / background script (Firefox). It
loads `storageData` + `enabled` from `chrome.storage.local`, compiles filter strings into regex,
keeps a port to every tab, and rebroadcasts on any `chrome.storage` change.

### Data flow

Options UI writes `storageData` → `chrome.storage.local` → `background.js` recompiles regex and
broadcasts to every `content_script.js` port → `content_script.js` `postMessage`s it into the
page → `inject.js` applies the filters to each intercepted YouTube JSON response before render.

The background sends both raw `storage` and pre-compiled `compiledStorage`.

### Filter compilation (`background.js` `utils.compileRegex`)

- `channelId` / `videoId` → exact match (`^value$`).
- `/pattern/flags` → used as raw regex verbatim.
- Plain keyword → regex-escaped and wrapped in unicode word boundaries, case-insensitive.
- Lines starting with `//` are treated as comments and skipped.

### Filtering engine (`inject.js`)

- `filterRules` (declared ~line 179) maps YouTube renderer type names (`videoRenderer`,
  `gridVideoRenderer`, `compactVideoRenderer`, `commentRenderer`, …) to property paths for the
  fields BlockTube extracts (`videoId`, `title`, `channelId`, `channelName`, `vidLength`, …).
  Grouped into rule sets: `main`, `comments`, `guide`, `ytPlayer`.
- `ObjectFilter` (~line 474) recursively walks an intercepted JSON object, matches each renderer
  against the relevant rule set, and removes blocked entries. Some rules carry a `customFunc`
  (e.g. `redirectToNext`, `blockPlaylistVid`) for behavior beyond plain removal.
- `defineProperty` (top of file, adapted from uBlock Origin) traps `window.ytInitialData` etc.
  so responses are filtered as YouTube assigns them.
- Context-menu blocking: `seed.js` hooks the menu renderers → `inject.js` injects a Block item →
  page posts `contextBlockData` → `content_script.js` → `background.js` appends to `storageData`.

### Storage shape

`storageData` = `{ filterData, options }`. `filterData` holds the per-category filter arrays
(`videoId`, `channelId`, `channelName`, `comment`, `title`, `vidLength`, `javascript`,
`percentWatchedHide`); `options` holds booleans (`trending`, `mixes`, `shorts`, `movies`,
`enable_javascript`, …). The `javascript` filter is custom user JS evaluated per video when
`enable_javascript` is set.

## UI

- `src/ui/options.html` + `options.js` — full options page. Uses a bundled CodeMirror
  (`src/ui/cm/`) as the editor for the JavaScript filter.
- `src/popup/` — toolbar popup; toggles the global `enabled` flag.

## Platform manifests

`platform/chrome/` and `platform/firefox/` differ: Chrome uses `background.service_worker`,
Firefox uses `background.scripts` plus `browser_specific_settings.gecko`. Keep both in sync when
changing permissions, content scripts, or metadata. `firefox_selfhosted` is a third manifest
variant for the self-distributed `.xpi`.

## Conventions

ESLint extends `airbnb-base` with `max-len` 100; `'use strict'` required at global scope.
Keep `inject.js`'s page-world code free of any `chrome.*` API use — only `content_script.js`
may touch extension APIs.
