/**
 * FlareLens Website Interactive Enhancements (flarelens.dev)
 * - Conditional Popover & Invoker Commands polyfills
 * - Light-dismiss fallback for <dialog closedby="any"> + Cmd/Ctrl+K quick search
 * - ResizeObserver single-tree popover/inline navbar
 * - Two-state OS-aware theme toggle + cross-tab storage sync
 * - Invoker Command `--copy` buttons with live-region VoiceOver repeat guard
 */

// 1. Conditionally load Popover & Invoker Commands polyfills ONLY when missing
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@0.5.3/dist/popover.min.js').catch(() => {});
}
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('https://esm.run/invokers-polyfill').catch(() => {});
}

// 2. Light-dismiss fallback for <dialog closedby="any"> (`light-dismiss-a-dialog` guide)
if (!('closedBy' in HTMLDialogElement.prototype)) {
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      dialog.close();
    });
  }
}

// 3. Cmd+K / Ctrl+K Quick Documentation Search Modal
const searchDialog = document.getElementById('search-dialog');
const searchInput = document.getElementById('search-modal-input');
const searchResultsList = document.getElementById('search-results-list');

const SEARCH_INDEX = [
  { title: 'Documentation Hub', desc: 'Overview of the self-hosted PaaS layers and 6 core platform pillars', url: '/docs/' },
  { title: 'Getting Started', desc: 'Deploy the Cloudflare control plane ($0 free tier), enroll servers, and ship your first app', url: '/docs/getting-started/' },
  { title: 'Platform Architecture', desc: 'How the Serverless Control Plane, flarelensd host daemon, and WireGuard P2P mesh work together', url: '/docs/architecture/' },
  { title: 'Fleet Management — Servers & Workloads', desc: 'Spread/binpack/pinned placement, hard kernel cgroups, zero-restart DB caps, drain & image prune', url: '/docs/fleet/' },
  { title: 'Deployments — Revisions & Rollbacks', desc: 'Zero-Git dashboard CRUD, immutable rev-N snapshots, <1ms Blue/Green swaps & uat → prod promotion', url: '/docs/deployments/' },
  { title: 'Private Mesh — WireGuard Networking', desc: 'Direct P2P ChaCha20-Poly1305 overlay (100.64.0.0/10), 5s MagicDNS (*.mesh) & operator workstation access', url: '/docs/mesh/' },
  { title: 'Observability — Logs, Metrics & Health', desc: '15s container/host telemetry, SSE live tailing & R2 Apache Parquet + in-browser DuckDB-WASM SQL', url: '/docs/observability/' },
  { title: 'Secrets & Flags — Runtime Configuration', desc: 'AES-256-GCM Vault, zero .env files on disk, 0700 /dev/shm secret files & sub-ms feature flags', url: '/docs/secrets-and-flags/' },
  { title: 'Backups — R2 Streaming Storage', desc: 'Zero-disk io.Pipe pg_dump | gzip to R2, cron schedules, pre-migration guardrails & auto-restore', url: '/docs/backups/' },
  { title: 'CLI, Schema & HTTP API Reference', desc: 'flarelensd CLI commands, fleet.schema.json fields, GitHub OIDC sync & REST endpoints', url: '/docs/reference/' },
  { title: 'How FlareLens Compares', desc: 'Honest comparison vs Fly.io/Render, Coolify, Kamal 2, Kubernetes, and SaaS stacks', url: '/compare/' },
  { title: 'Fleet Manifest JSON Schema', desc: 'Canonical IDE validation schema at /schemas/fleet.schema.json', url: '/schemas/fleet.schema.json' },
  { title: 'Full LLM Agent Context (/llms-full.txt)', desc: 'Single-file Markdown & JSON Schema bundle for AI coding agents', url: '/llms-full.txt' },
];

function renderSearchResults(query = '') {
  if (!searchResultsList) return;
  const q = query.trim().toLowerCase();
  const matches = q
    ? SEARCH_INDEX.filter((item) => (item.title + ' ' + item.desc).toLowerCase().includes(q))
    : SEARCH_INDEX.slice(0, 9);

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
const themeToggleButtons = document.querySelectorAll('.theme-toggle, #theme-toggle');

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

if (themeToggleButtons.length > 0 && schemeMeta) {
  for (const btn of themeToggleButtons) {
    btn.addEventListener('click', () => {
      const stored = getStoredScheme();
      const system = getSystemScheme();
      const rendered = stored ?? system;
      const target = rendered === 'dark' ? 'light' : 'dark';

      if (target === system) {
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
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== 'color-scheme') return;
    schemeMeta.content = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'light dark';
  });
}

// 6. Accessible ARIA Tablist Switchers
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

// 7. Invoker Command `--copy` Buttons (`copy-button` & `custom-button-actions` guides)
const copyTimers = new WeakMap();
let lastCopyMessage = '';

function reportCopy(button, ok) {
  const tip = button.nextElementSibling;
  clearTimeout(copyTimers.get(button));
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');

  let message = ok ? 'Copied' : 'Copy failed';
  if (message === lastCopyMessage) message += '\u00A0';
  lastCopyMessage = message;

  if (tip) tip.textContent = '';
  void button.offsetWidth;
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  if (tip) {
    requestAnimationFrame(() => {
      tip.textContent = message;
    });
  }

  copyTimers.set(
    button,
    setTimeout(() => {
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      if (tip) tip.textContent = '';
    }, 2000),
  );
}

async function copyFromCommand(button, target) {
  if (!(button instanceof HTMLElement) || !(target instanceof HTMLElement)) return;
  const text = target.matches('input, textarea') ? target.value : target.innerText.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    reportCopy(button, true);
  } catch {
    reportCopy(button, false);
  }
}

// `command` events do not bubble: listen in the capture phase on document
document.addEventListener(
  'command',
  (event) => {
    if (typeof event.command === 'string' && event.command.startsWith('--copy')) {
      copyFromCommand(event.source, event.target);
    }
  },
  true,
);

// Fallback for browsers without CommandEvent (guarded at click time so polyfill never double-fires)
if (!('CommandEvent' in window)) {
  document.addEventListener('click', (event) => {
    if ('CommandEvent' in window) return;
    const button = event.target instanceof Element ? event.target.closest('button[command^="--copy"]') : null;
    if (!button) return;
    const targetId = button.getAttribute('commandfor');
    const target = targetId ? document.getElementById(targetId) : null;
    if (target) copyFromCommand(button, target);
  });
}
