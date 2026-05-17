# Country & Curated-Channel Blocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BlockTube block YouTube content from (a) a curated remote channel blocklist and (b) channels whose country matches the user's country filter — both enforced *before* render through the existing channel-ID filter engine.

**Architecture:** Country blocking is reframed as channel-ID blocking. `background.js` keeps a persistent `channelCountryMap` cache (`channelId → country name | null`) and a `remoteBlocklist` (curated channel IDs fetched from GitHub). `compileAll` appends both — the curated IDs and the IDs whose cached country is in the user's blocklist — onto the compiled `channelId` regex list. `inject.js` then blocks them everywhere with zero new filter logic; it only gains a *harvester* that reads channel country out of intercepted `/youtubei/v1/browse` JSON and reports it back. This reuses the entire existing `ObjectFilter` pipeline and the `redirectToIndex` channel-page behavior.

**Tech Stack:** Vanilla JS, MV3 WebExtension (Chrome + Firefox). No bundler. New shared pure-helper file `src/scripts/lib/country-utils.js` (dual-mode export) so the pure logic is unit-testable under Node.

**Testing note:** This repo has no test harness (no `package.json`, no runner). Pure helpers in `country-utils.js` get real Node unit tests (`node test/<file>.test.js`, using built-in `node:assert` — no dependencies, and `test/` is not shipped because `build.sh` only copies `src/ assets/ LICENSE VERSION`). Browser-integration tasks are verified by loading the unpacked build and inspecting behavior + `chrome.storage.local`. Each such task lists explicit expected observations.

**Data source:** `https://raw.githubusercontent.com/Sitric1/channel-blocklist/main/blocklist.txt` — newline-separated `UC…` channel IDs (confirmed reachable, HTTP 200, branch `main`).

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/scripts/lib/country-utils.js` | **Create** | Pure helpers: parse blocklist text, normalize country list, derive blocked channel IDs. Dual-mode (`module.exports` + global `countryUtils`). |
| `test/country-utils.test.js` | **Create** | Node unit tests for `country-utils.js`. Not shipped. |
| `src/scripts/background.js` | Modify | Load `country-utils`; hold `remoteBlocklist` + `channelCountryMap` state; fetch remote blocklist; append curated + country-derived IDs in `compileAll`; record harvested country data; handle options-page messages. |
| `src/scripts/inject.js` | Modify | Add `harvestChannelCountry()` — scan intercepted browse JSON for `channelId`+`country`, post to content script. |
| `src/scripts/content_script.js` | Modify | Remove the broken `blockChannelByCountry` page-overwrite; relay `channelCountry` messages page→background; minimal fixed DOM-scrape fallback. |
| `src/ui/options.html` | Modify | Add "Update curated blocklist" button + status line to the Country tab. |
| `src/ui/options.js` | Modify | Wire the button to `chrome.runtime.sendMessage`; show last-fetch status. |
| `platform/chrome/manifest.json` | Modify | Add `host_permissions` for `raw.githubusercontent.com`. |
| `platform/firefox/manifest.json` | Modify | Same `host_permissions`; add `country-utils.js` to `background.scripts`. |
| `platform/firefox_selfhosted/manifest.json` | Modify | Same as `platform/firefox/manifest.json`. |
| `CLAUDE.md` | Modify | Document the country/curated-blocklist mechanism. |

**Storage keys (`chrome.storage.local`):**
- `storageData` — unchanged shape; `filterData.country` is the user's country list (already persisted by the existing Country textarea).
- `remoteBlocklist` — **new** — `{ channels: string[], fetchedAt: number }`.
- `channelCountryMap` — **new** — `{ [channelId: string]: string | null }`. `null` = "checked, no location" (prevents re-harvest churn).

Kept separate from `storageData` so they do not bloat the user's export backup and do not appear in the options textareas.

---

## Task 1: Pure helpers — `country-utils.js`

**Files:**
- Create: `src/scripts/lib/country-utils.js`
- Test: `test/country-utils.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/country-utils.test.js`:

```js
'use strict';
const assert = require('node:assert');
const cu = require('../src/scripts/lib/country-utils.js');

// parseBlocklistText
assert.deepStrictEqual(
  cu.parseBlocklistText('UCGs-yDFkfHDbeQcApWkTtxg\nUCSajd4i4WsFI4JxsJ_vYbTw\n'),
  ['UCGs-yDFkfHDbeQcApWkTtxg', 'UCSajd4i4WsFI4JxsJ_vYbTw'],
  'parses valid IDs');
assert.deepStrictEqual(
  cu.parseBlocklistText('# comment\n// comment\n\n  UCGs-yDFkfHDbeQcApWkTtxg  \n'),
  ['UCGs-yDFkfHDbeQcApWkTtxg'],
  'skips comments/blanks, trims');
assert.deepStrictEqual(
  cu.parseBlocklistText('UCGs-yDFkfHDbeQcApWkTtxg\nUCGs-yDFkfHDbeQcApWkTtxg'),
  ['UCGs-yDFkfHDbeQcApWkTtxg'],
  'dedupes');
assert.deepStrictEqual(
  cu.parseBlocklistText('notachannelid\nUC-tooshort\n<script>'),
  [],
  'rejects malformed IDs');
