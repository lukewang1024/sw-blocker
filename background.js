const SCRIPT_ID = 'sw-cache-blocker-inject';

// --- Dynamic content script registration ---

async function getBlacklist() {
  const { blacklist = [] } = await chrome.storage.sync.get('blacklist');
  return blacklist;
}

// *.feishu.cn  → *://*.feishu.cn/*
// feishu.cn    → *://feishu.cn/* + *://*.feishu.cn/*
function domainToMatchPatterns(domain) {
  if (domain.startsWith('*.')) {
    return [`*://${domain}/*`];
  }
  return [`*://${domain}/*`, `*://*.${domain}/*`];
}

async function updateContentScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (_) {}

  const blacklist = await getBlacklist();
  updateBadge(blacklist.length);

  if (blacklist.length === 0) return;

  const matches = blacklist.flatMap(domainToMatchPatterns);

  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      matches,
      js: ['inject.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    },
  ]);
}

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
}

// --- Lifecycle ---

chrome.runtime.onInstalled.addListener(updateContentScripts);
chrome.runtime.onStartup.addListener(updateContentScripts);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.blacklist) {
    updateContentScripts();
  }
});

// --- Domain matching (supports wildcards) ---

function hostnameMatchesEntry(hostname, entry) {
  const h = hostname.replace(/^www\./, '');
  if (entry.startsWith('*.')) {
    const base = entry.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return h === entry || h.endsWith('.' + entry);
}

function hostnameMatchesAny(hostname, entries) {
  return entries.some((e) => hostnameMatchesEntry(hostname, e));
}

// --- Cleanup ---

function getMatchingTabs(entries) {
  return chrome.tabs.query({}).then((tabs) =>
    tabs.filter((tab) => {
      try {
        return tab.url && hostnameMatchesAny(new URL(tab.url).hostname, entries);
      } catch {
        return false;
      }
    })
  );
}

// Unregister SWs using the ISOLATED content script world.
// ISOLATED world has pristine Web API prototypes that page JS cannot override.
// Unlike MAIN world, getRegistrations() here always calls the real browser implementation.
async function unregisterSWsOnTab(tabId) {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    // ISOLATED world (default) — page JS cannot tamper with these prototypes
    func: async () => {
      if (!navigator.serviceWorker) return { origin: location.origin, count: 0, scopes: [], error: null };
      try {
        // Primary: getRegistrations() should return ALL registrations for the origin
        let regs = await navigator.serviceWorker.getRegistrations();

        // Fallback: if getRegistrations() returns 0, try getRegistration(url) with
        // paths discovered from the page's navigation links. Some Chrome versions may
        // not return cross-scope registrations from getRegistrations().
        if (regs.length === 0) {
          const paths = new Set(['/']);
          document.querySelectorAll('a[href]').forEach((a) => {
            try {
              const url = new URL(a.href, location.origin);
              if (url.origin === location.origin) {
                const seg = url.pathname.split('/').filter(Boolean)[0];
                if (seg) paths.add('/' + seg + '/');
              }
            } catch {}
          });
          const found = new Map();
          for (const p of paths) {
            try {
              const r = await navigator.serviceWorker.getRegistration(location.origin + p);
              if (r && !found.has(r.scope)) found.set(r.scope, r);
            } catch {}
          }
          if (found.size > 0) {
            console.log('[SWCB] getRegistrations() returned 0, but getRegistration() found:', [...found.keys()]);
            regs = [...found.values()];
          }
        }

        const scopes = regs.map((r) => r.scope);
        await Promise.all(regs.map((r) => r.unregister()));
        return { origin: location.origin, count: regs.length, scopes, error: null };
      } catch (err) {
        return { origin: location.origin, count: 0, scopes: [], error: String(err) };
      }
    },
  });
  return frameResults;
}

