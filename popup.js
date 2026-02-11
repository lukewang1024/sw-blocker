(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const domainInput = $('#domain-input');
  const addBtn = $('#add-btn');
  const domainList = $('#domain-list');
  const countLabel = $('#count-label');
  const cleanAllBtn = $('#clean-all-btn');
  const currentDomainEl = $('#current-domain');
  const toggleCurrentBtn = $('#toggle-current');
  const toastEl = $('#toast');

  let blacklist = [];
  let currentHostname = null;

  // --- Storage helpers ---

  async function loadBlacklist() {
    const { blacklist: list = [] } = await chrome.storage.sync.get('blacklist');
    blacklist = list;
  }

  async function saveBlacklist() {
    await chrome.storage.sync.set({ blacklist });
  }

  // --- Domain helpers ---

  function normalizeDomain(input) {
    let d = input.trim().toLowerCase();
    // Strip protocol
    d = d.replace(/^https?:\/\//, '');
    // Strip path and trailing slash
    d = d.replace(/\/.*$/, '');
    // Strip port
    d = d.replace(/:\d+$/, '');
    // Strip leading www. (but not for wildcards)
    if (!d.startsWith('*.')) {
      d = d.replace(/^www\./, '');
    }
    return d;
  }

  function isValidDomain(d) {
    // *.feishu.cn
    if (d.startsWith('*.')) {
      return /^\*\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
    }
    // feishu.cn
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
  }

  function hostnameMatchesEntry(hostname, entry) {
    const h = hostname.replace(/^www\./, '');
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    return h === entry || h.endsWith('.' + entry);
  }

  function isDomainBlocked(hostname) {
    if (!hostname) return false;
    return blacklist.some((entry) => hostnameMatchesEntry(hostname, entry));
  }

  // --- Rendering ---

  function render() {
    countLabel.textContent = `Blacklist (${blacklist.length})`;

    if (blacklist.length === 0) {
      domainList.innerHTML = '<div class="empty">No domains blacklisted</div>';
    } else {
      domainList.innerHTML = blacklist
        .map(
          (d) => `
        <div class="domain-item" data-domain="${d}">
          <span class="name" title="${d}">${d.startsWith('*.') ? '<span class="wildcard">*.</span>' + d.slice(2) : d}</span>
          <span class="actions">
            <button class="btn btn-sm btn-ghost clean-btn" title="Clean cache &amp; SW">Clean</button>
            <button class="btn btn-sm btn-ghost remove-btn" title="Remove from blacklist">&times;</button>
          </span>
        </div>`
        )
        .join('');
    }

    renderCurrentSite();
  }

  function renderCurrentSite() {
    if (!currentHostname) {
      currentDomainEl.textContent = 'N/A';
      toggleCurrentBtn.style.display = 'none';
      return;
    }

    currentDomainEl.textContent = currentHostname;
    const blocked = isDomainBlocked(currentHostname);
    currentDomainEl.classList.toggle('blocked', blocked);
    toggleCurrentBtn.textContent = blocked ? 'Remove' : 'Add';
    toggleCurrentBtn.className = blocked ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-primary';
    toggleCurrentBtn.style.display = '';
  }

  // --- Toast ---

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
  }

  // --- Actions ---

  async function addDomain(raw) {
    const d = normalizeDomain(raw);
    if (!d) return;
    if (!isValidDomain(d)) {
      toast('Invalid domain');
      return;
    }
    if (blacklist.includes(d)) {
      toast('Already in blacklist');
      return;
    }
    blacklist.push(d);
    blacklist.sort();
    await saveBlacklist();
    render();
    toast(`Added ${d}`);
  }

  async function removeDomain(d) {
    blacklist = blacklist.filter((x) => x !== d);
    await saveBlacklist();
    render();
    toast(`Removed ${d}`);
  }

  async function cleanDomains(domains) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'cleanup', domains }, () => resolve());
    });
  }

  // --- Event listeners ---

  addBtn.addEventListener('click', () => {
    addDomain(domainInput.value);
    domainInput.value = '';
    domainInput.focus();
  });

  domainInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addDomain(domainInput.value);
      domainInput.value = '';
    }
  });

  domainList.addEventListener('click', (e) => {
    const item = e.target.closest('.domain-item');
    if (!item) return;
    const domain = item.dataset.domain;

    if (e.target.closest('.remove-btn')) {
      removeDomain(domain);
    } else if (e.target.closest('.clean-btn')) {
      cleanDomains([domain]).then(() => toast(`Cleaned ${domain}`));
    }
  });

  cleanAllBtn.addEventListener('click', () => {
    if (blacklist.length === 0) return;
    cleanDomains(blacklist).then(() => toast('Cleaned all domains'));
  });

  toggleCurrentBtn.addEventListener('click', () => {
    if (!currentHostname) return;
    const d = normalizeDomain(currentHostname);
    if (isDomainBlocked(currentHostname)) {
      const match = blacklist.find((entry) => hostnameMatchesEntry(currentHostname, entry));
      if (match) removeDomain(match);
    } else {
      addDomain(d);
    }
  });

  // --- Init ---

  async function init() {
    await loadBlacklist();

    chrome.runtime.sendMessage({ type: 'get-current-domain' }, (res) => {
      currentHostname = res?.hostname || null;
      render();
    });

    render();
    domainInput.focus();
  }

  init();
})();