assert.deepStrictEqual(cu.parseBlocklistText(null), [], 'null -> []');

// compileCountryList
assert.deepStrictEqual(
  cu.compileCountryList(['// Add your country filters below', '', 'Israel', '  Russia  ']),
  ['israel', 'russia'],
  'lowercases, trims, skips comments/blanks');
assert.deepStrictEqual(
  cu.compileCountryList(['Israel', 'israel', 'ISRAEL']),
  ['israel'],
  'dedupes case-insensitively');
assert.deepStrictEqual(cu.compileCountryList('Israel'), [], 'non-array -> []');

// blockedChannelIdsByCountry
assert.deepStrictEqual(
  cu.blockedChannelIdsByCountry(
    { UCaaa: 'Israel', UCbbb: 'France', UCccc: null, UCddd: 'israel' },
    ['israel']).sort(),
  ['UCaaa', 'UCddd'],
  'matches country case-insensitively, ignores null and non-matches');
assert.deepStrictEqual(
  cu.blockedChannelIdsByCountry({ UCaaa: 'Israel' }, []),
  [],
  'empty blocklist -> []');

console.log('country-utils: all assertions passed');
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node test/country-utils.test.js`
Expected: FAIL — `Cannot find module '../src/scripts/lib/country-utils.js'`.

- [ ] **Step 3: Implement `country-utils.js`**

Create `src/scripts/lib/country-utils.js`:

```js
'use strict';

// Pure, dependency-free helpers shared by background.js and the Node tests.
// No browser / extension APIs may be used here.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.countryUtils = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // A YouTube channel ID is "UC" followed by 22 url-safe base64 chars.
  const CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{22}$/;

  // Parse raw blocklist.txt into a deduped array of valid channel IDs.
  function parseBlocklistText(text) {
    if (typeof text !== 'string') return [];
    const seen = new Set();
    text.split(/\r?\n/).forEach((line) => {
      const id = line.trim();
      if (!id || id.startsWith('#') || id.startsWith('//')) return;
      if (!CHANNEL_ID_RE.test(id)) return;
      seen.add(id);
    });
    return [...seen];
  }

  // Normalize the user's country filter list into deduped lowercase names.
  // Skips blank lines and "//" comments. Lowercasing enables case-insensitive
  // matching against harvested country names.
  function compileCountryList(entriesArr) {
    if (!(entriesArr instanceof Array)) return [];
    const seen = new Set();
    entriesArr.forEach((raw) => {
      if (typeof raw !== 'string') return;
      const v = raw.trim();
      if (!v || v.startsWith('//')) return;
      seen.add(v.toLowerCase());
    });
    return [...seen];
  }

  // Given the channelId->country cache and a compiled (lowercase) country
  // list, return the channel IDs whose cached country is blocked.
  function blockedChannelIdsByCountry(channelCountryMap, compiledCountryList) {
    const blocked = new Set(compiledCountryList);
    if (blocked.size === 0) return [];
    const out = [];
    Object.keys(channelCountryMap || {}).forEach((cid) => {
      const country = channelCountryMap[cid];
      if (country && blocked.has(String(country).toLowerCase())) {
        out.push(cid);
      }
    });
    return out;
  }

  return { CHANNEL_ID_RE, parseBlocklistText, compileCountryList, blockedChannelIdsByCountry };
}));
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node test/country-utils.test.js`
Expected: PASS — `country-utils: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/lib/country-utils.js test/country-utils.test.js
git commit -m "feat: add country-utils pure helpers with tests"
```

---

## Task 2: Wire curated + country IDs into `background.js` compilation

This is the core of the feature: it makes `compileAll` append curated and country-derived channel IDs onto the compiled `channelId` list.

**Files:**
- Modify: `src/scripts/background.js` (lines 1-8 region, `utils` object ~36-83, storage load ~110-119)

- [ ] **Step 1: Load the helper and add module state**

In `src/scripts/background.js`, the file currently starts:

```js
'use strict';

const has = Object.prototype.hasOwnProperty;
```

Replace that with:

```js
'use strict';

// Load shared pure helpers. In the Chrome service worker importScripts()
// resolves relative to this file (src/scripts/). Firefox loads it via the
// manifest background.scripts array instead, so guard against double-load.
if (typeof countryUtils === 'undefined' && typeof importScripts === 'function') {
  importScripts('lib/country-utils.js');
}

const has = Object.prototype.hasOwnProperty;

// Curated remote channel blocklist + harvested channelId->country cache.
let remoteBlocklist = { channels: [], fetchedAt: 0 };
let channelCountryMap = {};
```

- [ ] **Step 2: Add `extraChannelIds` and extend `compileAll`**

In `background.js`, `compileAll` currently reads (lines 68-83):

```js
  compileAll(data) {
    const sendData = { filterData: {}, options: data.options };

    // compile regex props
    ['title', 'channelName', 'channelId', 'videoId', 'comment'].forEach((p) => {
      const dataArr = this.compileRegex(data.filterData[p], p);
      if (dataArr) {
        sendData.filterData[p] = dataArr;
      }
    });

    sendData.filterData.vidLength = data.filterData.vidLength;
    sendData.filterData.javascript = data.filterData.javascript;

    return sendData;
  },
