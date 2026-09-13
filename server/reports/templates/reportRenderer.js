'use strict';

// Shared PDF/Excel rendering for the report controller. All quarterly
// reports (borrowing, overdue, utilization, history, inventory, condition)
// share the same { title, heads, data, stats } shape produced by
// report.controller.js, so the actual document-building logic lives here
// once. The per-report template files in this folder are thin wrappers
// that just pin the download filename for their report type.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

// Official RSU SDPO seal (already used elsewhere in the app, e.g. the
// borrowing-form watermark) — reused here for branded PDF/Excel report
// headers. server/app.js serves `client/` statically from the repo root
// (`express.static('client')`), i.e. client/ and server/ are always
// deployed side by side, so this relative path is safe across
// environments. Resolved once at module load and existence-checked so a
// missing/renamed asset degrades to a text-only header instead of crashing
// report generation.
const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'client', 'assets', 'images', 'rsu-sdpo-logo.png');
const LOGO_EXISTS = fs.existsSync(LOGO_PATH);

// Plain Romblon State University seal — the left-hand seal in the official
// 2026-09-13 letterhead redesign, distinct from the green SDPO gear logo
// above (which sits on the right, matching the approved mockup). No such
// asset exists in the repo yet, so this is existence-checked exactly like
// LOGO_EXISTS above: drop the real seal file at this exact path and it
// starts appearing with no further code changes. Until then the header
// falls back to the single SDPO logo (see headerTop below) rather than
// leaving a blank gap or fabricating a placeholder seal.
const SEAL_PATH = path.join(__dirname, '..', '..', '..', 'client', 'assets', 'images', 'rsu-university-seal.png');
const SEAL_EXISTS = fs.existsSync(SEAL_PATH);

