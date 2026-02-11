# SW & Cache Blocker

A Chrome extension that blocks Service Worker registration and Cache Storage access on domains you choose.

Some websites aggressively use Service Workers and Cache Storage in ways that cause stale content, excessive disk usage, or interfere with development. This extension lets you maintain a blocklist of domains where these APIs are completely disabled.

## How It Works

1. **Add domains** to the blocklist via the popup (e.g. `example.com`, `*.example.org`)
2. A content script is injected into matching pages at `document_start` in the `MAIN` world, before any page JS runs
3. The injected script monkey-patches `navigator.serviceWorker.register()` and all `caches.*` methods to block them
4. The **Clean** button unregisters existing Service Workers and clears Cache Storage for a domain

## Features

- **Domain blocklist** synced across Chrome profiles via `chrome.storage.sync`
- **Wildcard support**: `*.example.com` matches all subdomains
- **One-click add** for the current tab's domain
- **Per-domain cleanup**: unregister SWs + clear caches for individual domains
- **Clean All**: bulk cleanup across every blocked domain
- **Badge counter** showing how many domains are blocked

## Install from Source

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select this directory

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist the blocklist across sessions |
| `scripting` | Dynamically register content scripts for blocked domains |
| `browsingData` | Clear Cache Storage and Service Worker registrations |
| `tabs` / `activeTab` | Detect the current tab's domain and reload tabs after cleanup |
| `<all_urls>` | Inject the blocking script on any blocked domain |

## Files

```
manifest.json   Extension manifest (MV3)
background.js   Service worker: script registration, cleanup logic, message handling
inject.js       Content script (MAIN world): patches SW and Cache APIs
popup.html      Popup UI markup
popup.js        Popup logic: blocklist management, cleanup triggers
popup.css       Popup styles (dark theme)
```

## License

MIT
