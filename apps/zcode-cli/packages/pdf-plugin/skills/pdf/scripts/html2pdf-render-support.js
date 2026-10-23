const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// Playwright / Chromium resolution (self-contained, no external helper)
// ═══════════════════════════════════════════════════════════════════

function loadPlaywright() {
  // Try direct require first
  try { return require('playwright'); } catch {}

  // Search common global paths
  const Module = require('module');
  const roots = new Set();
  if (process.env.PLAYWRIGHT_PATH) roots.add(process.env.PLAYWRIGHT_PATH);
  if (process.env.NODE_PATH) {
    process.env.NODE_PATH.split(path.delimiter).filter(Boolean).forEach(p => roots.add(p));
  }
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (g) roots.add(g);
  } catch {}

  for (const base of roots) {
    const pkg = path.join(base, 'playwright', 'package.json');
    if (!fs.existsSync(pkg)) continue;
    try { return Module.createRequire(pkg)('playwright'); } catch {}
  }
  throw new Error('Playwright not found. Install: npm install -g playwright');
}

function loadPdfLib() {
  try { return require('pdf-lib'); } catch {}
  const Module = require('module');
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pkg = path.join(g, 'pdf-lib', 'package.json');
    if (fs.existsSync(pkg)) return Module.createRequire(pkg)('pdf-lib');
  } catch {}
  throw new Error('pdf-lib not found. Install: npm install -g pdf-lib');
}

function resolveChromium(chromiumObj, allowInstall = false) {
  let exe;
  try { exe = chromiumObj.executablePath(); } catch { exe = null; }

  if (exe && fs.existsSync(exe)) {
    return { status: 'ok', executablePath: exe };
  }

  // Try system Chrome/Chromium
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
  ];
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) candidates.unshift(process.env.PLAYWRIGHT_CHROMIUM_PATH);

  for (const c of candidates) {
    if (fs.existsSync(c)) return { status: 'fallback', executablePath: c };
  }

  if (allowInstall) {
    const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: true });
    if (r.status === 0) {
      try { exe = chromiumObj.executablePath(); } catch {}
      if (exe && fs.existsSync(exe)) return { status: 'installed', executablePath: exe };
    }
  }

  return { status: 'missing', executablePath: exe || '' };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function prettyBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${n.toFixed(1)} ${units[u]}`;
}

module.exports = { loadPlaywright, loadPdfLib, resolveChromium, prettyBytes, sleep };