async function cleanupDomains(domains) {
  const allTabs = await chrome.tabs.query({});
  const matchedTabs = allTabs.filter((tab) => {
    try {
      return tab.url && hostnameMatchesAny(new URL(tab.url).hostname, domains);
    } catch {
      return false;
    }
  });

  const discoveredOrigins = new Set();
  const originsWithHits = new Set();
  let totalUnregistered = 0;

  // 1. Unregister SWs on matched tabs via ISOLATED world
  for (const tab of matchedTabs) {
    try {
      const frameResults = await unregisterSWsOnTab(tab.id);
      for (const fr of frameResults) {
        const r = fr.result;
        if (!r) continue;
        discoveredOrigins.add(r.origin);
        totalUnregistered += r.count;
        if (r.count > 0) originsWithHits.add(r.origin);
        console.log(`[SWCB] Tab ${tab.id} frame ${r.origin}: ${r.count} SW(s)`, r.scopes, r.error || '');
      }
    } catch (err) {
      console.warn(`[SWCB] Failed on tab ${tab.id}:`, err);
    }
  }

  // 2. For non-wildcard domains with no matched tab OR where matched tab found 0 SWs,
  //    open temp tab at domain root as fallback
  const matchedHostnames = new Set(
    matchedTabs.map((t) => { try { return new URL(t.url).hostname; } catch { return null; } })
  );
  const unmatchedExact = domains.filter((d) => {
    if (d.startsWith('*.')) return false;
    const hasMatchedTab = [...matchedHostnames].some((h) => h && hostnameMatchesEntry(h, d));
    if (!hasMatchedTab) return true;
    // Also retry with temp tab if matched tab found 0 SWs for this origin
    return !originsWithHits.has(`https://${d}`);
  });

  for (const domain of unmatchedExact) {
    let tempTab;
    try {
      tempTab = await chrome.tabs.create({ url: `https://${domain}`, active: false });
      await waitForTabLoad(tempTab.id);
      const frameResults = await unregisterSWsOnTab(tempTab.id);
      for (const fr of frameResults) {
        const r = fr.result;
        if (!r) continue;
        discoveredOrigins.add(r.origin);
        totalUnregistered += r.count;
        console.log(`[SWCB] Temp ${domain} frame ${r.origin}: ${r.count} SW(s)`, r.scopes, r.error || '');
      }
    } catch (err) {
      console.warn(`[SWCB] Temp tab failed for ${domain}:`, err);
    } finally {
      if (tempTab?.id) chrome.tabs.remove(tempTab.id).catch(() => {});
    }
  }

  // 3. Add explicit origins for browsingData
  for (const d of domains) {
    if (!d.startsWith('*.')) {
      discoveredOrigins.add(`https://${d}`);
    }
  }

  console.log(`[SWCB] Total unregistered: ${totalUnregistered}`);
  console.log('[SWCB] browsingData.remove origins:', [...discoveredOrigins]);

  // 4a. browsingData.remove for cache storage (supports origins filter)
  if (discoveredOrigins.size > 0) {
    const origins = [...discoveredOrigins];
    console.log('[SWCB] Clearing cacheStorage for origins:', origins);
    await new Promise((resolve) => {
      chrome.browsingData.remove({ origins }, { cacheStorage: true }, resolve);
    });
  }

  // 4b. browsingData.remove for service workers (origins filter NOT supported per Chrome docs,
  //     so we must remove globally — other sites re-register on next visit)
  console.log('[SWCB] Clearing serviceWorkers globally');
  await new Promise((resolve) => {
    chrome.browsingData.remove({}, { serviceWorkers: true }, resolve);
  });
  console.log('[SWCB] browsingData.remove completed');

  // 5. Reload matched tabs so inject.js blocks re-registration
  for (const tab of matchedTabs) {
    try {
      await chrome.tabs.reload(tab.id);
    } catch (_) {}
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Message handlers from popup ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'cleanup') {
    cleanupDomains(msg.domains).then(
      () => sendResponse({ success: true }),
      (err) => {
        console.error('[SWCB] Cleanup error:', err);
        sendResponse({ success: false, error: String(err) });
      }
    );
    return true;
  }

  if (msg.type === 'get-current-domain') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      try {
        sendResponse({ hostname: tabs[0]?.url ? new URL(tabs[0].url).hostname : null });
      } catch {
        sendResponse({ hostname: null });
      }
    });
    return true;
  }
});
