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
const unicodeBoundry = "[ \n\r\t!@#$%^&*()_\\-=+\\[\\]\\\\\\|;:'\",\\.\\/<>\\?`~:]+";
const ports = {};
let enabled = true;
let initStorage = false;
let compiledStorage;
let storage = {
  filterData: {
    videoId: [],
    channelId: [],
    channelName: [],
    comment: [],
    title: [],
    vidLength: [null, null],
    javascript: "",
    percentWatchedHide: null
  },
  options: {
    trending: false,
    mixes: false,
    shorts: false,
    movies: false,
    suggestions_only: false,
    autoplay: false,
    enable_javascript: false,
    block_message: "",
    block_feedback: false,
    disable_db_normalize: false,
    disable_you_there: false,
    disable_on_history: false
  },
};

const utils = {
  compileRegex(entriesArr, type) {
    if (!(entriesArr instanceof Array)) {
      return undefined;
    }
    // empty dataset
    if (entriesArr.length === 1 && entriesArr[0] === '') return [];

    // skip empty and comments lines
    const filtered = [...new Set(entriesArr.filter(x => !(!x || x === '' || x.startsWith('//'))))];

    return filtered.map((v) => {
      v = v.trim();

      // unique id
      if (['channelId', 'videoId'].includes(type)) {
        return [`^${v}$`, ''];
      }

      // raw regex
      const parts = /^\/(.*)\/(.*)$/.exec(v);
      if (parts !== null) {
        return [parts[1], parts[2]];
      }

      // regular keyword
      return ['(^|' + unicodeBoundry + ')(' +
        v.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&') +
        ')(' + unicodeBoundry + '|$)', 'i'];
    });
  },

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

  sendFilters(port) {
    port.postMessage({ type: 'filtersData', data: { storage, compiledStorage, enabled } });
  },

  sendFiltersToAll() {
    Object.keys(ports).forEach((p) => {
      try {
        ports[p].postMessage({ type: 'filtersData', data: { storage, compiledStorage, enabled } });
      } catch (e) {
        console.error('Where are you my child?');
      }
    });
  },

  sendReloadToAll() {
    Object.keys(ports).forEach((p) => {
      try {
        ports[p].postMessage({ type: 'reloadRequired'});
      } catch (e) {
        console.error('Where are you my child?');
      }
    });
  }
};

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

  chrome.runtime.onConnect.addListener((port) => {
    port.onDisconnect.addListener((port) => {
        const key = port.sender.contextId || port.sender.frameId;
        delete ports[key];
    });
    const key = port.sender.contextId || port.sender.frameId;
    ports[key] = port;
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'contextBlock': {
          storage.filterData[msg.data.type].push(...msg.data.entries);
          chrome.storage.local.set({storageData: storage});
          break;
        }
      }
    });
    utils.sendFilters(port);
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (has.call(changes, 'storageData')) {
      storage = changes.storageData.newValue;
      compiledStorage = utils.compileAll(changes.storageData.newValue);
      utils.sendFiltersToAll();
    }
    if (has.call(changes, 'enabled')) {
      enabled = changes.enabled.newValue;
      utils.sendFiltersToAll();
    }
  });

});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.UPDATE) {
    utils.sendReloadToAll();
  }
})