```

Replace it with:

```js
  // Channel IDs to block in addition to the user's own channelId filter:
  // the curated remote blocklist + channels whose harvested country is in
  // the user's country filter.
  extraChannelIds(data) {
    const ids = new Set(remoteBlocklist.channels || []);
    const countryList = countryUtils.compileCountryList(
      (data.filterData && data.filterData.country) || []);
    countryUtils.blockedChannelIdsByCountry(channelCountryMap, countryList)
      .forEach(id => ids.add(id));
    return [...ids];
  },

  compileAll(data) {
    const sendData = { filterData: {}, options: data.options };

    // compile regex props
    ['title', 'channelName', 'channelId', 'videoId', 'comment'].forEach((p) => {
      const dataArr = this.compileRegex(data.filterData[p], p);
      if (dataArr) {
        sendData.filterData[p] = dataArr;
      }
    });

    sendData.filterData.vidLength = data.filterData.vidLength;
    sendData.filterData.javascript = data.filterData.javascript;

    // Append curated + country-derived channel IDs as exact-match regexes,
    // reusing the existing channelId filter engine in inject.js.
    const extraIds = this.extraChannelIds(data);
    if (extraIds.length > 0) {
      sendData.filterData.channelId = (sendData.filterData.channelId || [])
        .concat(extraIds.map(id => [`^${id}$`, '']));
    }

    return sendData;
  },
