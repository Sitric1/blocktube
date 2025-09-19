(function () {
  'use strict';
  
  let port;
  let globalStorage;
  let compiledStorage;
  let enabled;

  // Helper to get blocked countries from storage
  function getBlockedCountries() {
    if (!globalStorage || !globalStorage.filterData || !globalStorage.filterData.country) return [];
    return globalStorage.filterData.country.filter(c => c && !c.startsWith('//'));
  }

  // Helper to extract country from channel About tab
  function extractChannelCountry() {
    // YouTube About tab: Location is usually in a span with text 'Location'
    const aboutLabels = document.querySelectorAll('yt-formatted-string');
    for (let label of aboutLabels) {
      if (label.textContent.trim() === 'Location') {
        // Next sibling is the country value
        const countryElem = label.nextElementSibling;
        if (countryElem) {
          return countryElem.textContent.trim();
        }
      }
    }
    // Alternative: Look for 'Country' or other variants
    return null;
  }

  // Block channel if country matches
  function blockChannelByCountry() {
    const blockedCountries = getBlockedCountries();
    if (!blockedCountries.length) return;
    const country = extractChannelCountry();
    if (country && blockedCountries.includes(country)) {
      // Hide channel content or redirect
      document.body.innerHTML = '<div style="padding:2em;text-align:center;font-size:2em;">Blocked by country: ' + country + '</div>';
    }
  }

  const utils = {
    sendStorage() {
      window.postMessage({
        from: 'BLOCKTUBE_CONTENT',
        type: 'storageData',
        data: enabled ? (compiledStorage || globalStorage) : undefined,
      }, document.location.origin);
    },
    sendReload(msg, duration) {
      window.postMessage({
        from: 'BLOCKTUBE_CONTENT',
        type: 'reloadRequired',
        data: {msg, duration}
      }, document.location.origin);
    }
  };

  const events = {
    contextBlock(data) {
      if (!data.info.id) return;

      const options = {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric"
      }
      let now = new Intl.DateTimeFormat(undefined, options).format(new Date())
      const entries = [`// Blocked by context menu (${data.info.text}) (${now})`];
      const id = Array.isArray(data.info.id) ? data.info.id : [data.info.id];
      entries.push(...id);
      entries.push('');
      port.postMessage({'type': 'contextBlock', 'data': {'type': data.type, 'entries': entries}})
    }
  };

  function connectToPort() {
    port = chrome.runtime.connect();
    // Listen for messages from background page
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'filtersData': {
          if (msg.data) {
            globalStorage = msg.data.storage;
            compiledStorage = msg.data.compiledStorage;
            enabled = msg.data.enabled;
            utils.sendStorage();
          }
          break;
        }
        case 'reloadRequired': {
          utils.sendReload();
          break;
        }
        default:
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      connectToPort();
      
    });
  }

  connectToPort();

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

  // Listen for messages from injected page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data.from || event.data.from !== 'BLOCKTUBE_PAGE') return;

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
  }, true);

}());
