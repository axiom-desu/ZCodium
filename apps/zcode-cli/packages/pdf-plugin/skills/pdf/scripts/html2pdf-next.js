#!/usr/bin/env node
/**
 * html2pdf-next.js — HTML → PDF converter using Playwright + pdf-lib
 *
 * Drop-in replacement for html2pdf.js, WITHOUT Paged.js dependency.
 * Uses Chromium native @page CSS for pagination + pdf-lib for post-processing.
 *
 * Usage:
 *   node html2pdf-next.js input.html
 *   node html2pdf-next.js input.html --output result.pdf
 *   node html2pdf-next.js input.html --css extra.css
 *   node html2pdf-next.js input.html --width 720px --height 960px
 *   node html2pdf-next.js input.html --direct   (same as default now — no Paged.js to skip)
 *   node html2pdf-next.js input.html --merge a.pdf b.pdf  (merge additional PDFs after)
 *
 * Architecture:
 *   1. Playwright renders HTML → raw PDF via Chromium's native print engine
 *   2. Pre-render hooks: Mermaid, KaTeX, oversized element fixes
 *   3. Post-render: pdf-lib for merge, metadata, page count extraction
 *   4. No Paged.js, no paged.polyfill.js — CSS @page handles pagination natively
 */

const fs = require('fs');
const path = require('path');

const { loadPlaywright, resolveChromium, prettyBytes } = require('./html2pdf-render-support.js');
const { preRenderHooks, collectStats } = require('./html2pdf-prerender.js');
const { postProcess } = require('./html2pdf-postprocess.js');

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════

function cli() {
  const tokens = process.argv.slice(2);
  if (!tokens.length || tokens[0] === '-h' || tokens[0] === '--help') {
    console.log(`
Usage: node html2pdf-next.js <input.html> [options]

Options:
  --output, -o <file>   Output PDF path (default: <input>.pdf)
  --css <file>          Inject extra stylesheet
  --width <px>          Custom page width  (e.g. 720px)
  --height <px>         Custom page height (e.g. 960px)
  --direct              (no-op, kept for backward compat — always direct now)
  --merge <files...>    Append additional PDF files after conversion
  --title <text>        Set PDF document title metadata
  --help, -h            Show help
`);
    process.exit(0);
  }

  const inputFile = tokens[0];
  let outputFile = null, customCSS = null, width = null, height = null;
  let mergeFiles = [], title = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--output' || t === '-o') outputFile = tokens[++i];
    else if (t === '--css') customCSS = tokens[++i];
    else if (t === '--width') width = tokens[++i];
    else if (t === '--height') height = tokens[++i];
    else if (t === '--direct') { /* no-op, always direct */ }
    else if (t === '--title') title = tokens[++i];
    else if (t === '--merge') {
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        mergeFiles.push(tokens[++i]);
      }
    }
  }

  if (!outputFile) {
    const p = path.parse(inputFile);
    outputFile = path.join(p.dir || '.', p.name + '.pdf');
  }

  return { inputFile, outputFile, customCSS, width, height, mergeFiles, title };
}

// ═══════════════════════════════════════════════════════════════════
// Main pipeline
// ═══════════════════════════════════════════════════════════════════