```

- [ ] **Step 3: Load the new storage keys at startup**

In `background.js`, the storage bootstrap currently reads (lines 110-119):

```js
chrome.storage.local.get(['storageData', 'enabled'], (data) => {
  if (data !== undefined && Object.keys(data).length > 0) {
    storage = data.storageData;
    compiledStorage = utils.compileAll(data.storageData);
  }
  if (Object.hasOwn(data, 'enabled')) {
    enabled = data.enabled
  }
  initStorage = true;
  utils.sendFiltersToAll();
```

Replace the `get` call and its body opening with:

```js
chrome.storage.local.get(
  ['storageData', 'enabled', 'remoteBlocklist', 'channelCountryMap'], (data) => {
  if (Object.hasOwn(data, 'remoteBlocklist')) {
    remoteBlocklist = data.remoteBlocklist;
  }
  if (Object.hasOwn(data, 'channelCountryMap')) {
    channelCountryMap = data.channelCountryMap;
  }
  if (data !== undefined && Object.keys(data).length > 0 && data.storageData) {
    storage = data.storageData;
  }
  compiledStorage = utils.compileAll(storage);
  if (Object.hasOwn(data, 'enabled')) {
    enabled = data.enabled
  }
  initStorage = true;
  utils.sendFiltersToAll();
```

> Note: `compiledStorage` is now always (re)built from `storage` so curated/country IDs apply even when the user never saved custom `storageData`.

- [ ] **Step 4: Manual verification**

Run: `./tools/build.sh chrome`
Then in Chrome: `chrome://extensions` → enable Developer mode → "Load unpacked" → select `dist/chrome/`.
Open the service-worker console (the "service worker" link on the extension card) and run:

```js
chrome.storage.local.set({
  remoteBlocklist: { channels: ['UCGs-yDFkfHDbeQcApWkTtxg'], fetchedAt: Date.now() },
  channelCountryMap: { UCSajd4i4WsFI4JxsJ_vYbTw: 'Israel' }
});
```

Reload the extension, then in the service-worker console run:

```js
compiledStorage.filterData.channelId
```

Expected: the array contains `["^UCGs-yDFkfHDbeQcApWkTtxg$", ""]`. (The `channelCountryMap` entry will NOT appear yet because no country is in the user's filter — that is verified in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add src/scripts/background.js
git commit -m "feat: append curated + country channel IDs to compiled filter"
```

---

## Task 3: Remote blocklist fetch in `background.js`

**Files:**
- Modify: `src/scripts/background.js` (after the `utils` object; inside the storage bootstrap; new `onMessage` listener)

- [ ] **Step 1: Add the fetch function**

In `background.js`, immediately after the closing `};` of the `utils` object (currently line 108), add:

```js
const BLOCKLIST_URL =
  'https://raw.githubusercontent.com/Sitric1/channel-blocklist/main/blocklist.txt';
const BLOCKLIST_TTL = 24 * 60 * 60 * 1000; // re-fetch at most once per day

// Fetch the curated channel blocklist, store it, recompile and rebroadcast.
async function fetchRemoteBlocklist(force = false) {
  const now = Date.now();
  if (!force && remoteBlocklist.fetchedAt
      && (now - remoteBlocklist.fetchedAt) < BLOCKLIST_TTL) {
    return remoteBlocklist;
  }
  try {
    const resp = await fetch(BLOCKLIST_URL, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const channels = countryUtils.parseBlocklistText(await resp.text());
    remoteBlocklist = { channels, fetchedAt: now };
    await chrome.storage.local.set({ remoteBlocklist });
    compiledStorage = utils.compileAll(storage);
    utils.sendFiltersToAll();
  } catch (e) {
    console.error('BlockTube: remote blocklist fetch failed', e);
  }
  return remoteBlocklist;
}
```

> `remoteBlocklist` / `channelCountryMap` writes do NOT trigger a recompile loop: the `chrome.storage.onChanged` listener (lines 140-150) only reacts to `storageData` and `enabled`.

- [ ] **Step 2: Fetch on startup**

In `background.js`, inside the storage bootstrap callback, just after `utils.sendFiltersToAll();` (the line that follows `initStorage = true;`), add:

```js
  fetchRemoteBlocklist();
```

- [ ] **Step 3: Add the options-page message handler**

In `background.js`, after the `chrome.runtime.onInstalled.addListener(...)` block at the end of the file, add:

```js
// Messages from the options page (not a content script, so not a port).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'updateBlocklist') {
    fetchRemoteBlocklist(true).then((rb) => sendResponse({
      channels: rb.channels.length, fetchedAt: rb.fetchedAt,
    }));
    return true; // async sendResponse
  }
  if (msg.type === 'getBlocklistInfo') {
    sendResponse({
      channels: remoteBlocklist.channels.length,
      fetchedAt: remoteBlocklist.fetchedAt,
    });
    return false;
  }
  return false;
});
```

- [ ] **Step 4: Manual verification**

Run: `./tools/build.sh chrome`, reload the unpacked extension. In the service-worker console run:

```js
fetchRemoteBlocklist(true).then(rb => console.log(rb.channels.length, rb.fetchedAt));
```

Expected: logs a non-zero channel count (~21) and a recent timestamp. Then:

```js
chrome.storage.local.get('remoteBlocklist', console.log);
compiledStorage.filterData.channelId.some(r => r[0] === '^UCGs-yDFkfHDbeQcApWkTtxg$');
```

Expected: stored `remoteBlocklist.channels` is populated; the `.some(...)` returns `true`.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/background.js
git commit -m "feat: fetch curated channel blocklist from GitHub"
```

---

## Task 4: Country default + country harvest recording in `background.js`

**Files:**
- Modify: `src/scripts/background.js` (default `storage` ~9-19, the port `onMessage` switch ~128-136)

- [ ] **Step 1: Add `country` to the default storage schema**

In `background.js`, the default `storage.filterData` (lines 10-19) currently ends:

```js
    title: [],
    vidLength: [null, null],
    javascript: "",
    percentWatchedHide: null
  },
```

Replace with:

```js
    title: [],
    country: [],
    vidLength: [null, null],
    javascript: "",
    percentWatchedHide: null
  },
```

- [ ] **Step 2: Add the `channelCountry` port handler**

In `background.js`, the port `onMessage` switch (lines 128-136) currently is:

```js
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'contextBlock': {
          storage.filterData[msg.data.type].push(...msg.data.entries);
          chrome.storage.local.set({storageData: storage});
          break;
        }
      }
    });
```

Replace with:

```js
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'contextBlock': {
          storage.filterData[msg.data.type].push(...msg.data.entries);
          chrome.storage.local.set({storageData: storage});
          break;
        }
        case 'channelCountry': {
          recordChannelCountry(msg.data);
          break;
        }
      }
    });
```

- [ ] **Step 3: Add `recordChannelCountry`**

In `background.js`, just below `fetchRemoteBlocklist` (added in Task 3), add:

```js
// Record a harvested channelId->country pair into the persistent cache.
// `data.country` is a country name string, or null meaning "checked, no
// location" (so we stop re-harvesting that channel).
function recordChannelCountry(data) {
  if (!data || !data.channelId) return;
  const prev = channelCountryMap[data.channelId];
  const next = data.country || null;
  // Never downgrade a known country back to null.
  if (prev != null && next === null) return;
  if (prev === next) return; // no change -> no recompile
  channelCountryMap[data.channelId] = next;
  chrome.storage.local.set({ channelCountryMap });
  compiledStorage = utils.compileAll(storage);
  utils.sendFiltersToAll();
}
```

- [ ] **Step 4: Manual verification**

Run: `./tools/build.sh chrome`, reload the extension. In the service-worker console:

```js
recordChannelCountry({ channelId: 'UCtesttesttesttesttest00', country: 'Israel' });
chrome.storage.local.get('channelCountryMap', console.log);
```

Expected: `channelCountryMap` contains `{ UCtesttesttesttesttest00: 'Israel' }`.
Then verify the null-downgrade guard:

```js
recordChannelCountry({ channelId: 'UCtesttesttesttesttest00', country: null });
chrome.storage.local.get('channelCountryMap', d => console.log(d.channelCountryMap));
```

Expected: value is still `'Israel'` (not overwritten with null).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/background.js
git commit -m "feat: record harvested channel country in background cache"
```

---

## Task 5: Country harvester in `inject.js`

`inject.js` reads channel country out of intercepted `/youtubei/v1/browse` JSON and posts it to the content script. It blocks nothing itself — blocking is done by the compiled `channelId` list from `background.js`.

**Files:**
- Modify: `src/scripts/inject.js` (`postMessage` helper ~943; `fetchFilter` ~1085-1114; `spfFilter` ~1116-1155; `startHook` ~1744-1751)

- [ ] **Step 1: Add the harvester near the `postMessage` helper**

In `inject.js`, find the `postMessage` helper (around line 943):

```js
  function postMessage(type, data) {
    window.postMessage({ from: 'BLOCKTUBE_PAGE', type, data }, document.location.origin);
  }
```

Immediately AFTER that function, add:

```js
  // Remember the channel ID of the most recent channel browse response so a
  // later About continuation (which omits it) can be paired with it.
  let lastChannelBrowseId;

  // Depth-limited recursive search for the first object carrying `key`.
  function deepFindKey(obj, key, depth = 0) {
    if (depth > 12 || obj === null || typeof obj !== 'object') return undefined;
    if (has.call(obj, key)) return obj[key];
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i += 1) {
      const found = deepFindKey(obj[keys[i]], key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // Pull (channelId, country) out of an intercepted browse response and
  // report it to the background cache via the content script.
  // Only reports when channel About metadata is actually present, so a plain
  // Videos-tab browse never produces a misleading "no location" record.
  function harvestChannelCountry(resp) {
    try {
      const externalId = getObjectByPath(resp, 'metadata.channelMetadataRenderer.externalId');
      if (externalId) lastChannelBrowseId = externalId;

      // Modern About panel.
      const aboutVM = deepFindKey(resp, 'aboutChannelViewModel');
      // Legacy About metadata renderer.
      const aboutLegacy = deepFindKey(resp, 'channelAboutFullMetadataRenderer');
      if (aboutVM === undefined && aboutLegacy === undefined) return;

      let country;
      if (aboutVM && typeof aboutVM.country === 'string') {
        country = aboutVM.country.trim();
      } else if (aboutLegacy) {
        country = getObjectByPath(aboutLegacy, 'country.simpleText');
        if (typeof country === 'string') country = country.trim();
      }

      const channelId = externalId || lastChannelBrowseId;
      if (!channelId) return;
      postMessage('channelCountry', { channelId, country: country || null });
    } catch (e) { /* harvesting is best-effort */ }
  }
```

> `getObjectByPath` and `has` already exist in `inject.js`'s scope.

- [ ] **Step 2: Harvest from `fetchFilter` browse responses**

In `inject.js` `fetchFilter` (line 1088), the browse branch currently is:

```js
    if (['/youtubei/v1/search', '/youtubei/v1/browse'].includes(url.pathname)) {
      ObjectFilter(resp, filterRules.main, [], true);
    }
```

Replace with:

```js
    if (['/youtubei/v1/search', '/youtubei/v1/browse'].includes(url.pathname)) {
      ObjectFilter(resp, filterRules.main, [], true);
      if (url.pathname === '/youtubei/v1/browse') harvestChannelCountry(resp);
    }
```

- [ ] **Step 3: Harvest from `spfFilter` responses**

In `inject.js` `spfFilter`, the `response`/`data` branch ends (line 1152) with:

```js
        ObjectFilter(obj.response || obj.data, rules, postActions, true);
      }
    });
  }
