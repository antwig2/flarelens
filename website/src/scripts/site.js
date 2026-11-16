/**
 * FlareLens Website Interactive Enhancements (flarelens.dev)
 * - Conditional Invoker Commands + Popover API polyfills
 * - Light-dismiss fallback for <dialog closedby="any"> + Cmd/Ctrl+K quick search
 * - ResizeObserver single-tree popover/inline navbar
 * - Two-state OS-aware theme toggle + cross-tab storage sync
 * - Accessible ARIA tablists & live cluster slot pulse
 */

// 1. Conditionally load Popover & Invoker Commands polyfills ONLY when missing
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@0.5.3/dist/popover.min.js').catch(() => {});
}
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('https://esm.run/invokers-polyfill').catch(() => {});
}

// 2. Light-dismiss fallback for <dialog closedby="any"> (`dialog` & `light-dismiss-a-dialog` guides)
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const isOutside = (e, dlg) => {
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dlg of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dlg.addEventListener('pointerdown', (e) => {
      pressedOutside = e.target === dlg && isOutside(e, dlg);
    });
    dlg.addEventListener('pointerup', (e) => {
      if (pressedOutside && e.target === dlg && isOutside(e, dlg)) {
        dlg.close();
      }
      pressedOutside = false;
    });
  }
}

// 3. Cmd+K / Ctrl+K Quick Documentation Search Modal
const searchDialog = document.getElementById('search-dialog');
const searchInput = document.getElementById('search-modal-input');
const searchResultsList = document.getElementById('search-results-list');

const SEARCH_INDEX = [
  { title: 'Getting started ($0 Cloudflare Free Tier)', desc: '1-click Worker deploy, D1 migrations, and edge secrets', url: '/docs/#quick-start' },
  { title: 'Enroll Linux, macOS & Windows servers', desc: 'curl -fsSL https://flarelens.dev/install.sh and systemd setup', url: '/docs/#enroll-nodes' },
  { title: 'Zero-Git Declarative Fleet & Revisions', desc: 'Create services, promote uat → prod, and roll back rev-N in D1 + R2', url: '/docs/#declarative-fleet' },
  { title: 'WireGuard P2P Mesh & MagicDNS (TTL 5s)', desc: 'Direct ChaCha20-Poly1305 overlay and embedded <overlay_ip>:53 DNS', url: '/docs/#placement-mesh' },
  { title: 'Multi-Server Placement & Stateful Volume Fencing', desc: 'Spread, binpack, pinned scheduling and safe node drain', url: '/docs/#placement-mesh' },
  { title: 'Hard Docker Cgroup Limits & Auto Image Prune', desc: 'HostConfig.Memory, NanoCPUs, zero-restart DB updates, and 72h GC', url: '/docs/#cgroups-prune' },
  { title: 'Zero-Plaintext Vault & RAM Secret Files', desc: 'AES-256-GCM secrets and /dev/shm tmpfs __FLARELENS_FILE__ mounts', url: '/docs/#vault-ram-secrets' },
  { title: 'R2 Parquet Log Lakehouse & Streaming Backups', desc: 'In-browser DuckDB-WASM SQL ($0 egress) and io.Pipe pg_dump', url: '/docs/#backups-lakehouse' },
  { title: 'How FlareLens Compares', desc: 'Side-by-side comparison vs Coolify, Kamal 2, Kubernetes, and SaaS stacks', url: '/compare/' },
  { title: 'Fleet Manifest JSON Schema', desc: 'Canonical IDE validation schema at /schemas/fleet.schema.json', url: '/schemas/fleet.schema.json' },
  { title: 'Full LLM Agent Documentation (/llms-full.txt)', desc: 'Single-file Markdown & JSON Schema bundle for AI coding agents', url: '/llms-full.txt' },
];

function renderSearchResults(query = '') {
  if (!searchResultsList) return;
  const q = query.trim().toLowerCase();
  const matches = q
    ? SEARCH_INDEX.filter((item) => (item.title + ' ' + item.desc).toLowerCase().includes(q))
    : SEARCH_INDEX.slice(0, 7);

  searchResultsList.replaceChildren();
  for (const item of matches) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = item.url;
    const strong = document.createElement('strong');
    strong.textContent = item.title;
    const small = document.createElement('small');
    small.textContent = item.desc;
    a.append(strong, small);
    a.addEventListener('click', () => {
      if (searchDialog instanceof HTMLDialogElement && searchDialog.open) {
        searchDialog.close();
      }
    });
    li.append(a);
    searchResultsList.append(li);
  }
}

if (searchDialog instanceof HTMLDialogElement) {
  renderSearchResults('');
  searchInput?.addEventListener('input', () => renderSearchResults(searchInput.value));
  searchDialog.addEventListener('close', () => {
    searchDialog.returnValue = '';
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (searchDialog.open) {
        searchDialog.close();
      } else {
        renderSearchResults(searchInput?.value || '');
        searchDialog.showModal();
        searchInput?.focus();
      }
    }
  });
}

