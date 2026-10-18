'use strict';

// The ONE report template used by every report (borrowing, overdue,
// utilization, history, inventory, condition, transaction log), in both
// export formats. Every report passes the same { title, period?, heads,
// data, stats } shape; this file owns the layout so all reports share the
// same letterhead, logos, fonts, spacing, margins, page size and footer.
// The on-screen preview (client/pages/admin/reports-analytics.html) mirrors
// the same structure.
//
// Paper: A4 (210 x 297 mm), portrait for up to 5 columns, landscape for
// wider tables — identical rule in PDF, Excel and the on-screen print view.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { formatDateTime } = require('../../helpers/dateHelper');

// client/ and server/ are always deployed side by side (server/app.js serves
// client/ statically), so these resolve in every environment. Existence is
// checked once so a missing asset degrades to a text-only header.
const IMAGES_DIR = path.join(__dirname, '..', '..', '..', 'client', 'assets', 'images');
const SEAL_PATH = path.join(IMAGES_DIR, 'rsu-university-seal.png'); // Romblon State University seal (left)
const LOGO_PATH = path.join(IMAGES_DIR, 'rsu-sdpo-logo.png'); // SDPO logo (right)
const SEAL_EXISTS = fs.existsSync(SEAL_PATH);
const LOGO_EXISTS = fs.existsSync(LOGO_PATH);

const LETTERHEAD = {
  republic: 'Republic of the Philippines',
  university: 'ROMBLON STATE UNIVERSITY',
  place: 'Romblon, Philippines',
  office: 'SPORTS DEVELOPMENT PROGRAM OFFICE'
};

const PAGE = { size: 'A4', margin: 40, footerHeight: 24 };
const FONT = { body: 9, table: 8.5, small: 8, title: 13 };
const ROW_PADDING = 4;
const LOGO_SIZE = 50;