```

Replace with:

```js
        ObjectFilter(obj.response || obj.data, rules, postActions, true);
        harvestChannelCountry(obj.response || obj.data);
      }
    });
  }
```

- [ ] **Step 4: Harvest from the initial `ytInitialData`**

In `inject.js` `startHook` (lines 1745-1751), the `ytInitialData` block currently is:

```js
    if (typeof window.ytInitialData === 'object' && window.ytInitialData !== null) {
      ObjectFilter(window.ytInitialData, mergedFilterRules, (window.ytInitialData.contents && currentBlock) ? postActions.concat(redirectToNext) : postActions, true);
    } else {
      defineProperty('ytInitialData', undefined, (v) => {
        ObjectFilter(v, mergedFilterRules, (v.contents && currentBlock) ? postActions.concat(redirectToNext) : postActions, true)
      });
    }
```

Replace with:

```js
    if (typeof window.ytInitialData === 'object' && window.ytInitialData !== null) {
      ObjectFilter(window.ytInitialData, mergedFilterRules, (window.ytInitialData.contents && currentBlock) ? postActions.concat(redirectToNext) : postActions, true);
      harvestChannelCountry(window.ytInitialData);
    } else {
      defineProperty('ytInitialData', undefined, (v) => {
        ObjectFilter(v, mergedFilterRules, (v.contents && currentBlock) ? postActions.concat(redirectToNext) : postActions, true);
        harvestChannelCountry(v);
      });
    }
```

- [ ] **Step 5: Manual verification**

Run: `./tools/build.sh chrome`, reload the extension. Open a YouTube channel that has a country set, click its **About** panel (or open `youtube.com/@<handle>/about`). Open the YouTube tab's DevTools console (page context) — no error from `harvestChannelCountry` should appear. Then in the extension's **service-worker** console:

```js
chrome.storage.local.get('channelCountryMap', d => console.log(d.channelCountryMap));
```

Expected: `channelCountryMap` now contains an entry mapping that channel's `UC…` ID to its country name (e.g. `"Israel"`), or `null` if the channel published no location.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/inject.js
git commit -m "feat: harvest channel country from intercepted browse JSON"
```

---

## Task 6: Fix `content_script.js` — relay + remove the broken blocker

**Files:**
- Modify: `src/scripts/content_script.js` (lines 9-41 and 112-139)

- [ ] **Step 1: Replace the broken country helpers**

