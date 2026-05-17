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
