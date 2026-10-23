const fs = require('fs');
const path = require('path');
const { loadPdfLib } = require('./html2pdf-render-support.js');

// ═══════════════════════════════════════════════════════════════════
// pdf-lib post-processing: page count, metadata, merge
// ═══════════════════════════════════════════════════════════════════

async function postProcess(pdfPath, options = {}) {
  const { PDFDocument } = loadPdfLib();
  const pdfBytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(pdfBytes);

  // Set metadata
  if (options.title) doc.setTitle(options.title);
  doc.setProducer('html2pdf-next (Playwright + pdf-lib)');
  doc.setCreationDate(new Date());

  const pageCount = doc.getPageCount();

  // Merge additional PDFs
  if (options.mergeFiles && options.mergeFiles.length) {
    for (const mf of options.mergeFiles) {
      if (!fs.existsSync(mf)) {
        console.log(`  ⚠ Merge file not found: ${mf}`);
        continue;
      }
      console.log(`  📎 Merging: ${path.basename(mf)}`);
      const donorBytes = fs.readFileSync(mf);
      const donorDoc = await PDFDocument.load(donorBytes);
      const copiedPages = await doc.copyPages(donorDoc, donorDoc.getPageIndices());
      copiedPages.forEach(p => doc.addPage(p));
    }
  }

  // Save
  const finalBytes = await doc.save();
  fs.writeFileSync(pdfPath, finalBytes);

  return { pageCount: doc.getPageCount(), originalPages: pageCount };
}

module.exports = { postProcess };