async function convert(inputFile, outputFile, customCSS, options = {}) {
  const { width, height, mergeFiles, title } = options;

  if (!fs.existsSync(inputFile)) {
    console.error(`✗ File not found: ${inputFile}`);
    process.exit(1);
  }

  const playwright = loadPlaywright();
  const { chromium } = playwright;

  // Resolve browser
  const canInstall = process.env.PDF_SKIP_BROWSER_INSTALL !== '1';
  const bInfo = resolveChromium(chromium, canInstall);

  if (bInfo.status === 'missing') {
    console.error('\n✗ Chromium not found. Run: npx playwright install chromium\n');
    process.exit(2);
  }
  if (bInfo.status === 'fallback') {
    console.log(`⚠ Using fallback Chromium: ${bInfo.executablePath}`);
  }

  const absIn = path.resolve(inputFile);
  const absOut = path.resolve(outputFile);

  console.log(`\n🔄 Converting ${path.basename(inputFile)}...`);
  console.log(`   Engine: Playwright + Chromium native @page (no Paged.js)`);

  // Read and optionally inject CSS
  let html = fs.readFileSync(absIn, 'utf-8');
  if (customCSS) {
    if (!fs.existsSync(customCSS)) {
      console.error(`✗ CSS file not found: ${customCSS}`);
      process.exit(1);
    }
    const tag = `<style>${fs.readFileSync(customCSS, 'utf-8')}</style>`;
    html = html.includes('</head>') ? html.replace('</head>', tag + '\n</head>') : tag + '\n' + html;
    // Write modified HTML for Playwright to load
    const tmpHtml = absIn + '.tmp.html';
    fs.writeFileSync(tmpHtml, html);
    // We'll clean up later
  }

  // Launch browser
  let browser;
  try {
    const opts = { headless: true };
    if (bInfo.status === 'fallback') opts.executablePath = bInfo.executablePath;
    browser = await chromium.launch(opts);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('shared libraries') || msg.includes('.so')) {
      console.error('\n✗ Missing system libraries. Run: npx playwright install-deps chromium\n');
    } else {
      console.error(`\n✗ Browser launch failed: ${msg}\n`);
    }
    process.exit(1);
  }

  try {
    const page = await browser.newPage();
    const loadFile = customCSS ? absIn + '.tmp.html' : absIn;
    await page.goto('file://' + loadFile, { waitUntil: 'networkidle' });

    // ── Pre-render hooks ──
    console.log('\n📋 Pre-render checks:');
    const preRenderResult = await preRenderHooks(page);
    const warnings = preRenderResult.warnings;
    const measuredContentHeight = preRenderResult.contentHeight;

    // ── Detect continuous-canvas mode (design_engine.py output) ──
    const continuousInfo = await page.evaluate(() => {
      const el = document.querySelector('.continuous-canvas');
      if (!el) return null;
      const root = getComputedStyle(document.documentElement);
      return {
        width: root.getPropertyValue('--canvas-w').trim() || '720px',
        height: root.getPropertyValue('--canvas-h').trim() || '960px',
        pages: el.querySelectorAll('.page-section').length,
      };
    });

    if (continuousInfo) {
      // Creative PDF: seamless multi-page canvas
      console.log(`\n🎨 Continuous canvas: ${continuousInfo.pages} pages @ ${continuousInfo.width} × ${continuousInfo.height}`);
      await page.pdf({
        path: absOut,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        width: continuousInfo.width,
        height: continuousInfo.height,
      });
    } else {
      // Standard document
      console.log('\n📄 Rendering PDF...');
      const pdfOpts = {
        path: absOut,
        printBackground: true,
        preferCSSPageSize: true,
        tagged: true,
      };

      if (width || height) {
        if (width) pdfOpts.width = width;
        if (height) pdfOpts.height = height;
        pdfOpts.margin = { top: 0, right: 0, bottom: 0, left: 0 };
        console.log(`   Custom size: ${pdfOpts.width || 'auto'} × ${pdfOpts.height || 'auto'}`);
      } else {
        // No explicit size: check if @page CSS defines a fixed size
        const pageSize = await page.evaluate(() => {
          const styles = Array.from(document.querySelectorAll('style'));
          for (const s of styles) {
            const text = s.textContent || '';
            const match = text.match(/@page\s*\{[^}]*size:\s*([\d.]+)px\s+([\d.]+)px/);
            if (match) return { width: parseFloat(match[1]), height: parseFloat(match[2]) };
          }
          return null;
        });

        if (pageSize) {
          // @page defines a fixed size — use preferCSSPageSize (already set above).
          // Playwright will paginate content at @page height boundaries seamlessly.
          // This is correct for both posters (seamless multi-page) and documents.
          pdfOpts.margin = { top: 0, right: 0, bottom: 0, left: 0 };
          console.log(`   @page size: ${pageSize.width}px × ${pageSize.height}px`);
          if (measuredContentHeight && measuredContentHeight > pageSize.height + 5) {
            const estPages = Math.ceil(measuredContentHeight / pageSize.height);
            console.log(`   Content height: ${measuredContentHeight}px → ~${estPages} pages`);
          }
        } else {
          pdfOpts.format = 'A4';
        }
      }

      await page.pdf(pdfOpts);
    }

    // Collect content stats from the page
    const stats = await collectStats(page);

    // ── pdf-lib post-processing ──
    console.log('\n🔧 Post-processing (pdf-lib):');
    const postResult = await postProcess(absOut, { mergeFiles, title });

    // Clean up temp HTML
    const tmpHtml = absIn + '.tmp.html';
    if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml);

    // ── Report ──
    const sz = fs.statSync(absOut).size;
    console.log('\n' + '═'.repeat(40));
    console.log('  PDF Generated Successfully');
    console.log('═'.repeat(40));
    console.log(`  File:    ${path.basename(absOut)}`);
    console.log(`  Pages:   ${postResult.pageCount}`);
    console.log(`  Size:    ${prettyBytes(sz)}`);
    console.log(`  Words:   ~${stats.wordCount.toLocaleString()}`);
    console.log(`  Assets:  ${stats.figures} figures, ${stats.tables} tables`);
    console.log(`  Engine:  Playwright (no Paged.js)`);
    console.log(`  Path:    ${absOut}`);

    if (mergeFiles && mergeFiles.length && postResult.pageCount > postResult.originalPages) {
      console.log(`  Merged:  +${postResult.pageCount - postResult.originalPages} pages from ${mergeFiles.length} file(s)`);
    }

    if (warnings.length) {
      console.log('\n⚠ Warnings:');
      warnings.forEach(w => console.log(`  · ${w}`));
    }

    // Anomaly detection
    if (postResult.pageCount > 1 && stats.wordCount > 0) {
      const avgWordsPerPage = stats.wordCount / postResult.pageCount;
      if (avgWordsPerPage < 30) {
        console.log(`\n⚠ Low content density: ~${Math.round(avgWordsPerPage)} words/page (expected 100+)`);
      }
    }

  } catch (err) {
    console.error('\n✗ Conversion failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Entry
// ═══════════════════════════════════════════════════════════════════

(async () => {
  try {
    const args = cli();
    await convert(args.inputFile, args.outputFile, args.customCSS, {
      width: args.width,
      height: args.height,
      mergeFiles: args.mergeFiles,
      title: args.title,
    });
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