function slugify(title) {
  const slug = String(title || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'report';
}

/**
 * Streams a PDF rendering of a { title, heads, data, stats } report to `res`.
 * @param {import('express').Response} res
 * @param {{ title?: string, heads?: string[], data?: Array<Array<string>>, stats?: Array<[string, string]> }} reportData
 * @param {string} [filenameBase] filename without extension; defaults to a slug of the title
 */
function sendPdf(res, reportData, filenameBase) {
  const { title, period, heads = [], data = [], stats = [] } = reportData || {};
  const filename = `${filenameBase || slugify(title)}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // If the client aborts the download mid-stream, `res` can emit an
  // unhandled 'error' (e.g. ECONNRESET). pipe() does not forward 'error'
  // events between source and destination, and an unhandled 'error' event
  // on an EventEmitter crashes the whole Node process — not just this
  // request — so both ends need their own listener.
  res.on('error', (err) => {
    console.error('reportRenderer.sendPdf: response stream error:', err);
    if (res.writable) res.end();
  });

  const doc = new PDFDocument({
    margin: 40,
    size: 'A4',
    layout: heads.length > 5 ? 'landscape' : 'portrait'
  });
  doc.on('error', (err) => {
    console.error('reportRenderer.sendPdf: pdfkit document error:', err);
    if (res.writable) res.end();
  });
  doc.pipe(res);

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const endX = startX + usableWidth;

  // ---- Official letterhead (2026-09-13 redesign, matches the approved
  // "A4 Overdue Report Design" mockup) — Republic of the Philippines /
  // Romblon State University / Romblon, Philippines centered between the
  // university seal (left) and the SDPO gear logo (right), a thick rule,
  // the office name, a second rule, then the report title. ----
  const headerTop = doc.y;
  const SEAL_WIDTH = 46;
  if (SEAL_EXISTS) {
    try {
      doc.image(SEAL_PATH, startX, headerTop, { width: SEAL_WIDTH });
    } catch (err) {
      // A corrupt/unreadable seal file should never break report
      // generation — fall back to the single-logo/text-only header.
      console.error('reportRenderer.sendPdf: failed to draw university seal:', err);
    }
  }
  if (LOGO_EXISTS) {
    try {
      doc.image(LOGO_PATH, endX - SEAL_WIDTH, headerTop, { width: SEAL_WIDTH });
    } catch (err) {
      console.error('reportRenderer.sendPdf: failed to draw header logo:', err);
    }
  }

  doc.y = headerTop;
  doc.font('Helvetica').fontSize(9).text('Republic of the Philippines', startX, headerTop + 2, { width: usableWidth, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(15).text('ROMBLON STATE UNIVERSITY', startX, doc.y, { width: usableWidth, align: 'center' });
  doc.font('Helvetica').fontSize(9).text('Romblon, Philippines', startX, doc.y, { width: usableWidth, align: 'center' });

  // Whichever is taller — the two seals or the centered text block — wins;
  // doc.image() above drew without moving the cursor, so this has to be
  // done by hand rather than relying on pdfkit's own auto-advance.
  doc.y = Math.max(doc.y, headerTop + SEAL_WIDTH);
  doc.moveDown(0.6);

  doc.moveTo(startX, doc.y).lineTo(endX, doc.y).lineWidth(1.5).strokeColor('#000000').stroke();
  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').fontSize(11).text('SPORTS DEVELOPMENT PROGRAM OFFICE', startX, doc.y, { width: usableWidth, align: 'center' });
  doc.moveDown(0.35);
  doc.moveTo(startX, doc.y).lineTo(endX, doc.y).lineWidth(1.5).strokeColor('#000000').stroke();
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(13).text((title || 'REPORT').toUpperCase(), startX, doc.y, { width: usableWidth, align: 'center' });
  doc.moveDown(0.6);

  // "Report Period" / "Quarter" on the left vs "Generated On" on the right,
  // sharing one row — same two explicit columns pdfkit needs whenever two
  // independent text blocks must sit side by side rather than stack.
  const metaY = doc.y;
  const leftWidth = usableWidth * 0.6;
  const rightWidth = usableWidth - leftWidth;
  const rightX = startX + leftWidth;

  let leftEndY = metaY;
  if (period) {
    doc.font('Helvetica').fontSize(9).fillColor('#333333');
    doc.text(`Report Period: ${period.range}`, startX, metaY, { width: leftWidth });
    doc.text(`Quarter: ${period.quarterLabel}`, startX, doc.y, { width: leftWidth });
    leftEndY = doc.y;
  }

  doc.font('Helvetica').fontSize(9).fillColor('#333333');
  doc.text('Generated On:', rightX, metaY, { width: rightWidth, align: 'right' });
  doc.text(new Date().toLocaleString('en-US'), rightX, doc.y, { width: rightWidth, align: 'right' });
  const rightEndY = doc.y;

  doc.fillColor('#000000');
  doc.y = Math.max(leftEndY, rightEndY);
  doc.moveDown(1);
  // ---- end letterhead ----

  if (stats.length) {
    doc.font('Helvetica-Bold').fontSize(10).text('Summary');
    doc.font('Helvetica').fontSize(9);
    stats.forEach(([label, value]) => {
      doc.text(`${label}: ${value}`);
    });
    doc.moveDown(1);
  }

  const colWidth = heads.length ? usableWidth / heads.length : usableWidth;
  const rowHeight = 16;

  function drawRow(cells, y, isHeader) {
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    cells.forEach((cell, i) => {
      doc.text(cell == null ? '' : String(cell), startX + i * colWidth, y, {
        width: colWidth - 4,
        height: rowHeight,
        ellipsis: true
      });
    });
  }

  function drawHeader(y) {
    if (!heads.length) return y;
    drawRow(heads, y, true);
    const lineY = y + rowHeight - 2;
    doc.moveTo(startX, lineY).lineTo(startX + usableWidth, lineY).strokeColor('#cccccc').stroke();
    doc.strokeColor('#000000');
    return y + rowHeight;
  }

  let y = drawHeader(doc.y);
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  data.forEach((row) => {
    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }
    drawRow(row, y, false);
    y += rowHeight;
  });

  if (!data.length) {
    doc.font('Helvetica-Oblique').fontSize(9).text('No records found for the selected period.', startX, y + 4);
  }

  doc.end();
}

/**
 * Streams an .xlsx rendering of a { title, heads, data, stats } report to `res`.
 * @param {import('express').Response} res
 * @param {{ title?: string, heads?: string[], data?: Array<Array<string>>, stats?: Array<[string, string]> }} reportData
 * @param {string} [filenameBase] filename without extension; defaults to a slug of the title
 */
async function sendExcel(res, reportData, filenameBase) {
  const { title, period, heads = [], data = [], stats = [] } = reportData || {};
  const filename = `${filenameBase || slugify(title)}.xlsx`;
  const colCount = Math.max(heads.length, 1);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RSU SDPO';
  workbook.created = new Date();

  const sheetName = (title || 'Report').substring(0, 31) || 'Report';
  const sheet = workbook.addWorksheet(sheetName);

  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `RSU SDPO - ${title || 'Report'}`;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center' };

  // Row 2 mirrors the PDF letterhead's meta line: "Report Period"/"Quarter"
  // on the left, "Generated On" on the right, sharing one row — instead of
  // two separate full-width centered lines. For the point-in-time snapshot
  // reports (inventory, condition) that don't carry a `period`, "Generated
  // On" simply takes the full width, right-aligned to match where it sits
  // when a period is present.
  const leftSpan = Math.max(Math.ceil(colCount / 2), 1);
  const generatedOnText = `Generated On: ${new Date().toLocaleString('en-US')}`;
  if (period) {
    sheet.mergeCells(2, 1, 2, leftSpan);
    const periodCell = sheet.getCell(2, 1);
    periodCell.value = `Report Period: ${period.range}   Quarter: ${period.quarterLabel}`;
    periodCell.font = { italic: true, size: 9, color: { argb: 'FF555555' } };
    periodCell.alignment = { horizontal: 'left' };

    if (leftSpan < colCount) {
      sheet.mergeCells(2, leftSpan + 1, 2, colCount);
    }
    const genCell = sheet.getCell(2, leftSpan + 1);
    genCell.value = generatedOnText;
    genCell.font = { italic: true, size: 9, color: { argb: 'FF555555' } };
    genCell.alignment = { horizontal: 'right' };
  } else {
    sheet.mergeCells(2, 1, 2, colCount);
    const genCell = sheet.getCell(2, 1);
    genCell.value = generatedOnText;
    genCell.font = { italic: true, size: 9, color: { argb: 'FF555555' } };
    genCell.alignment = { horizontal: 'right' };
  }
  // Row 3 stays a blank spacer, matching the PDF's own gap between the
  // letterhead and the Summary/table below.

  // Official RSU SDPO seal + the Romblon State University seal, floated over
  // the top-left/top-right corners of the header band (rows 1-2) — the same
  // two-seal branding used in the PDF/on-screen letterhead (university seal
  // left, SDPO gear logo right). This only overlays visually — it never
  // touches cell values, so the `RSU SDPO - <title>` banner text and every
  // downstream row/column offset the rest of this function (and its tests)
  // depend on are unaffected whether or not either logo file is present.
  sheet.getRow(1).height = 30;
  sheet.getRow(2).height = 18;
  if (SEAL_EXISTS) {
    try {
      const sealImageId = workbook.addImage({ filename: SEAL_PATH, extension: 'png' });
      sheet.addImage(sealImageId, {
        tl: { col: 0.15, row: 0.15 },
        ext: { width: 46, height: 46 }
      });
    } catch (err) {
      console.error('reportRenderer.sendExcel: failed to embed header seal:', err);
    }
  }
  if (LOGO_EXISTS) {
    try {
      const logoImageId = workbook.addImage({ filename: LOGO_PATH, extension: 'png' });
      // 0.65 rather than 0.3 into the last column: for a report with only a
      // few (wide) columns, e.g. the 5-column Equipment Condition Report,
      // the centered "RSU SDPO - <title>" banner text can run far enough
      // right to visually collide with a logo anchored too close to that
      // column's own left edge — confirmed by rendering a real populated
      // report through LibreOffice and looking at it, not just reasoned
      // about. Anchoring further right (past where the title text ends)
      // clears that overlap while staying inside the sheet's used range.
      sheet.addImage(logoImageId, {
        tl: { col: colCount + 0.1, row: 0.15 },
        ext: { width: 46, height: 46 }
      });
    } catch (err) {
      console.error('reportRenderer.sendExcel: failed to embed header logo:', err);
    }
  }

  let rowIdx = 4;
  if (stats.length) {
    stats.forEach(([label, value]) => {
      sheet.getCell(rowIdx, 1).value = label;
      sheet.getCell(rowIdx, 1).font = { bold: true };
      sheet.getCell(rowIdx, 2).value = value;
      rowIdx += 1;
    });
    rowIdx += 1;
  }

  if (heads.length) {
    const headerRow = sheet.getRow(rowIdx);
    heads.forEach((h, i) => {
      headerRow.getCell(i + 1).value = h;
    });
    // Plain white header row with a bold black bottom border — matches the
    // PDF's own table header (drawRow + the thin rule under it), replacing
    // the solid-color banner row this used to render as. A colored fill
    // here was the biggest visual mismatch reported against the PDF
    // template: the PDF has never had a colored header band, only bold text
    // over a rule.
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FF0F172A' } };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF000000' } } };
      cell.alignment = { vertical: 'middle' };
    });
    rowIdx += 1;
  }

  const firstDataRow = rowIdx;
  data.forEach((row) => {
    const r = sheet.getRow(rowIdx);
    row.forEach((val, i) => {
      r.getCell(i + 1).value = val;
    });
    rowIdx += 1;
  });

  for (let i = 0; i < colCount; i += 1) {
    let maxLen = heads[i] ? String(heads[i]).length : 10;
    data.forEach((row) => {
      const v = row[i];
      if (v != null) maxLen = Math.max(maxLen, String(v).length);
    });
    sheet.getColumn(i + 1).width = Math.min(Math.max(maxLen + 2, 12), 50);
  }

  if (!data.length) {
    sheet.mergeCells(firstDataRow, 1, firstDataRow, colCount);
    const emptyCell = sheet.getCell(firstDataRow, 1);
    emptyCell.value = 'No records found for the selected period.';
    emptyCell.font = { italic: true };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Same rationale as sendPdf above: ExcelJS pipes its internal zip stream
  // to `res` internally, which doesn't forward 'error' events either, so an
  // aborted download can otherwise emit an unhandled 'error' on `res` and
  // crash the process.
  res.on('error', (err) => {
    console.error('reportRenderer.sendExcel: response stream error:', err);
    if (res.writable) res.end();
  });

  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { sendPdf, sendExcel, slugify };
