// MANDATORY: Feature-detect native Popover support before loading polyfill
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
}

/* ============================================================================
 * 1. Intrinsic Overflow Responsive Navbar (Popover when narrow, inline when wide)
 * ============================================================================ */
function initResponsiveNavbar() {
  const header = document.querySelector('.site-header');
  const inner = header?.querySelector('.header-inner');
  const menu = document.getElementById('site-menu');
  if (!header || !inner || !menu) return;

  let lastCollapsedWidth = 0;

  function syncNavbarLayout() {
    const wasPopoverOpen = menu.matches(':popover-open, .\\:popover-open');

    header.classList.add('is-measuring', 'is-wide');
    menu.removeAttribute('popover');

    const fitsInline = inner.scrollWidth <= inner.clientWidth;

    if (fitsInline) {
      lastCollapsedWidth = 0;
    } else {
      header.classList.remove('is-wide');
      menu.setAttribute('popover', 'auto');
      lastCollapsedWidth = inner.clientWidth;
      if (wasPopoverOpen && typeof menu.showPopover === 'function') {
        try {
          menu.showPopover();
        } catch {}
      }
    }

    requestAnimationFrame(() => {
      header.classList.remove('is-measuring');
    });
  }

  syncNavbarLayout();

  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => {
      const isCurrentlyWide = header.classList.contains('is-wide');
      if (isCurrentlyWide || inner.clientWidth > lastCollapsedWidth) {
        syncNavbarLayout();
      }
    });
    ro.observe(header);
    ro.observe(menu);
  }
}

/* ============================================================================
 * 2. Two-State Color Scheme Override (syncs <meta name="color-scheme"> + storage)
 * ============================================================================ */
function initThemeToggle() {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const toggleBtn = document.querySelector('.theme-toggle');
  if (!meta || !toggleBtn) return;

  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  function getStoredScheme() {
    try {
      const v = localStorage.getItem('color-scheme');
      return v === 'light' || v === 'dark' ? v : null;
    } catch {
      return null;
    }
  }

  function applyScheme(stored) {
    meta.content = stored ?? 'light dark';
  }

  toggleBtn.addEventListener('click', () => {
    const stored = getStoredScheme();
    const systemScheme = darkMedia.matches ? 'dark' : 'light';
    const currentRendered = stored ?? systemScheme;
    const targetScheme = currentRendered === 'dark' ? 'light' : 'dark';

    if (targetScheme === systemScheme) {
      try {
        localStorage.removeItem('color-scheme');
      } catch {}
      applyScheme(null);
    } else {
      try {
        localStorage.setItem('color-scheme', targetScheme);
      } catch {}
      applyScheme(targetScheme);
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === 'color-scheme') {
      const next = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null;
      applyScheme(next);
    }
  });
}

/* ============================================================================
 * 3. Declarative Copy Buttons (Invoker Commands + Async Clipboard + a11y live tip)
 * ============================================================================ */
const copyTimers = new WeakMap();
let lastAnnouncement = '';

function legacyCopy(text) {
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
}

function reportCopyStatus(button, ok) {
  const tip = button.nextElementSibling;
  clearTimeout(copyTimers.get(button));
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');

  let message = ok ? 'Copied' : 'Copy failed';
  if (message === lastAnnouncement) {
    message += '\u00A0';
  }
  lastAnnouncement = message;

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
    }, 2000)
  );
}

async function copyTargetContent(button, target) {
  if (!button || !target) return;
  const text = target.matches('input, textarea') ? target.value : target.innerText.trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    reportCopyStatus(button, true);
  } catch {
    if (legacyCopy(text)) {
      reportCopyStatus(button, true);
    } else {
      reportCopyStatus(button, false);
    }
  }
}

function initCopyButtons() {
  if ('CommandEvent' in window) {
    document.addEventListener(
      'command',
      (event) => {
        if (typeof event.command === 'string' && event.command.startsWith('--copy')) {
          copyTargetContent(event.source, event.target);
        }
      },
      true
    );
  } else {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[command^="--copy"]');
      if (!button) return;
      const targetId = button.getAttribute('commandfor');
      const target = targetId ? document.getElementById(targetId) : null;
      if (target) copyTargetContent(button, target);
    });
  }
}

/* ============================================================================
 * 4. Accessible Manifest Preset Tabs (roving tabindex + Left/Right/Home/End)
 * ============================================================================ */
function initManifestTabs() {
  const tablists = document.querySelectorAll('[role="tablist"]');
  for (const tablist of tablists) {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    if (tabs.length === 0) continue;

    function activateTab(nextTab, moveFocus = false) {
      for (const tab of tabs) {
        const selected = tab === nextTab;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        const panelId = tab.getAttribute('aria-controls');
        const panel = panelId ? document.getElementById(panelId) : null;
        if (panel) panel.hidden = !selected;
      }
      if (moveFocus) nextTab.focus();
    }

    for (const tab of tabs) {
      tab.addEventListener('click', () => activateTab(tab, false));
      tab.addEventListener('keydown', (e) => {
        const idx = tabs.indexOf(tab);
        let nextIdx = -1;
        if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = tabs.length - 1;
        if (nextIdx !== -1) {
          e.preventDefault();
          activateTab(tabs[nextIdx], true);
        }
      });
    }
  }
}

initResponsiveNavbar();
initThemeToggle();
initCopyButtons();
initManifestTabs();