In `content_script.js`, delete the block from line 9 (`// Helper to get blocked countries from storage`) through line 41 (the closing `}` of `blockChannelByCountry`) — i.e. `getBlockedCountries`, `extractChannelCountry`, `blockChannelByCountry`. Replace that whole block with:

```js
  // Fallback country harvest from the channel-page DOM (used when the About
  // panel data was not seen in an intercepted browse response). Reads the
  // canonical channel ID and, if the About dialog is open, its country.
  function harvestCountryFromDom() {
    const canonical = document.querySelector('link[rel="canonical"]');
    const m = canonical && canonical.href.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
    if (!m) return;
    const channelId = m[1];

    let country = null;
    const rows = document.querySelectorAll(
      'ytd-about-channel-renderer #country, #additional-info-container tr');
    rows.forEach((row) => {
      const text = row.textContent.trim();
      if (text) country = text;
    });
    port.postMessage({ type: 'channelCountry', data: { channelId, country } });
  }
```

> The old page-overwrite behavior is intentionally gone: a country-blocked channel's ID is now in the compiled `channelId` list, so `inject.js`'s existing channel-page rules (`redirectToIndex`) handle it.

- [ ] **Step 2: Replace the channel-page trigger block**

In `content_script.js`, the block at lines 112-121 currently is:

```js
    // Run country blocking on channel pages
    if (window.location.pathname.startsWith('/channel/') || window.location.pathname.startsWith('/@')) {
      // Wait for About tab to load
      const tryBlock = () => {
        blockChannelByCountry();
      };
      // Try immediately and after DOM changes
      document.addEventListener('DOMContentLoaded', tryBlock);
      setTimeout(tryBlock, 2000); // Fallback for SPA navigation
    }
```

Replace with:

```js
  // Backfill the country cache on channel pages, and re-run on SPA nav.
  function maybeHarvestCountry() {
    const path = window.location.pathname;
    if (path.startsWith('/channel/') || path.startsWith('/@') || path.startsWith('/c/')) {
      setTimeout(harvestCountryFromDom, 1500);
    }
  }
  document.addEventListener('DOMContentLoaded', maybeHarvestCountry);
  window.addEventListener('yt-navigate-finish', maybeHarvestCountry, true);
```

- [ ] **Step 3: Relay `channelCountry` page messages to the background**

In `content_script.js`, the page-message `switch` (lines 128-138) currently is:

```js
    switch (event.data.type) {
      case 'contextBlockData': {
        events.contextBlock(event.data.data);
        break;
      }
      case 'ready': {
        utils.sendStorage();
      }
      default:
        break;
    }
```

Replace with:

```js
    switch (event.data.type) {
      case 'contextBlockData': {
        events.contextBlock(event.data.data);
        break;
      }
      case 'channelCountry': {
        port.postMessage({ type: 'channelCountry', data: event.data.data });
        break;
      }
      case 'ready': {
        utils.sendStorage();
        break;
      }
      default:
        break;
    }
```

- [ ] **Step 4: Manual verification**

Run: `./tools/build.sh chrome`, reload the extension. Open a YouTube channel page (`/@<handle>`). In the extension service-worker console:

```js
chrome.storage.local.get('channelCountryMap', d => console.log(d.channelCountryMap));
```

Expected: an entry for that channel appears (from the inject.js harvest of Task 5 and/or the DOM fallback). No page-context console errors. The page must NOT be replaced by a "Blocked by country" white screen.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/content_script.js
git commit -m "fix: replace broken country blocker with cache relay + DOM fallback"
```

---

## Task 7: End-to-end country blocking verification

No code change — this confirms the data path from country filter → blocked render. Treat each checkbox as a verification gate; if one fails, debug before continuing.

**Files:** none.

- [ ] **Step 1: Build and load**

Run: `./tools/build.sh chrome`, reload the unpacked `dist/chrome/`.

- [ ] **Step 2: Seed a known channel→country pair**

In the service-worker console:

```js
recordChannelCountry({ channelId: 'UCGs-yDFkfHDbeQcApWkTtxg', country: 'Israel' });
```

(`UCGs-yDFkfHDbeQcApWkTtxg` = `tv7israelnews` from the curated list — a real channel.)

- [ ] **Step 3: Add the country to the filter**

Open the extension Options page → **Country** tab → type `Israel` on its own line → **Save**.

- [ ] **Step 4: Verify compilation**

In the service-worker console:

```js
compiledStorage.filterData.channelId.some(r => r[0] === '^UCGs-yDFkfHDbeQcApWkTtxg$');
```

Expected: `true` — the country-derived ID was appended.

- [ ] **Step 5: Verify blocking in the feed**

Search YouTube for `tv7 israel news`. Expected: videos from the `tv7israelnews` channel do **not** render in results. Visit `youtube.com/@tv7israelnews` directly — expected: BlockTube redirects away from the channel page (existing `redirectToIndex` behavior).

- [ ] **Step 6: Verify removal re-enables**

Remove `Israel` from the Country tab → Save. Reload a YouTube search for `tv7 israel news`. Expected: the channel's videos render again (the cache entry remains, but it is no longer compiled into the filter).

- [ ] **Step 7: Record result (no commit)**

This task changes no files. Record the verification result in the PR description.

---

## Task 8: Options UI — "Update curated blocklist" button

**Files:**
- Modify: `src/ui/options.html` (Country tab `<section id="country-tab-content">`, ~line 93-98)
- Modify: `src/ui/options.js` (after the `import`/`export` button wiring, ~line 327)

- [ ] **Step 1: Add the button to the Country tab**

In `src/ui/options.html`, the Country section currently is:

```html
                <section id="country-tab-content" class="tab-panel">
                  <div>
                    <textarea id="country"></textarea>
                    <div id="country_resizer" class="cm-resizer"></div>
                  </div>
                </section>
