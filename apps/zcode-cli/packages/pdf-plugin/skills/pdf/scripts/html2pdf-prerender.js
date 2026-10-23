const { sleep } = require('./html2pdf-render-support.js');

// ═══════════════════════════════════════════════════════════════════
// Pre-render hooks (run in browser context before PDF export)
// ═══════════════════════════════════════════════════════════════════

async function preRenderHooks(page) {
  const warnings = [];

  // 1. Wait for Mermaid diagrams
  const hasMermaid = await page.evaluate(() => document.querySelectorAll('.mermaid').length > 0);
  if (hasMermaid) {
    console.log('  ⏳ Waiting for Mermaid diagrams...');
    try {
      await page.waitForFunction(() => {
        for (const m of document.querySelectorAll('.mermaid'))
          if (!m.querySelector('svg') && !m.getAttribute('data-processed')) return false;
        return true;
      }, { timeout: 30000 });
      await sleep(2000);
      console.log('  ✓ Mermaid rendered');
    } catch {
      warnings.push('Mermaid rendering timed out (30s)');
    }
  }

  // 2. Trigger KaTeX math rendering
  const katexStatus = await page.evaluate(() => ({
    lib: typeof renderMathInElement === 'function' || typeof katex !== 'undefined',
    rendered: document.querySelectorAll('.katex').length > 0,
    raw: /\$[^$]+\$|\$\$[^$]+\$\$|\\\(.*?\\\)|\\\[.*?\\\]/.test(document.body.innerText),
  }));

  // Auto-inject KaTeX CDN if raw math detected but library not loaded
  if (!katexStatus.lib && katexStatus.raw && !katexStatus.rendered) {
    console.log('  ⏳ Auto-injecting KaTeX CDN (math formulas detected but KaTeX not loaded)...');
    await page.addStyleTag({ url: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css' });
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js' });
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js' });
    await sleep(2000); // Wait for CDN scripts to load
    // Re-check
    const recheckLib = await page.evaluate(() => typeof renderMathInElement === 'function');
    if (recheckLib) {
      console.log('  ✓ KaTeX CDN loaded successfully');
    } else {
      console.log('  ⚠ KaTeX CDN failed to load — math will render as raw text');
      warnings.push('KaTeX CDN injection failed; math formulas may appear as raw LaTeX code');
    }
  }

  // Re-evaluate after potential CDN injection
  const katexReady = await page.evaluate(() => ({
    lib: typeof renderMathInElement === 'function' || typeof katex !== 'undefined',
    rendered: document.querySelectorAll('.katex').length > 0,
    raw: /\$[^$]+\$|\$\$[^$]+\$\$|\\\(.*?\\\)|\\\[.*?\\\]/.test(document.body.innerText),
  }));

  if (katexReady.lib && !katexReady.rendered && katexReady.raw) {
    console.log('  ⏳ Triggering KaTeX rendering...');
    await page.evaluate(() => {
      if (typeof renderMathInElement === 'function')
        renderMathInElement(document.body, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
    });
    await sleep(1000);
    console.log('  ✓ KaTeX rendered');
  } else if (katexReady.rendered) {
    await sleep(500); // Font loading settle
  }

  // 3. Fix oversized elements that prevent page breaks
  const nFixed = await page.evaluate(() => {
    const LIMIT = 1000;
    let n = 0;
    document.querySelectorAll(
      '[style*="page-break-inside: avoid"],[style*="break-inside: avoid"],' +
      '.avoid-break,table,figure,.theorem,.algorithm'
    ).forEach(el => {
      if (el.getBoundingClientRect().height > LIMIT) {
        el.style.pageBreakInside = 'auto';
        el.style.breakInside = 'auto';
        n++;
      }
    });
    return n;
  });
  if (nFixed) {
    console.log(`  ⚠ Fixed ${nFixed} oversized elements (removed break-inside: avoid)`);
  }

  // 4. Detect overflow (horizontal AND vertical)
  const overflows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('pre,table,figure,img,svg,.mermaid,blockquote,.equation').forEach(el => {
      const hDiff = el.scrollWidth - el.clientWidth;
      const vDiff = el.scrollHeight - el.clientHeight;
      if (hDiff > 2 || vDiff > 2) out.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className || '',
        hOverflow: hDiff > 2 ? hDiff : 0,
        vOverflow: vDiff > 2 ? vDiff : 0,
        preview: (el.textContent || '').slice(0, 50).replace(/\s+/g, ' '),
      });
    });
    return out;
  });
  if (overflows.length) {
    console.log('  ⚠ Overflow detected:');
    overflows.forEach(o => {
      const parts = [];
      if (o.hOverflow) parts.push(`H +${o.hOverflow}px`);
      if (o.vOverflow) parts.push(`V +${o.vOverflow}px`);
      console.log(`    <${o.tag}${o.cls ? '.' + o.cls.split(' ')[0] : ''}> ${parts.join(', ')}`);
    });
    warnings.push(`${overflows.length} element(s) have overflow`);
  }

  // 4b. Fix vertical overflow on page-level containers
  //     When html/body or the main content canvas has a fixed height + overflow:hidden,
  //     content gets clipped. For documents (html2pdf-next.js), we DON'T expand the
  //     container to its scrollHeight — that creates an oversized single "page" that
  //     Playwright splits unevenly. Instead, we remove the fixed height and overflow:hidden
  //     so content flows naturally and @page CSS handles pagination.
  //
  //     (The old "expand to scrollHeight" logic belongs in html2poster.js where a single
  //     continuous canvas is the desired output.)
  const vOverflowFix = await page.evaluate(() => {
    const fixes = [];
    // Candidates: html, body, and any direct child of body that acts as a full-page canvas
    const candidates = [document.documentElement, document.body];
    const bodyChildren = document.body.children;
    for (let i = 0; i < bodyChildren.length; i++) {
      const child = bodyChildren[i];
      // Skip SVG defs, script, style elements
      const tag = child.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'script' || tag === 'style' || tag === 'link') continue;
      candidates.push(child);
      // Also check one level deeper (e.g., .canvas > .content)
      for (let j = 0; j < child.children.length; j++) {
        const grandchild = child.children[j];
        const gtag = grandchild.tagName.toLowerCase();
        if (gtag === 'svg' || gtag === 'script' || gtag === 'style') continue;
        candidates.push(grandchild);
      }
    }

    for (const el of candidates) {
      const computed = getComputedStyle(el);
      const overflow = computed.overflow || computed.overflowY;
      const hasHiddenOverflow = overflow === 'hidden' || overflow === 'clip';
      const diff = el.scrollHeight - el.clientHeight;

      if (hasHiddenOverflow && diff > 5) {
        // This element is clipping content vertically
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
        const selector = `${tag}${id}${cls}`;

        const oldHeight = el.clientHeight;

        // Document mode: remove fixed height + overflow:hidden,
        // let @page handle natural pagination
        el.style.height = 'auto';
        el.style.minHeight = 'auto';
        el.style.maxHeight = 'none';
        el.style.overflow = 'visible';
        el.style.overflowY = 'visible';

        fixes.push({
          selector,
          oldHeight,
          clipped: diff,
        });
      }
    }

    // After fixing containers, re-measure to get the final content height
    const finalHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );

    return { fixes, finalHeight };
  });

  if (vOverflowFix.fixes.length) {
    console.log('  ⚠️  Removed fixed height + overflow:hidden — content will paginate naturally:');
    vOverflowFix.fixes.forEach(f => {
      console.log(`    ${f.selector}: was ${f.oldHeight}px with ${f.clipped}px clipped → now auto (content will flow to next page)`);
    });
  }

  // 4c. Convert absolute-bottom elements to document flow
  //     Elements with `position: absolute; bottom: Npx` inside page containers
  //     are pinned relative to their containing block. When content paginates
  //     across multiple @page pages, these elements either overlap with body
  //     text or land on the wrong page. Fix: convert them to static positioning
  //     so they participate in normal document flow and paginate naturally.
  const absBottomFix = await page.evaluate(() => {
    const converted = [];
    // Scan inside page-level containers (body children and their children)
    const containers = [];
    for (let i = 0; i < document.body.children.length; i++) {
      const child = document.body.children[i];
      const tag = child.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'script' || tag === 'style' || tag === 'link') continue;
      containers.push(child);
    }

    for (const container of containers) {
      const descendants = container.querySelectorAll('*');
      for (const el of descendants) {
        const computed = getComputedStyle(el);
        if (computed.position === 'absolute' && computed.bottom !== 'auto' && computed.bottom !== '') {
          // Check if this element contains visible text (not just decorative)
          const hasText = el.textContent && el.textContent.trim().length > 0;
          if (!hasText) continue;

          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
          const selector = `${tag}${id}${cls}`;

          // Convert to static flow: remove absolute positioning
          el.style.position = 'static';
          el.style.bottom = 'auto';
          el.style.left = 'auto';
          el.style.right = 'auto';
          // Preserve horizontal padding/margin from the original left/right values
          // by keeping any existing padding or margin on the element

          converted.push({ selector, bottom: computed.bottom });
        }
      }
    }
    return converted;
  });

  if (absBottomFix.length) {
    console.log('  ⚠️  Converted absolute-bottom elements to document flow (prevents overlap on multi-page):');
    absBottomFix.forEach(f => {
      console.log(`    ${f.selector}: was position:absolute;bottom:${f.bottom} → now static (flows with content)`);
    });
  }

  // 5. Inject minimal @page CSS fallback
  await page.evaluate(() => {
    const styles = Array.from(document.querySelectorAll('style'));
    const hasPageRule = styles.some(s => (s.textContent || '').includes('@page'));
    if (!hasPageRule) {
      const s = document.createElement('style');
      s.textContent = `@page { margin: 20mm; }`;
      document.head.appendChild(s);
    }
  });

  // 6. Fix full-page cover sections for print
  //    In screen mode, height:100vh = viewport height. In print mode, 100vh ≠ page height.
  //    Detect elements using 100vh and convert to print-safe page-filling behavior.
  const coverFixed = await page.evaluate(() => {
    let fixed = 0;
    // Find elements with height: 100vh (inline or computed)
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const style = el.style;
      const computed = getComputedStyle(el);
      const isVh = style.height === '100vh' || computed.height === '100vh' ||
                   style.minHeight === '100vh' || computed.minHeight === '100vh';
      // Also detect via class name hints
      const isCover = el.classList.contains('cover') || el.classList.contains('cover-page') ||
                      el.id === 'cover' || el.getAttribute('data-role') === 'cover';
      if (isVh || (isCover && el.offsetHeight > 0)) {
        // Force the element to fill the print page
        el.style.height = '100vh';
        el.style.minHeight = '100vh';
        el.style.pageBreakAfter = 'always';
        el.style.pageBreakInside = 'avoid';
        el.style.boxSizing = 'border-box';
        el.style.overflow = 'hidden';
        fixed++;
      }
    }
    // Inject print-specific CSS to make 100vh work correctly
    if (fixed > 0) {
      const s = document.createElement('style');
      s.textContent = `
        @media print {
          .cover, .cover-page, [data-role="cover"] {
            height: 100vh !important;
            min-height: 100vh !important;
            page-break-after: always !important;
            page-break-inside: avoid !important;
            overflow: hidden !important;
          }
        }
      `;
      document.head.appendChild(s);
    }
    return fixed;
  });
  if (coverFixed) {
    console.log(`  ✓ Fixed ${coverFixed} full-page cover section(s) for print`);
    // Also inject named @page rule for cover with zero margins
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = `
        @page cover-page {
          margin: 0 !important;
        }
        @media print {
          .cover, .cover-page, [data-role="cover"] {
            page: cover-page;
            margin: 0 !important;
            padding: 40px !important;
          }
        }
      `;
      document.head.appendChild(s);
    });
  }

  return { warnings, contentHeight: vOverflowFix.finalHeight };
}

// ═══════════════════════════════════════════════════════════════════
// Content statistics (post-render, from PDF or page)
// ═══════════════════════════════════════════════════════════════════

async function collectStats(page) {
  return page.evaluate(() => {
    const body = document.body;
    const text = body.innerText || '';
    const zhChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enWords = (text.match(/[a-zA-Z]+/g) || []).length;
    return {
      wordCount: zhChars + enWords,
      figures: document.querySelectorAll('figure,.figure,img').length,
      tables: document.querySelectorAll('table').length,
    };
  });
}

module.exports = { preRenderHooks, collectStats };