function slugify(title) {
  const slug = String(title || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'report';
}

function isLandscape(heads) {
  return heads.length > 5;
}

function generatedOnText() {
  return `${formatDateTime(new Date())} (PHT)`;
}

// Column widths proportional to each column's longest content (header or
// cell), clamped so no column is starved or dominates, then scaled to fill
// the usable width exactly. Long values wrap inside their cell rather than
// being cut off.
function columnWidths(heads, data, usableWidth) {
  if (!heads.length) return [];
  const weights = heads.map((h, i) => {
    let longest = String(h).length;
    data.forEach((row) => {
      if (row[i] != null) longest = Math.max(longest, String(row[i]).length);
    });
    return Math.min(Math.max(longest, 6), 40);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / total) * usableWidth);
}

/**
 * Streams a PDF rendering of a { title, period?, heads, data, stats } report.
 * @param {import('express').Response} res
 * @param {{ title?: string, period?: {range: string, quarterLabel: string}, heads?: string[], data?: Array<Array<string>>, stats?: Array<[string, string]> }} reportData
 * @param {string} [filenameBase] filename without extension; defaults to a slug of the title
 */
function sendPdf(res, reportData, filenameBase) {
  const { title, period, heads = [], data = [], stats = [] } = reportData || {};
  const filename = `${filenameBase || slugify(title)}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // An aborted download can emit 'error' on either stream; unhandled, that
  // would crash the process, so both ends get a listener.
  res.on('error', (err) => {
    console.error('reportRenderer.sendPdf: response stream error:', err);
    if (res.writable) res.end();
  });

  const doc = new PDFDocument({
    size: PAGE.size,
    layout: isLandscape(heads) ? 'landscape' : 'portrait',
    margins: { top: PAGE.margin, left: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin + PAGE.footerHeight },
    bufferPages: true,
    info: { Title: title || 'Report', Author: 'RSU Sports Development Program Office' }
  });
  doc.on('error', (err) => {
    console.error('reportRenderer.sendPdf: pdfkit document error:', err);
    if (res.writable) res.end();
  });
  doc.pipe(res);

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const endX = startX + usableWidth;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;

  // ---- Letterhead: university seal (left), centered university block,
  // SDPO logo (right), rule, office name, rule, report title. ----
  const headerTop = doc.page.margins.top;
  [
    [SEAL_EXISTS, SEAL_PATH, startX],
    [LOGO_EXISTS, LOGO_PATH, endX - LOGO_SIZE]
  ].forEach(([exists, file, x]) => {
    if (!exists) return;
    try {
      doc.image(file, x, headerTop, { fit: [LOGO_SIZE, LOGO_SIZE], align: 'center', valign: 'center' });
    } catch (err) {
      console.error('reportRenderer.sendPdf: failed to draw letterhead image:', err);
    }
  });

  const textX = startX + LOGO_SIZE + 10;
  const textWidth = usableWidth - 2 * (LOGO_SIZE + 10);
  doc.fillColor('#000000');
  doc.font('Helvetica').fontSize(FONT.body).text(LETTERHEAD.republic, textX, headerTop + 4, { width: textWidth, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(15).text(LETTERHEAD.university, textX, doc.y, { width: textWidth, align: 'center' });
  doc.font('Helvetica').fontSize(FONT.body).text(LETTERHEAD.place, textX, doc.y, { width: textWidth, align: 'center' });

  let y = Math.max(doc.y, headerTop + LOGO_SIZE) + 8;
  doc.moveTo(startX, y).lineTo(endX, y).lineWidth(1.5).strokeColor('#000000').stroke();
  y += 6;
  doc.font('Helvetica-Bold').fontSize(11).text(LETTERHEAD.office, startX, y, { width: usableWidth, align: 'center' });
  y = doc.y + 4;
  doc.moveTo(startX, y).lineTo(endX, y).lineWidth(1.5).strokeColor('#000000').stroke();
  y += 10;
  doc.font('Helvetica-Bold').fontSize(FONT.title).text((title || 'REPORT').toUpperCase(), startX, y, { width: usableWidth, align: 'center' });
  y = doc.y + 10;

  // ---- Meta row: period on the left, generation time on the right. ----
  const leftWidth = usableWidth * 0.6;
  const rightWidth = usableWidth - leftWidth;
  doc.font('Helvetica').fontSize(FONT.body).fillColor('#333333');
  let leftEnd = y;
  if (period) {
    doc.text(`Report Period: ${period.range}`, startX, y, { width: leftWidth });
    doc.text(`Quarter: ${period.quarterLabel}`, startX, doc.y, { width: leftWidth });
    leftEnd = doc.y;
  }
  doc.text(`Generated On: ${generatedOnText()}`, startX + leftWidth, y, { width: rightWidth, align: 'right' });
  const rightEnd = doc.y;
  doc.fillColor('#000000');
  y = Math.max(leftEnd, rightEnd) + 12;

  // ---- Summary (always left-aligned at the page margin). ----
  if (stats.length) {
    doc.font('Helvetica-Bold').fontSize(10).text('Summary', startX, y, { width: usableWidth });
    doc.font('Helvetica').fontSize(FONT.body);
    stats.forEach(([label, value]) => {
      doc.text(`${label}: ${value}`, startX, doc.y, { width: usableWidth });
    });
    y = doc.y + 12;
  }

  // ---- Table: header repeated on every page, rows wrap to fit. ----
  const widths = columnWidths(heads, data, usableWidth);
  const xs = widths.map((_, i) => startX + widths.slice(0, i).reduce((a, b) => a + b, 0));

  function rowHeight(cells, bold) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT.table);
    const heights = cells.map((cell, i) =>
      doc.heightOfString(cell == null ? '' : String(cell), { width: widths[i] - ROW_PADDING * 2 })
    );
    return Math.max(...heights, FONT.table) + ROW_PADDING * 2;
  }

  function drawRow(cells, top, bold) {
    const h = rowHeight(cells, bold);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT.table).fillColor('#111111');
    cells.forEach((cell, i) => {
      doc.text(cell == null ? '' : String(cell), xs[i] + ROW_PADDING, top + ROW_PADDING, {
        width: widths[i] - ROW_PADDING * 2,
        lineBreak: true
      });
    });
    const lineY = top + h;
    doc.moveTo(startX, lineY).lineTo(endX, lineY).lineWidth(bold ? 1.2 : 0.5).strokeColor(bold ? '#000000' : '#d5dbe3').stroke();
    return lineY;
  }

  if (heads.length) {
    y = drawRow(heads, y, true);
    data.forEach((row) => {
      if (y + rowHeight(row, false) > bottomLimit()) {
        doc.addPage();
        y = drawRow(heads, doc.page.margins.top, true);
      }
      y = drawRow(row, y, false);
    });
  }

  if (!data.length) {
    doc.font('Helvetica-Oblique').fontSize(FONT.body).fillColor('#333333').text('No records found for the selected period.', startX, y + 6, { width: usableWidth });
  }

  // ---- Footer on every page: office name left, page number right. ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const footerY = doc.page.height - PAGE.margin - FONT.small;
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the bottom margin must not trigger a new page
    doc.moveTo(startX, footerY - 6).lineTo(endX, footerY - 6).lineWidth(0.5).strokeColor('#d5dbe3').stroke();
    doc.font('Helvetica').fontSize(FONT.small).fillColor('#555555');
    doc.text(`RSU ${LETTERHEAD.office} — ${title || 'Report'}`, startX, footerY, { width: usableWidth * 0.75, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, startX, footerY, { width: usableWidth, align: 'right', lineBreak: false });
    doc.page.margins.bottom = originalBottom;
  }

  doc.end();
}

/**
 * Streams an .xlsx rendering of a { title, period?, heads, data, stats } report,
 * using the same letterhead, order and paper setup as sendPdf.
 * @param {import('express').Response} res
 * @param {{ title?: string, period?: {range: string, quarterLabel: string}, heads?: string[], data?: Array<Array<string>>, stats?: Array<[string, string]> }} reportData
 * @param {string} [filenameBase] filename without extension; defaults to a slug of the title
 */
async function sendExcel(res, reportData, filenameBase) {
  const { title, period, heads = [], data = [], stats = [] } = reportData || {};
  const filename = `${filenameBase || slugify(title)}.xlsx`;
  const colCount = Math.max(heads.length, 2);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RSU SDPO';
  workbook.created = new Date();

  const sheetName = (title || 'Report').replace(/[\\/?*[\]:]/g, ' ').substring(0, 31) || 'Report';
  const sheet = workbook.addWorksheet(sheetName);

  // OOXML paper size 9 = A4; orientation follows the same rule as the PDF.
  sheet.pageSetup = {
    paperSize: 9,
    orientation: isLandscape(heads) ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.55, right: 0.55, top: 0.55, bottom: 0.6, header: 0.3, footer: 0.3 }
  };
  sheet.headerFooter.oddFooter = `&L&8RSU ${LETTERHEAD.office} — ${(title || 'Report').replace(/&/g, '&&')}&R&8Page &P of &N`;

  function bannerRow(rowIdx, text, font, extra = {}) {
    sheet.mergeCells(rowIdx, 1, rowIdx, colCount);
    const cell = sheet.getCell(rowIdx, 1);
    cell.value = text;
    cell.font = font;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    Object.assign(cell, extra);
  }

  // Rows 1-5: the same letterhead lines as the PDF.
  bannerRow(1, LETTERHEAD.republic, { size: 9 });
  bannerRow(2, LETTERHEAD.university, { bold: true, size: 14 });
  bannerRow(3, LETTERHEAD.place, { size: 9 });
  bannerRow(4, LETTERHEAD.office, { bold: true, size: 11 }, {
    border: { top: { style: 'medium', color: { argb: 'FF000000' } }, bottom: { style: 'medium', color: { argb: 'FF000000' } } }
  });
  bannerRow(5, (title || 'Report').toUpperCase(), { bold: true, size: 13 });
  sheet.getRow(2).height = 22;
  sheet.getRow(4).height = 18;
  sheet.getRow(5).height = 22;

  // Row 6: period (left) / generated on (right), as in the PDF meta row.
  const leftSpan = Math.max(Math.ceil(colCount / 2), 1);
  const metaFont = { size: 9, color: { argb: 'FF333333' } };
  sheet.mergeCells(6, 1, 6, leftSpan);
  const periodCell = sheet.getCell(6, 1);
  periodCell.value = period ? `Report Period: ${period.range}   Quarter: ${period.quarterLabel}` : '';
  periodCell.font = metaFont;
  periodCell.alignment = { horizontal: 'left' };
  if (leftSpan < colCount) sheet.mergeCells(6, leftSpan + 1, 6, colCount);
  const genCell = sheet.getCell(6, Math.min(leftSpan + 1, colCount));
  genCell.value = `Generated On: ${generatedOnText()}`;
  genCell.font = metaFont;
  genCell.alignment = { horizontal: 'right' };

  // Seal (left) and SDPO logo (right) over the letterhead rows, never over
  // cell values.
  const images = [
    [SEAL_EXISTS, SEAL_PATH, 0.1],
    [LOGO_EXISTS, LOGO_PATH, Math.max(colCount - 0.75, 1)]
  ];
  images.forEach(([exists, file, col]) => {
    if (!exists) return;
    try {
      const id = workbook.addImage({ filename: file, extension: 'png' });
      sheet.addImage(id, { tl: { col, row: 0.1 }, ext: { width: 52, height: 52 } });
    } catch (err) {
      console.error('reportRenderer.sendExcel: failed to embed letterhead image:', err);
    }
  });

  let rowIdx = 8;
  if (stats.length) {
    sheet.getCell(rowIdx, 1).value = 'Summary';
    sheet.getCell(rowIdx, 1).font = { bold: true, size: 10 };
    rowIdx += 1;
    stats.forEach(([label, value]) => {
      sheet.getCell(rowIdx, 1).value = label;
      sheet.getCell(rowIdx, 1).font = { bold: true, size: 9 };
      sheet.getCell(rowIdx, 2).value = value;
      sheet.getCell(rowIdx, 2).font = { size: 9 };
      rowIdx += 1;
    });
    rowIdx += 1;
  }

  if (heads.length) {
    const headerRow = sheet.getRow(rowIdx);
    heads.forEach((h, i) => {
      headerRow.getCell(i + 1).value = h;
    });
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 9, color: { argb: 'FF0F172A' } };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF000000' } } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    // Repeat the table header on every printed page.
    sheet.pageSetup.printTitlesRow = `${rowIdx}:${rowIdx}`;
    rowIdx += 1;
  }

  const firstDataRow = rowIdx;
  data.forEach((row) => {
    const r = sheet.getRow(rowIdx);
    row.forEach((val, i) => {
      const cell = r.getCell(i + 1);
      cell.value = val;
      cell.font = { size: 9 };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD5DBE3' } } };
    });
    rowIdx += 1;
  });

  for (let i = 0; i < colCount; i += 1) {
    let maxLen = heads[i] ? String(heads[i]).length : 10;
    data.forEach((row) => {
      const v = row[i];
      if (v != null) maxLen = Math.max(maxLen, String(v).length);
    });
    sheet.getColumn(i + 1).width = Math.min(Math.max(maxLen + 2, 12), 45);
  }

  if (!data.length) {
    sheet.mergeCells(firstDataRow, 1, firstDataRow, colCount);
    const emptyCell = sheet.getCell(firstDataRow, 1);
    emptyCell.value = 'No records found for the selected period.';
    emptyCell.font = { italic: true, size: 9 };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  res.on('error', (err) => {
    console.error('reportRenderer.sendExcel: response stream error:', err);
    if (res.writable) res.end();
  });

  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { sendPdf, sendExcel, slugify, LETTERHEAD };