```

Replace with:

```html
                <section id="country-tab-content" class="tab-panel">
                  <div>
                    <textarea id="country"></textarea>
                    <div id="country_resizer" class="cm-resizer"></div>
                    <div class="blocklist-controls">
                      <button type="button" id="update_blocklist">Update curated blocklist</button>
                      <span id="blocklist_status"></span>
                    </div>
                  </div>
                </section>
```

- [ ] **Step 2: Wire the button in `options.js`**

In `src/ui/options.js`, after the `$('myfile').addEventListener('change', importOptions, false);` line (~line 327), add:

```js
  function renderBlocklistStatus(info) {
    const el = $('blocklist_status');
    if (!el) return;
    if (!info || !info.fetchedAt) {
      el.textContent = 'Curated blocklist: never fetched';
      return;
    }
    el.textContent = `Curated blocklist: ${info.channels} channels (updated `
      + `${new Date(info.fetchedAt).toLocaleString()})`;
  }

  chrome.runtime.sendMessage({ type: 'getBlocklistInfo' }, renderBlocklistStatus);

  $('update_blocklist').addEventListener('click', () => {
    $('blocklist_status').textContent = 'Updating…';
    chrome.runtime.sendMessage({ type: 'updateBlocklist' }, renderBlocklistStatus);
  });
```

> The button intentionally writes nothing into the `country` textarea — the curated list lives in the separate `remoteBlocklist` storage key. `textContent` is used (never HTML assignment) so the status string cannot inject markup.

- [ ] **Step 3: Manual verification**

Run: `./tools/build.sh chrome`, reload the extension, open Options → **Country** tab.
Expected: a "Update curated blocklist" button and a status line are visible. Click the button. Expected: status briefly shows `Updating…`, then `Curated blocklist: N channels (updated …)` with `N` non-zero.

- [ ] **Step 4: Commit**

```bash
git add src/ui/options.html src/ui/options.js
git commit -m "feat: add curated blocklist update button to options"
```

---

## Task 9: Manifests — host permission + Firefox script load

**Files:**
- Modify: `platform/chrome/manifest.json`
- Modify: `platform/firefox/manifest.json`
- Modify: `platform/firefox_selfhosted/manifest.json`

- [ ] **Step 1: Chrome manifest — add `host_permissions`**

In `platform/chrome/manifest.json`, the `permissions` block currently is:

```json
  "permissions": [
    "storage",
    "unlimitedStorage"
  ],
```

Replace with:

```json
  "permissions": [
    "storage",
    "unlimitedStorage"
  ],
  "host_permissions": [
    "https://raw.githubusercontent.com/*"
  ],
```

- [ ] **Step 2: Firefox manifest — `host_permissions` + background script order**

In `platform/firefox/manifest.json`, apply the same `host_permissions` addition as Step 1. Additionally, the `background` block currently is:

```json
  "background": {
    "scripts": ["src/scripts/background.js"]
  },
```

Replace with:

```json
  "background": {
    "scripts": ["src/scripts/lib/country-utils.js", "src/scripts/background.js"]
  },
```

> `country-utils.js` must precede `background.js` so the `countryUtils` global exists. Firefox does not run `importScripts` from the manifest background; the `if (typeof countryUtils === 'undefined' …)` guard in `background.js` (Task 2) means the Chrome `importScripts` call is skipped here.

- [ ] **Step 3: Firefox self-hosted manifest**

Apply BOTH changes from Step 2 to `platform/firefox_selfhosted/manifest.json` (same `host_permissions` block and same `background.scripts` array).

- [ ] **Step 4: Manual verification**

Run: `./tools/build.sh chrome` and `./tools/build.sh firefox`.
Chrome: reload `dist/chrome/` — no manifest error on the extension card; the Task 3 fetch succeeds (no CORS/permission error in the service-worker console).
Firefox: load `dist/firefox/` via `about:debugging` → "This Firefox" → "Load Temporary Add-on" → pick `dist/firefox/manifest.json`. Open the extension's background console (`about:debugging` → Inspect) and confirm no `countryUtils is not defined` error, and `fetchRemoteBlocklist(true)` populates `remoteBlocklist`.

- [ ] **Step 5: Commit**

```bash
git add platform/chrome/manifest.json platform/firefox/manifest.json platform/firefox_selfhosted/manifest.json
git commit -m "chore: grant raw.githubusercontent.com host permission"
```

---

## Task 10: Documentation + full build verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the mechanism in `CLAUDE.md`**

In `CLAUDE.md`, find the `### Storage shape` section. Immediately after it, add:

