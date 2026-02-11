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
  const presetListEl = $('#preset-list');
  const newPresetBtn = $('#new-preset-btn');
  const modalOverlay = $('#modal-overlay');
  const presetNameInput = $('#preset-name-input');
  const presetDomainsInput = $('#preset-domains-input');
  const modalCancelBtn = $('#modal-cancel-btn');
  const modalCreateBtn = $('#modal-create-btn');

  // --- Built-in presets ---

  const BUILTIN_PRESETS = {
    feishu: {
      name: 'Feishu / Lark',
      domains: [
        '*.feishu.cn',
        '*.feishu-boe.cn',
        '*.feishu-boe.net',
        '*.larksuite.com',
        '*.larksuite-boe.com',
        '*.larkoffice.com',
      ],
    },
  };

  // --- State ---

  let blocklist = [];
  let enabledPresets = [];
  let customPresets = {};
  let currentHostname = null;

  // --- Storage helpers ---

  async function loadState() {
    const data = await chrome.storage.sync.get(['blocklist', 'enabledPresets', 'customPresets']);
    blocklist = data.blocklist || [];
    enabledPresets = data.enabledPresets || [];
    customPresets = data.customPresets || {};
  }

  async function saveState() {
    await chrome.storage.sync.set({ blocklist, enabledPresets, customPresets });
  }

  // --- Preset helpers ---

  function getAllPresets() {
    const presets = [];
    for (const [id, preset] of Object.entries(BUILTIN_PRESETS)) {
      presets.push({ id, ...preset, builtin: true });
    }
    for (const [id, preset] of Object.entries(customPresets)) {
      presets.push({ id: 'custom:' + id, ...preset, builtin: false });
    }
    return presets;
  }

  function getPresetDomains(presetId) {
    if (BUILTIN_PRESETS[presetId]) {
      return BUILTIN_PRESETS[presetId].domains;
    }
    const customId = presetId.replace(/^custom:/, '');
    if (customPresets[customId]) {
      return customPresets[customId].domains;
    }
    return [];
  }

  function getEnabledPresetDomains(excludeId) {
    const domains = new Set();
    for (const pid of enabledPresets) {
      if (pid === excludeId) continue;
      for (const d of getPresetDomains(pid)) {
        domains.add(d);
      }
    }
    return domains;
  }

  async function togglePreset(presetId) {
    const isEnabled = enabledPresets.includes(presetId);
    const presetDomains = getPresetDomains(presetId);

    if (isEnabled) {
      // Disable: remove domains exclusive to this preset
      enabledPresets = enabledPresets.filter((id) => id !== presetId);
      const otherDomains = getEnabledPresetDomains();
      blocklist = blocklist.filter((d) => !presetDomains.includes(d) || otherDomains.has(d));
    } else {
      // Enable: add missing domains
      enabledPresets.push(presetId);
      for (const d of presetDomains) {
        if (!blocklist.includes(d)) {
          blocklist.push(d);
        }
      }
      blocklist.sort();
    }

    await saveState();
    render();
    toast(isEnabled ? 'Preset disabled' : 'Preset enabled');
  }

  async function createCustomPreset(name, domains) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    customPresets[id] = { name, domains };
    await saveState();
    render();
    toast(`Created "${name}"`);
  }

  async function deleteCustomPreset(customId) {
    const presetId = 'custom:' + customId;
    const isEnabled = enabledPresets.includes(presetId);

    if (isEnabled) {
      // Disable first: remove exclusive domains
      enabledPresets = enabledPresets.filter((id) => id !== presetId);
      const presetDomains = customPresets[customId]?.domains || [];
      const otherDomains = getEnabledPresetDomains();
      blocklist = blocklist.filter((d) => !presetDomains.includes(d) || otherDomains.has(d));
    }

    delete customPresets[customId];
    await saveState();
    render();
    toast('Preset deleted');
  }

  function autoDisablePresetsForDomain(domain) {
    const toDisable = [];
    for (const pid of enabledPresets) {
      const domains = getPresetDomains(pid);
      if (domains.includes(domain)) {
        toDisable.push(pid);
      }
    }
    if (toDisable.length > 0) {
      enabledPresets = enabledPresets.filter((id) => !toDisable.includes(id));
    }
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
    return blocklist.some((entry) => hostnameMatchesEntry(hostname, entry));
  }

  // --- Rendering ---

  function render() {
    countLabel.textContent = `Blocklist (${blocklist.length})`;

    if (blocklist.length === 0) {
      domainList.innerHTML = '<div class="empty">No domains blocked</div>';
    } else {
      domainList.innerHTML = blocklist
        .map(
          (d) => `
        <div class="domain-item" data-domain="${d}">
          <span class="name" title="${d}">${d.startsWith('*.') ? '<span class="wildcard">*.</span>' + d.slice(2) : d}</span>
          <span class="actions">
            <button class="btn btn-sm btn-ghost clean-btn" title="Clean cache &amp; SW">Clean</button>
            <button class="btn btn-sm btn-ghost remove-btn" title="Remove from blocklist">&times;</button>
          </span>
        </div>`
        )
        .join('');
    }

    renderPresets();
    renderCurrentSite();
  }

  function renderPresets() {
    const presets = getAllPresets();
    presetListEl.innerHTML = presets
      .map((p) => {
        const enabled = enabledPresets.includes(p.id);
        const deleteBtn = p.builtin
          ? ''
          : `<button class="preset-delete-btn" data-preset-delete="${p.id.replace('custom:', '')}" title="Delete preset">&times;</button>`;
        const tooltip = p.domains.join('\n');
        return `
        <div class="preset-item" title="${tooltip}">
          <label class="toggle">
            <input type="checkbox" data-preset-toggle="${p.id}" ${enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
          <div class="preset-info">
            <div class="preset-name">${p.name}</div>
            <div class="preset-count">${p.domains.length} domain${p.domains.length !== 1 ? 's' : ''}</div>
          </div>
          ${deleteBtn}
        </div>`;
      })
      .join('');
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
    if (blocklist.includes(d)) {
      toast('Already blocked');
      return;
    }
    blocklist.push(d);
    blocklist.sort();
    await saveState();
    render();
    toast(`Added ${d}`);
  }

  async function removeDomain(d) {
    blocklist = blocklist.filter((x) => x !== d);
    autoDisablePresetsForDomain(d);
    await saveState();
    render();
    toast(`Removed ${d}`);
  }

  async function cleanDomains(domains) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'cleanup', domains }, () => resolve());
    });
  }

  // --- Modal ---

  function openModal() {
    presetNameInput.value = '';
    presetDomainsInput.value = '';
    modalOverlay.classList.add('show');
    presetNameInput.focus();
  }

  function closeModal() {
    modalOverlay.classList.remove('show');
  }

  function handleCreatePreset() {
    const name = presetNameInput.value.trim();
    if (!name) {
      toast('Name is required');
      return;
    }

    const lines = presetDomainsInput.value.split('\n').map((l) => normalizeDomain(l)).filter(Boolean);
    const validDomains = [];
    for (const d of lines) {
      if (!isValidDomain(d)) {
        toast(`Invalid domain: ${d}`);
        return;
      }
      if (!validDomains.includes(d)) {
        validDomains.push(d);
      }
    }

    if (validDomains.length === 0) {
      toast('Add at least one domain');
      return;
    }

    closeModal();
    createCustomPreset(name, validDomains);
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
    if (blocklist.length === 0) return;
    cleanDomains(blocklist).then(() => toast('Cleaned all domains'));
  });

  toggleCurrentBtn.addEventListener('click', () => {
    if (!currentHostname) return;
    const d = normalizeDomain(currentHostname);
    if (isDomainBlocked(currentHostname)) {
      const match = blocklist.find((entry) => hostnameMatchesEntry(currentHostname, entry));
      if (match) removeDomain(match);
    } else {
      addDomain(d);
    }
  });

  // Preset toggle and delete (event delegation)
  presetListEl.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-preset-toggle]');
    if (toggle) {
      togglePreset(toggle.dataset.presetToggle);
      return;
    }

    const deleteBtn = e.target.closest('[data-preset-delete]');
    if (deleteBtn) {
      deleteCustomPreset(deleteBtn.dataset.presetDelete);
    }
  });

  newPresetBtn.addEventListener('click', openModal);
  modalCancelBtn.addEventListener('click', closeModal);
  modalCreateBtn.addEventListener('click', handleCreatePreset);

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  presetDomainsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.metaKey) {
      handleCreatePreset();
    }
  });

  // --- Init ---

  async function init() {
    await loadState();

    chrome.runtime.sendMessage({ type: 'get-current-domain' }, (res) => {
      currentHostname = res?.hostname || null;
      render();
    });

    render();
    domainInput.focus();
  }

  init();
})();