// 4. Responsive Single-Tree Popover / Inline Navbar (`navbar` guide)
const header = document.querySelector('.site-header');
const headerInner = header?.querySelector('.header-inner');
const siteMenu = document.getElementById('site-menu');

if (header && headerInner && siteMenu) {
  let lastCollapsedWidth = 0;

  const syncNavbarLayout = (forceMeasure = false) => {
    const currentlyWide = header.classList.contains('is-wide');
    const currentWidth = headerInner.clientWidth;

    if (!forceMeasure && !currentlyWide && currentWidth <= lastCollapsedWidth) {
      return;
    }

    const wasPopoverOpen = siteMenu.matches(':popover-open, .\\:popover-open');
    header.classList.add('is-measuring', 'is-wide');
    siteMenu.removeAttribute('popover');

    const fitsInline = headerInner.scrollWidth <= headerInner.clientWidth;

    if (!fitsInline) {
      header.classList.remove('is-wide');
      siteMenu.setAttribute('popover', 'auto');
      lastCollapsedWidth = currentWidth;
      if (wasPopoverOpen && typeof siteMenu.showPopover === 'function') {
        try {
          siteMenu.showPopover();
        } catch {}
      }
    } else {
      lastCollapsedWidth = 0;
    }

    requestAnimationFrame(() => {
      header.classList.remove('is-measuring');
    });
  };

  syncNavbarLayout(true);

  const ro = new ResizeObserver(() => syncNavbarLayout(false));
  ro.observe(header);
  ro.observe(siteMenu);
}

// 5. Two-State OS-Aware Color Scheme Toggle (`dark-mode-toggle` guide)
const schemeMeta = document.querySelector('meta[name="color-scheme"]');
const themeToggleBtn = document.getElementById('theme-toggle');

function getStoredScheme() {
  try {
    const val = localStorage.getItem('color-scheme');
    return val === 'light' || val === 'dark' ? val : null;
  } catch {
    return null;
  }
}

function getSystemScheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

if (themeToggleBtn && schemeMeta) {
  themeToggleBtn.addEventListener('click', () => {
    const stored = getStoredScheme();
    const system = getSystemScheme();
    const isHomeDefaultDark = document.body.classList.contains('home-dark-surface') && !stored;
    const rendered = isHomeDefaultDark ? 'dark' : (stored ?? system);
    const target = rendered === 'dark' ? 'light' : 'dark';

    if (!document.body.classList.contains('home-dark-surface') && target === system) {
      try {
        localStorage.removeItem('color-scheme');
      } catch {}
      schemeMeta.content = 'light dark';
    } else {
      try {
        localStorage.setItem('color-scheme', target);
      } catch {}
      schemeMeta.content = target;
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== 'color-scheme') return;
    schemeMeta.content = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'light dark';
  });
}

// 6. Accessible ARIA Tablist Switchers (CLI Lifecycle + Interactive Demo Stage)
for (const tablist of document.querySelectorAll('[role="tablist"]')) {
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  if (tabs.length === 0) continue;

  const activateTab = (nextTab, moveFocus = false) => {
    for (const tab of tabs) {
      const selected = tab === nextTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panelId = tab.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) panel.hidden = !selected;
    }
    if (moveFocus) nextTab.focus();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => activateTab(tab, false));
    tab.addEventListener('keydown', (event) => {
      const idx = tabs.indexOf(tab);
      let nextIdx = -1;
      if (event.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIdx = 0;
      else if (event.key === 'End') nextIdx = tabs.length - 1;
      if (nextIdx !== -1) {
        event.preventDefault();
        activateTab(tabs[nextIdx], true);
      }
    });
  }
}

// 7. Copy-to-Clipboard with Centralized Polite Live Region
const announcer = document.getElementById('live-announcer');

document.addEventListener('click', async (event) => {
  const btn = event.target instanceof Element ? event.target.closest('[data-copy-text], [data-copy-target]') : null;
  if (!btn) return;

  let text = btn.getAttribute('data-copy-text') || '';
  if (!text) {
    const targetId = btn.getAttribute('data-copy-target');
    const targetEl = targetId ? document.getElementById(targetId) : null;
    text = targetEl?.textContent?.trim() || '';
  }
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const labelEl = btn.querySelector('[data-copy-label]');
    const prevLabel = labelEl ? labelEl.textContent : '';
    btn.setAttribute('data-copied', 'true');
    if (labelEl) labelEl.textContent = 'Copied';
    if (announcer) announcer.textContent = 'Copied command to clipboard.';

    setTimeout(() => {
      btn.removeAttribute('data-copied');
      if (labelEl && prevLabel) labelEl.textContent = prevLabel;
    }, 1800);
  } catch {}
});
