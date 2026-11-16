#!/usr/bin/env node
/**
 * Zero-dependency static site & documentation builder for flarelens.dev.
 *
 * 1. Copies website/src/* -> website/dist/
 * 2. Copies ../public/install.sh and ../public/install.ps1 -> website/dist/
 * 3. Extracts FLEET_JSON_SCHEMA from ../src/control/fleet.ts -> website/dist/schemas/fleet.schema.json
 * 4. Renders /docs/index.html + 9 /docs/<slug>/index.html pages from ./docs-pages.mjs
 * 5. Generates /llms.txt, /llms-full.txt, and /sitemap.xml
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_GROUPS, DOC_PAGES } from './docs-pages.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(websiteRoot, '..');
const srcDir = path.join(websiteRoot, 'src');
const distDir = path.join(websiteRoot, 'dist');

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function htmlToMarkdownInline(html) {
  return String(html)
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<\/?code>/gi, '`')
    .replace(/<\/?strong>/gi, '**')
    .replace(/<\/?em>/gi, '_')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replace(/<[^>]+>/g, '');
}

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function renderSiteShell({ title, description, canonicalPath, activeNav, bodyHtml }) {
  const fullUrl = `https://flarelens.dev${canonicalPath}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <script>
    try {
      document.querySelector('meta[name="color-scheme"]').content = localStorage.getItem('color-scheme') ?? 'light dark';
    } catch {}
  </script>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${fullUrl}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="FlareLens">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${fullUrl}">
  <meta property="og:image" content="https://flarelens.dev/og-card.svg">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="stylesheet" href="/styles/main.css">
  <script type="module" src="/scripts/site.js"></script>
</head>
<body>
  <header class="site-header">
    <a href="#docs-heading" class="skip-link visually-hidden">Skip to documentation</a>
    <div class="header-frame">
      <div class="header-inner">
        <a class="site-logo" href="/">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 3L3 7.5 12 12l9-4.5L12 3z" stroke-linejoin="round"/>
            <path d="M3 12l9 4.5 9-4.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 16.5L12 21l9-4.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>FlareLens</span>
        </a>

        <div class="header-actions">
          <nav class="site-nav" aria-label="Primary">
            <button
              class="menu-button"
              type="button"
              popovertarget="site-menu"
              popovertargetaction="toggle"
              aria-controls="site-menu"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round"/>
              </svg>
              <span>Menu</span>
            </button>

            <ul id="site-menu" class="site-menu" popover="auto">
              <li><a href="/#product">Product</a></li>
              <li><a href="/#architecture">Architecture</a></li>
              <li><a href="/docs/"${activeNav === 'docs' ? ' aria-current="page"' : ''}>Docs</a></li>
              <li><a href="/compare/"${activeNav === 'compare' ? ' aria-current="page"' : ''}>Compare</a></li>
              <li><a href="https://github.com/antwig2/flarelens" target="_blank" rel="noopener noreferrer">GitHub</a></li>
            </ul>
          </nav>

          <button
            class="search-trigger"
            type="button"
            command="show-modal"
            commandfor="search-dialog"
            aria-haspopup="dialog"
            aria-label="Search documentation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
            </svg>
            <span class="search-trigger-label">Search docs</span>
            <span class="search-kbd" aria-hidden="true">⌘K</span>
          </button>

          <button type="button" class="theme-toggle" aria-label="Switch color theme">
            <svg class="icon-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="4"/>
              <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" stroke-linecap="round"/>
            </svg>
            <svg class="icon-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </header>

  <main class="page-frame">
${bodyHtml}
  </main>

  <footer class="site-footer">
    <div class="footer-frame">
      <div class="container footer-inner">
        <div>
          <strong>FlareLens</strong> · Open-Source Self-Hosted PaaS · Apache 2.0
        </div>
        <nav class="footer-links" aria-label="Footer">
          <a href="/">Overview</a>
          <a href="/docs/">Docs</a>
          <a href="/compare/">Compare</a>
          <a href="/llms-full.txt">llms-full.txt</a>
          <a href="/schemas/fleet.schema.json">Schema</a>
          <a href="https://github.com/antwig2/flarelens" target="_blank" rel="noopener noreferrer">Control Plane</a>
          <a href="https://github.com/antwig2/flarelensd" target="_blank" rel="noopener noreferrer">Host Agent</a>
        </nav>
      </div>
    </div>
  </footer>

  <dialog id="search-dialog" closedby="any" aria-label="Search FlareLens documentation">
    <div class="search-modal-head">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
      </svg>
      <input
        id="search-modal-input"
        class="search-modal-input"
        type="search"
        placeholder="Jump to Fleet, Deployments, Mesh, Backups, Schema..."
        aria-label="Search FlareLens documentation"
        autofocus
      >
      <button class="search-close-btn" type="button" commandfor="search-dialog" command="close" aria-label="Close search dialog">Esc</button>
    </div>
    <ul id="search-results-list" class="search-results-list" role="list"></ul>
  </dialog>
</body>
</html>
`;
}

function renderBlockHtml(block, tableIdxRef) {
  if (block.type === 'p') {
    return `<p>${block.html}</p>`;
  }
  if (block.type === 'callout') {
    return `<div class="callout">${block.html}</div>`;
  }
  if (block.type === 'ul') {
    const lis = block.items.map((item) => `<li>${item}</li>`).join('\n');
    return `<ul>\n${lis}\n</ul>`;
  }
  if (block.type === 'ol') {
    const lis = block.items.map((item) => `<li>${item}</li>`).join('\n');
    return `<ol>\n${lis}\n</ol>`;
  }
  if (block.type === 'code') {
    return `<div class="code-panel copyable">
  <div class="code-header">
    <span>${escapeHtml(block.label)}</span>
    <span class="copy">
      <button type="button" class="copy-button" command="--copy" commandfor="${escapeHtml(block.id)}" aria-label="${escapeHtml(block.copyLabel)}">
        <svg class="icon-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <svg class="icon-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Copy</span>
      </button>
      <span class="tip" role="status"></span>
    </span>
  </div>
  <pre tabindex="0"><code id="${escapeHtml(block.id)}">${escapeHtml(block.code)}</code></pre>
</div>`;
  }
  if (block.type === 'table') {
    tableIdxRef.count += 1;
    const captionId = `doc-table-cap-${tableIdxRef.count}`;
    const cssLabelVars = block.headers
      .slice(1)
      .map((h, i) => `--label-${i + 2}: '${h.replaceAll("'", '')}'`)
      .join('; ');
    const ths = block.headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('');
    const rows = block.rows
      .map((row) => {
        const [first, ...rest] = row;
        const cells = rest.map((c) => `<td>${escapeHtml(c)}</td>`).join('');
        return `<tr><th scope="row"><code>${escapeHtml(first)}</code></th>${cells}</tr>`;
      })
      .join('\n');
    return `<div tabindex="0" role="region" aria-labelledby="${captionId}" class="table-wrapper">
  <table class="data-table" style="${cssLabelVars};">
    <caption id="${captionId}" class="visually-hidden">${escapeHtml(block.caption)}</caption>
    <thead><tr>${ths}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
  }
  return '';
}

function renderSidebarHtml(activeSlug) {
  const pageBySlug = new Map(DOC_PAGES.map((p) => [p.slug, p]));
  const groupsHtml = DOC_GROUPS.map((group) => {
    const links = group.slugs
      .map((slug) => {
        const p = pageBySlug.get(slug);
        const current = slug === activeSlug ? ' aria-current="page"' : '';
        return `<li><a href="/docs/${slug}/"${current}><span>${escapeHtml(p.cardTitle)}</span></a></li>`;
      })
      .join('\n');
    return `<div class="docs-sidebar-group">
  <div class="docs-sidebar-title">${escapeHtml(group.title)}</div>
  <ul class="docs-toc" role="list">
${links}
  </ul>
</div>`;
  }).join('\n');

  return `<aside class="docs-sidebar" aria-label="Documentation sections">
  <div class="docs-sidebar-group">
    <ul class="docs-toc" role="list">
      <li><a href="/docs/"${activeSlug === '' ? ' aria-current="page"' : ''}><span>All docs</span></a></li>
    </ul>
  </div>
${groupsHtml}
</aside>`;
}

function renderDocsHubHtml() {
  const pageBySlug = new Map(DOC_PAGES.map((p) => [p.slug, p]));
  const groupsHtml = DOC_GROUPS.map((group) => {
    const cards = group.slugs
      .map((slug) => {
        const p = pageBySlug.get(slug);
        return `<a class="docs-card" href="/docs/${p.slug}/">
  <span class="docs-card-kicker">${escapeHtml(p.kicker)}</span>
  <h3 class="docs-card-title">${escapeHtml(p.cardTitle)}</h3>
  <p class="docs-card-desc">${escapeHtml(p.cardDesc)}</p>
</a>`;
      })
      .join('\n');

    return `<section class="docs-hub-group" aria-labelledby="group-${group.id}">
  <div class="docs-hub-group-head">
    <h2 id="group-${group.id}" class="docs-hub-group-title">${escapeHtml(group.title)}</h2>
    <p class="docs-hub-group-sub">${escapeHtml(group.subtitle)}</p>
  </div>
  <div class="docs-card-grid">
${cards}
  </div>
</section>`;
  }).join('\n');

  const bodyHtml = `    <div class="container">
      <div class="docs-hub-hero">
        <div class="eyebrow">DOCUMENTATION · SELF-HOSTED PAAS</div>
        <h1 id="docs-heading" tabindex="-1" class="section-title">FlareLens docs</h1>
        <p class="section-lead">
          Everything about deploying, operating, and extending FlareLens—your open-source Platform-as-a-Service running in your own Cloudflare account and on your own servers. AI coding agents can read the complete documentation and JSON Schema as one file at <a href="/llms-full.txt"><code>/llms-full.txt</code></a>.
        </p>
      </div>
${groupsHtml}
    </div>`;

  return renderSiteShell({
    title: 'FlareLens Docs — Open-Source Self-Hosted PaaS',
    description:
      'Documentation for FlareLens: Fleet Management, Blue/Green Deployments, WireGuard Private Mesh, Observability, RAM-Only Secrets & Flags, and R2 Streaming Backups.',
    canonicalPath: '/docs/',
    activeNav: 'docs',
    bodyHtml,
  });
}

function renderDocPageHtml(page, pageIndex) {
  const tableIdxRef = { count: 0 };
  const sectionsHtml = page.sections
    .map((sec) => {
      const blocks = sec.blocks.map((b) => renderBlockHtml(b, tableIdxRef)).join('\n');
      return `<section id="${escapeHtml(sec.id)}" class="docs-section">
  <h2>${escapeHtml(sec.heading)}</h2>
${blocks}
</section>`;
    })
    .join('\n\n');

  const prevPage = pageIndex > 0 ? DOC_PAGES[pageIndex - 1] : null;
  const nextPage = pageIndex < DOC_PAGES.length - 1 ? DOC_PAGES[pageIndex + 1] : null;

  const prevHtml = prevPage
    ? `<a class="docs-pager-link" href="/docs/${prevPage.slug}/">
        <span class="docs-pager-dir">← Previous</span>
        <span class="docs-pager-title">${escapeHtml(prevPage.cardTitle)}</span>
      </a>`
    : `<a class="docs-pager-link" href="/docs/">
        <span class="docs-pager-dir">← Overview</span>
        <span class="docs-pager-title">All Documentation</span>
      </a>`;

  const nextHtml = nextPage
    ? `<a class="docs-pager-link is-next" href="/docs/${nextPage.slug}/">
        <span class="docs-pager-dir">Next →</span>
        <span class="docs-pager-title">${escapeHtml(nextPage.cardTitle)}</span>
      </a>`
    : `<a class="docs-pager-link is-next" href="/compare/">
        <span class="docs-pager-dir">Compare →</span>
        <span class="docs-pager-title">How FlareLens Compares</span>
      </a>`;

  const bodyHtml = `    <div class="container docs-layout">
      ${renderSidebarHtml(page.slug)}

      <article class="docs-prose">
        <header class="docs-section">
          <nav class="docs-breadcrumb" aria-label="Breadcrumb">
            <a href="/docs/">Docs</a>
            <span aria-hidden="true">/</span>
            <span>${escapeHtml(page.cardTitle)}</span>
          </nav>
          <div class="eyebrow">${escapeHtml(page.kicker)}</div>
          <h1 id="docs-heading" tabindex="-1" class="section-title">${escapeHtml(page.title)}</h1>
          <p class="section-lead">${escapeHtml(page.lead)}</p>
        </header>

${sectionsHtml}

        <nav class="docs-pager" aria-label="Documentation pagination">
          ${prevHtml}
          ${nextHtml}
        </nav>
      </article>
    </div>`;

  return renderSiteShell({
    title: `${page.title} — FlareLens Docs`,
    description: page.cardDesc,
    canonicalPath: `/docs/${page.slug}/`,
    activeNav: 'docs',
    bodyHtml,
  });
}

function renderDocsToMarkdown() {
  const chunks = [];
  for (const page of DOC_PAGES) {
    chunks.push(`## ${page.title} (\`https://flarelens.dev/docs/${page.slug}/\`)`);
    chunks.push('');
    chunks.push(page.lead);
    chunks.push('');
    for (const sec of page.sections) {
      chunks.push(`### ${sec.heading}`);
      chunks.push('');
      for (const block of sec.blocks) {
        if (block.type === 'p' || block.type === 'callout') {
          chunks.push(htmlToMarkdownInline(block.html));
          chunks.push('');
        } else if (block.type === 'ul') {
          for (const item of block.items) {
            chunks.push(`- ${htmlToMarkdownInline(item)}`);
          }
          chunks.push('');
        } else if (block.type === 'ol') {
          block.items.forEach((item, idx) => {
            chunks.push(`${idx + 1}. ${htmlToMarkdownInline(item)}`);
          });
          chunks.push('');
        } else if (block.type === 'code') {
          chunks.push('```');
          chunks.push(block.code);
          chunks.push('```');
          chunks.push('');
        } else if (block.type === 'table') {
          chunks.push(`| ${block.headers.join(' | ')} |`);
          chunks.push(`| ${block.headers.map(() => '---').join(' | ')} |`);
          for (const row of block.rows) {
            chunks.push(`| ${row.join(' | ')} |`);
          }
          chunks.push('');
        }
      }
    }
    chunks.push('---');
    chunks.push('');
  }
  return chunks.join('\n');
}

async function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Copy website/src -> website/dist
  copyRecursive(srcDir, distDir);

  // 2. Sync canonical installer scripts from ../public/
  for (const installer of ['install.sh', 'install.ps1']) {
    const srcInstaller = path.join(repoRoot, 'public', installer);
    if (fs.existsSync(srcInstaller)) {
      fs.copyFileSync(srcInstaller, path.join(distDir, installer));
    }
  }

  // 3. Emit canonical JSON Schema at /schemas/fleet.schema.json
  const fleetModule = await import(path.join(repoRoot, 'src', 'control', 'fleet.ts'));
  if (!fleetModule?.FLEET_JSON_SCHEMA) {
    throw new Error('FLEET_JSON_SCHEMA not exported from ../src/control/fleet.ts');
  }
  const schemaJson = JSON.stringify(fleetModule.FLEET_JSON_SCHEMA, null, 2);
  const schemaOut = path.join(distDir, 'schemas', 'fleet.schema.json');
  fs.mkdirSync(path.dirname(schemaOut), { recursive: true });
  fs.writeFileSync(schemaOut, schemaJson + '\n', 'utf8');

  // 4. Generate /docs/index.html and /docs/<slug>/index.html
  const docsDist = path.join(distDir, 'docs');
  fs.mkdirSync(docsDist, { recursive: true });
  fs.writeFileSync(path.join(docsDist, 'index.html'), renderDocsHubHtml(), 'utf8');

  DOC_PAGES.forEach((page, idx) => {
    const pageDir = path.join(docsDist, page.slug);
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'index.html'), renderDocPageHtml(page, idx), 'utf8');
  });

  // 5. Generate /llms.txt, /llms-full.txt & /sitemap.xml
  const pageLinksMd = DOC_PAGES.map(
    (p) => `- [${p.title}](https://flarelens.dev/docs/${p.slug}/): ${p.cardDesc}`,
  ).join('\n');

  const llmsSummary = [
    '# FlareLens',
    '',
    '> Open-source, self-hosted Platform-as-a-Service (BYOC PaaS). Deploy the serverless control plane in your own Cloudflare account (Workers + D1 + KV + R2) and run the static Go daemon (`flarelensd`) on your own servers for Fleet Management, zero-downtime Blue/Green Deployments, WireGuard Private Mesh (`MagicDNS`), Observability (R2 Parquet + DuckDB-WASM), RAM-only Secrets & Flags, and R2 Streaming Backups.',
    '',
    '## Documentation',
    '',
    '- [Documentation Hub](https://flarelens.dev/docs/)',
    pageLinksMd,
    '- [How FlareLens Compares](https://flarelens.dev/compare/)',
    '',
    '## Schemas, Installers & Source',
    '',
    '- [Complete Agent Reference (llms-full.txt)](https://flarelens.dev/llms-full.txt)',
    '- [Fleet Manifest JSON Schema](https://flarelens.dev/schemas/fleet.schema.json)',
    '- [Linux/macOS Host Installer](https://flarelens.dev/install.sh)',
    '- [Control Plane Repository](https://github.com/antwig2/flarelens)',
    '- [Host Agent Repository](https://github.com/antwig2/flarelensd)',
    '',
  ].join('\n');

  const llmsFull = [
    '# FlareLens — Complete Self-Hosted PaaS Documentation & Schema Reference (llms-full.txt)',
    '',
    'FlareLens is an open-source, self-hosted Platform-as-a-Service (Apache-2.0) composed of:',
    '1. Serverless Control Plane in your own Cloudflare account (Workers + D1 + KV + R2)',
    '2. Static Go Host Agent (`flarelensd`) running on your own VMs and bare-metal servers',
    '3. Direct Peer-to-Peer WireGuard Overlay Mesh (`100.64.0.0/10`) with split-horizon `MagicDNS` (`<service>.<env>.mesh`, TTL 5s)',
    '',
    'Canonical URLs:',
    '- Website: https://flarelens.dev/',
    '- Docs Hub: https://flarelens.dev/docs/',
    '- Compare: https://flarelens.dev/compare/',
    '- JSON Schema: https://flarelens.dev/schemas/fleet.schema.json',
    '- Installer: https://flarelens.dev/install.sh',
    '',
    '---',
    '',
    renderDocsToMarkdown(),
    '## Canonical Fleet Manifest JSON Schema (`https://flarelens.dev/schemas/fleet.schema.json`)',
    '',
    '```json',
    schemaJson,
    '```',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(distDir, 'llms.txt'), llmsSummary, 'utf8');
  fs.writeFileSync(path.join(distDir, 'llms-full.txt'), llmsFull, 'utf8');

  const urls = [
    '/',
    '/docs/',
    ...DOC_PAGES.map((p) => `/docs/${p.slug}/`),
    '/compare/',
    '/schemas/fleet.schema.json',
    '/llms-full.txt',
  ];
  const sitemapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>https://flarelens.dev${u}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(distDir, 'sitemap.xml'), sitemapXml, 'utf8');

  console.log('✅ Built flarelens.dev static site into website/dist/');
  console.log(`   • Rendered /docs/ hub + ${DOC_PAGES.length} deep-dive pillar & reference pages`);
  console.log('   • Synced /install.sh & /install.ps1');
  console.log('   • Generated /schemas/fleet.schema.json');
  console.log('   • Generated /llms.txt, /llms-full.txt & /sitemap.xml');
}

main().catch((err) => {
  console.error('❌ Website build failed:', err);
  process.exit(1);
});