```markdown
### Country & curated-channel blocking

Country blocking is implemented as channel-ID blocking, not a separate filter
pass:

- `chrome.storage.local` holds two extra keys beside `storageData`:
  `remoteBlocklist` (`{ channels, fetchedAt }` — a curated channel-ID list
  fetched from `raw.githubusercontent.com/Sitric1/channel-blocklist`) and
  `channelCountryMap` (`{ channelId: countryName | null }` — a harvested
  cache; `null` means "checked, no location").
- `background.js` `utils.compileAll` appends, onto the compiled `channelId`
  regex list, every curated ID plus every cached channel whose country is in
  the user's `filterData.country` filter (`extraChannelIds`). The existing
  `inject.js` channel-ID engine then blocks them everywhere.
- `inject.js` `harvestChannelCountry` scans intercepted `/youtubei/v1/browse`
  JSON for `aboutChannelViewModel.country` (or legacy
  `channelAboutFullMetadataRenderer`) and posts `channelCountry` to
  `content_script.js`, which relays it to `background.js` `recordChannelCountry`.
- `content_script.js` also has a channel-page DOM-scrape fallback.
- Pure helpers live in `src/scripts/lib/country-utils.js` (dual-mode export);
  Node tests in `test/country-utils.test.js` run via `node test/country-utils.test.js`.
```

- [ ] **Step 2: Run the helper test**

Run: `node test/country-utils.test.js`
Expected: PASS — `country-utils: all assertions passed`.

- [ ] **Step 3: Lint**

Run: `npx eslint src/`
Expected: no new errors introduced by the changed files (`background.js`, `inject.js`, `content_script.js`, `options.js`, `lib/country-utils.js`). Pre-existing warnings unrelated to this work may remain.

- [ ] **Step 4: Build all three targets**

Run:
```bash
./tools/build.sh chrome
./tools/build.sh firefox
./tools/build.sh firefox_selfhosted
```
Expected: each produces `dist/<target>/blocktube_<target>_v<VERSION>.zip` with no error. Confirm `dist/firefox/src/scripts/lib/country-utils.js` exists inside the build (the `lib/` dir is copied because `build.sh` copies all of `src/`).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document country & curated-channel blocking"
```

---

## Task 11 (Optional): Proactive country prefetch

The base plan is *permissive* — a channel's videos may appear until its country has been harvested from a browse response the user happens to trigger. This optional task proactively fills the cache.

**Files:**
- Modify: `src/scripts/inject.js`

- [ ] **Step 1: Add a rate-limited About prefetch**

In `inject.js`, after `harvestChannelCountry`, add a queue that, for channel IDs seen in feed renderers but absent from a known set, issues at most one `/youtubei/v1/browse` About request every ~3 seconds using the page's own `ytcfg` innertube context (`window.ytcfg.get('INNERTUBE_API_KEY')`, `INNERTUBE_CONTEXT`), with params `EgVhYm91dPIGBAoCEgA%3D` (the About tab). Feed the response through `harvestChannelCountry`. Cap the queue (e.g. 200 IDs) and never re-queue an ID already reported.

- [ ] **Step 2: Manual verification**

Load a YouTube home feed cold (cleared `channelCountryMap`). Within a minute, the service-worker `channelCountryMap` should accumulate entries for channels visible in the feed without the user opening any channel page.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/inject.js
git commit -m "feat: proactively prefetch channel countries (optional)"
```

> Decide at execution time whether to include this — it adds network traffic from the page context and is more fragile than passive harvesting. Ship Tasks 1-10 first; add this only if the permissive delay is unacceptable.

---

## Self-Review

**Spec coverage:**
- "Wire `country` into background.js" → Tasks 2, 4 (default schema, `extraChannelIds`, `recordChannelCountry`). ✅
- "Wire `country` into inject.js" → reframed: no inject.js *filter* change needed (country IDs ride the compiled `channelId` list); inject.js gains harvesting (Task 5). ✅ — documented in Architecture so the executor understands the reframe.
- "Fix the channel-page blocker" → Task 6 (removes the page-overwrite, SPA re-trigger via `yt-navigate-finish`, code↔name handled by case-insensitive `compileCountryList`). ✅
- "Curated channels pulled from the GitHub repo" → Tasks 1, 3, 8. ✅
- "Persistent cache `channelCountryMap`, `null` for checked-no-location" → Tasks 2, 4 (`recordChannelCountry` null-downgrade guard). ✅
- "Country names as strings matching YouTube's Location" → harvested verbatim; matched case-insensitively. ✅
- "Pull occasionally" → Task 3 daily TTL + manual button (Task 8). ✅
- "UI writes the same `filterData.country` array" → existing Country textarea already does; Task 8 only adds the curated-update button. ✅

**Placeholder scan:** Task 11 (optional) is described prose-only by design — it is explicitly optional and gated on a runtime decision; Tasks 1-10 contain complete code. No TBD/TODO in shipped tasks. ✅

**Type consistency:** `remoteBlocklist` shape `{channels, fetchedAt}` consistent across Tasks 2/3/8. `channelCountryMap` is `{channelId: string|null}` across Tasks 2/4/5. `channelCountry` message shape `{channelId, country}` consistent across inject.js (Task 5) → content_script.js (Task 6) → background.js (Task 4). `countryUtils` function names (`parseBlocklistText`, `compileCountryList`, `blockedChannelIdsByCountry`) consistent between Task 1 definition and Task 2 use. ✅
