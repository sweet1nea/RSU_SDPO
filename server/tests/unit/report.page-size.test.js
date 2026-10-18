'use strict';

// Regression coverage for report paper size: every report render path — PDF
// export, the on-screen preview's print stylesheet, and the Excel export's
// print page setup — agrees on A4 (210x297mm).
//
// This file only covers the PDF and Excel paths, which are mechanically
// checkable here; the print stylesheet's `@page{size:A4}` in
// reports-analytics.html has no equivalent Node-side check (there's no
// existing browser/Playwright harness in this suite — see
// claude/RSU_SDPO_Report_Template_Unification_2026-09-14.md for how that
// was verified manually last time this file's styling changed) and was
// verified by reading the rendered CSS rule directly.

const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../../models', () => require('../fixtures/mockModels')());

const { Transaction, User, Equipment, TransactionDetail } = require('../../models');
const ctrl = require('../../controllers/report.controller');

// A4 in PDF points (72pt/in): 595.28 x 841.89.
const A4_PORTRAIT = [0, 0, 595.28, 841.89];
const A4_LANDSCAPE = [0, 0, 841.89, 595.28];
// OOXML ST_PaperSize code for A4 — see ECMA-376 Part 1, §18.3.1.66
// (pageSetup / paperSize attribute).
const OOXML_A4_PAPER_SIZE = 9;

function createStreamRes() {
  const chunks = [];
  const headers = {};
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      res.headersSent = true;
      callback();
    }
  });
  res.headersSent = false;
  res.statusCode = 200;
  res.setHeader = jest.fn((name, value) => {
    headers[String(name).toLowerCase()] = value;
  });
  res.getHeader = (name) => headers[String(name).toLowerCase()];
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.jsonBody = body;
  });
  res.getBuffer = () => Buffer.concat(chunks);
  return res;
}

function waitFinish(res) {
  return new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
  });
}

function extractMediaBox(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const m = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  return m ? m.slice(1, 5).map(Number) : null;
}

beforeEach(() => jest.clearAllMocks());

describe('PDF export — A4 page size', () => {
  test('a <=5-column report (portrait) renders at A4 portrait — 595.28x841.89pt', async () => {
    // "overdue" has 5 columns (Borrower/Equipment/Qty/Due Date/Days
    // Overdue, per the screenshot that prompted this fix) — stays portrait
    // under sendPdf's `heads.length > 5 ? landscape : portrait` rule.
    Transaction.findAll.mockResolvedValue([]);
    User.count.mockResolvedValue(0);
    const req = { query: { format: 'pdf', quarter: '3', year: '2026' } };
    const res = createStreamRes();

    ctrl.overdue(req, res);
    await waitFinish(res);

    expect(extractMediaBox(res.getBuffer())).toEqual(A4_PORTRAIT);
  });

  test('a >5-column report (landscape) renders at A4 landscape — 841.89x595.28pt', async () => {
    // "history" (Transaction History Report) has more than 5 columns and
    // takes the landscape branch.
    Transaction.findAll.mockResolvedValue([]);
    const req = { query: { format: 'pdf', quarter: '3', year: '2026' } };
    const res = createStreamRes();

    ctrl.history(req, res);
    await waitFinish(res);

    expect(extractMediaBox(res.getBuffer())).toEqual(A4_LANDSCAPE);
  });
});

describe('Excel export — A4 page setup', () => {
  test('worksheet.pageSetup.paperSize is the OOXML A4 code (9), orientation matches the PDF rule', async () => {
    Equipment.findAll.mockResolvedValue([]);
    const req = { query: { format: 'excel', quarter: '3', year: '2026' } };
    const res = createStreamRes();

    const finished = waitFinish(res);
    await ctrl.condition(req, res); // Equipment Condition Report, <=5 columns -> portrait
    await finished;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    const sheet = wb.worksheets[0];
    expect(sheet.pageSetup.paperSize).toBe(OOXML_A4_PAPER_SIZE);
    expect(sheet.pageSetup.orientation).toBe('portrait');
  });

  test('a >5-column report exports with landscape orientation, still A4 paper', async () => {
    Transaction.findAll.mockResolvedValue([]);
    const req = { query: { format: 'excel', quarter: '3', year: '2026' } };
    const res = createStreamRes();

    const finished = waitFinish(res);
    await ctrl.history(req, res);
    await finished;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    const sheet = wb.worksheets[0];
    expect(sheet.pageSetup.paperSize).toBe(OOXML_A4_PAPER_SIZE);
    expect(sheet.pageSetup.orientation).toBe('landscape');
  });
});
