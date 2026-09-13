'use strict';

const { Op } = require('sequelize');
const { Transaction, TransactionDetail, Equipment, Category, Item, Borrower, User } = require('../models');
const { INCLUDE, serialize } = require('./borrow.controller');
const borrowingReportTemplate = require('../reports/templates/borrowingReportTemplate');
const overdueReportTemplate = require('../reports/templates/overdueReportTemplate');
const utilizationReportTemplate = require('../reports/templates/utilizationReportTemplate');
const transactionHistoryTemplate = require('../reports/templates/transactionHistoryTemplate');
const equipmentConditionTemplate = require('../reports/templates/equipmentConditionTemplate');
const { sendPdf, sendExcel } = require('../reports/templates/reportRenderer');

// Renders `reportData` ({ title, heads, data, stats }) as PDF/Excel using the
// given per-report template when req.query.format asks for one, otherwise
// falls through to the caller's own res.json(...) call so the existing JSON
// API (used by the admin dashboard table views and already covered by
// route-level auth tests) is completely unaffected.
function renderFormat(req, res, template, reportData) {
  const format = req.query.format;
  if (format === 'pdf') {
    template.pdf(res, reportData);
    return true;
  }
  if (format === 'excel') {
    template.excel(res, reportData).catch((err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: err.message });
      } else {
        // Headers (and possibly some body bytes) are already on the wire —
        // res.json() would throw ERR_HTTP_HEADERS_SENT here. End the
        // connection instead of leaving the client hanging indefinitely.
        console.error('report.controller: excel export failed after headers sent:', err);
        res.end();
      }
    });
    return true;
  }
  return false;
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

// Philippine Time is a fixed UTC+8 offset (no DST), so "the start of Q1
// 2026 in PHT" can be computed directly as a UTC instant without needing a
// timezone database — Date.UTC(year, month, day, hour) with the hour
// shifted back by 8 lands exactly on 00:00 PHT.
const PHT_OFFSET_MINUTES = 8 * 60;
function startOfPhtDate(year, monthIndex0, day) {
  return new Date(Date.UTC(year, monthIndex0, day, 0, 0, 0) - PHT_OFFSET_MINUTES * 60 * 1000);
}
// "Right now, as a PHT wall-clock reading" — used only to pick the default
// year/quarter when the caller doesn't specify one. Shifting the instant
// forward by the PHT offset and then reading it with the UTC getters is the
// standard fixed-offset-timezone trick; it keeps the *default quarter
// selection* correct near a quarter boundary too, not just the range math
// below (a request made at, say, 2:00 AM PHT on Jan 1 is 6:00 PM UTC Dec 31
// on a UTC-configured server — without this it would default to Q4 of the
// old year instead of Q1 of the new one).
function nowInPht() {
  return new Date(Date.now() + PHT_OFFSET_MINUTES * 60 * 1000);
}

// Every report is filtered to a quarter+year window over requestDatetime,
// same convention as the existing transactionLog calendar report below.
//
// Medium #6 from the 2026-09-08 system audit: this used to build the range
// with `new Date(year, startMonth, 1)`, which is always evaluated in the
// server *process's* local timezone. If the server runs in UTC (typical on
// Vercel/Railway — see the approved deployment stack), midnight PHT on the
// first day of a quarter is actually 16:00 UTC the *previous* day, so any
// transaction made in the first 8 hours of a new quarter (PHT) was still
// being counted in the old quarter's report, and the last 8 hours of the
// outgoing quarter were being cut off early. requestDatetime itself is
// stored as a normal UTC instant either way (Sequelize/Postgres always
// store DATE/TIMESTAMP in UTC) — only the *boundary* needs to be pinned to
// PHT rather than whatever timezone the process happens to be running in.
function quarterRange(req) {
  const phtNow = nowInPht();
  const year = parseInt(req.query.year, 10) || phtNow.getUTCFullYear();
  const quarter = parseInt(req.query.quarter, 10) || Math.floor(phtNow.getUTCMonth() / 3) + 1;
  const startMonth = (quarter - 1) * 3;
  const start = startOfPhtDate(year, startMonth, 1);
  const end = startOfPhtDate(year, startMonth + 3, 1);
  return { year, quarter, start, end };
}

// "Report Period: January – March 2024" / "Quarter: Q1 2024 (January –
// March)" — the two lines under the letterhead on the official report
// format (2026-09-13 redesign). Derived from the same {year, quarter}
// quarterRange() already computes for the 4 quarter-bound reports below, so
// this never drifts out of sync with the actual query range those reports
// are filtered to.
const QUARTER_MONTHS = [
  ['January', 'February', 'March'],
  ['April', 'May', 'June'],
  ['July', 'August', 'September'],
  ['October', 'November', 'December']
];
function periodLabel(year, quarter) {
  const months = QUARTER_MONTHS[quarter - 1] || QUARTER_MONTHS[0];
  const range = `${months[0]} – ${months[2]} ${year}`;
  return { range, quarterLabel: `Q${quarter} ${year} (${months[0]} – ${months[2]})` };
}

const TXN_INCLUDE_FOR_REPORTS = [
  { model: Borrower, as: 'borrower' },
  {
    model: TransactionDetail,
    as: 'details',
    include: [{ model: Item, as: 'item', include: [{ model: Equipment, as: 'equipment', include: [{ model: Category, as: 'category' }] }] }]
  }
];

function txnCode(t) {
  return `TXN-${new Date(t.requestDatetime || t.createdAt).getFullYear()}-${String(t.id).padStart(4, '0')}`;
}

// Statuses a transaction only ever reaches once the Director has actually
// approved it (transactionStatus is set to 'Approved' in exactly one place,
// borrow.controller.js#approve) or moved on from there. Medium #7 from the
// 2026-09-08 system audit: the Borrowing Report's "Approved Requests" stat
// used to be `transactionStatus !== 'Pending'`, which also counted
// Acknowledged/For Review/For Approval (not actually approved yet) and,
// worse, Rejected and Cancelled (explicitly *not* approved) — inflating the
// real approved count with everything that was ever submitted.
const POST_APPROVAL_STATUSES = new Set([
  'Approved',
  'Released',
  'Returned',
  'Overdue',
  'For Resolution',
  'Replacement',
  'Resolved',
  'Completed'
]);

exports.borrowing = async (req, res) => {
  const { start, end, year, quarter } = quarterRange(req);
  const txns = await Transaction.findAll({
    where: { requestDatetime: { [Op.gte]: start, [Op.lt]: end } },
    include: TXN_INCLUDE_FOR_REPORTS,
    order: [['requestDatetime', 'ASC']]
  });

  const data = [];
  txns.forEach((t) => {
    const byEquipment = new Map();
    (t.details || []).forEach((d) => {
      const name = d.item && d.item.equipment ? d.item.equipment.equipmentName : 'Unknown';
      byEquipment.set(name, (byEquipment.get(name) || 0) + 1);
    });
    const borrowerName = t.borrower ? `${t.borrower.firstName} ${t.borrower.lastName}` : 'Unknown Borrower';
    byEquipment.forEach((qty, name) => {
      data.push([txnCode(t), borrowerName, name, String(qty), fmtDate(t.requestDatetime), fmtDate(t.expectedReturnDatetime), t.transactionStatus]);
    });
  });

  const approved = txns.filter((t) => POST_APPROVAL_STATUSES.has(t.transactionStatus)).length;
  const completed = txns.filter((t) => ['Returned', 'Completed'].includes(t.transactionStatus)).length;

  const reportData = {
    title: 'BORROWING REPORT',
    period: periodLabel(year, quarter),
    heads: ['Transaction No.', 'Borrower', 'Equipment', 'Qty', 'Borrow Date', 'Expected Return', 'Status'],
    data,
    stats: [
      ['Total Borrowing Requests', String(txns.length)],
      ['Approved Requests', String(approved)],
      ['Completed Transactions', String(completed)]
    ]
  };

  if (renderFormat(req, res, borrowingReportTemplate, reportData)) return;
  res.json({ success: true, data: reportData });
};

exports.overdue = async (req, res) => {
  const { start, end, year, quarter } = quarterRange(req);
  const now = new Date();
  const txns = await Transaction.findAll({
    where: {
      requestDatetime: { [Op.gte]: start, [Op.lt]: end },
      [Op.or]: [
        { transactionStatus: 'Overdue' },
        { transactionStatus: 'Released', expectedReturnDatetime: { [Op.lt]: now } }
      ]
    },
    include: TXN_INCLUDE_FOR_REPORTS,
    order: [['expectedReturnDatetime', 'ASC']]
  });

  const data = [];
  txns.forEach((t) => {
    const borrowerName = t.borrower ? `${t.borrower.firstName} ${t.borrower.lastName}` : 'Unknown Borrower';
    const byEquipment = new Map();
    (t.details || []).forEach((d) => {
      const name = d.item && d.item.equipment ? d.item.equipment.equipmentName : 'Unknown';
      byEquipment.set(name, (byEquipment.get(name) || 0) + 1);
    });
    const daysOverdue = t.expectedReturnDatetime ? Math.max(Math.floor((now - new Date(t.expectedReturnDatetime)) / 86400000), 0) : 0;
    byEquipment.forEach((qty, name) => {
      data.push([borrowerName, name, String(qty), fmtDate(t.expectedReturnDatetime), String(daysOverdue)]);
    });
  });

  const restrictedBorrowers = await User.count({ where: { accountStatus: 'Restricted' } });

  const reportData = {
    title: 'OVERDUE REPORT',
    period: periodLabel(year, quarter),
    heads: ['Borrower', 'Equipment', 'Qty', 'Due Date', 'Days Overdue'],
    data,
    stats: [
      ['Total Overdue Transactions', String(txns.length)],
      ['Restricted Borrowers', String(restrictedBorrowers)]
    ]
  };

  if (renderFormat(req, res, overdueReportTemplate, reportData)) return;
  res.json({ success: true, data: reportData });
};

exports.utilization = async (req, res) => {
  const { start, end, year, quarter } = quarterRange(req);
  const [equipment, details] = await Promise.all([
    Equipment.findAll({ include: [{ model: Category, as: 'category' }] }),
    TransactionDetail.findAll({
      include: [
        { model: Transaction, as: 'transaction', attributes: ['requestDatetime'], where: { requestDatetime: { [Op.gte]: start, [Op.lt]: end } } },
        { model: Item, as: 'item', attributes: ['equipmentId'] }
      ]
    })
  ]);

  const countByEquipment = new Map();
  details.forEach((d) => {
    const id = d.item ? d.item.equipmentId : null;
    if (id == null) return;
    countByEquipment.set(id, (countByEquipment.get(id) || 0) + 1);
  });

  const data = equipment.map((e) => [
    e.equipmentName,
    e.category ? e.category.categoryName : '—',
    String(countByEquipment.get(e.id) || 0),
    String(e.availableQuantity)
  ]);

  const reportData = {
    title: 'EQUIPMENT UTILIZATION REPORT',
    period: periodLabel(year, quarter),
    heads: ['Equipment', 'Category', 'Times Borrowed', 'Available Quantity'],
    data,
    stats: [
      ['Total Equipment', String(equipment.length)],
      ['Total Borrowing Transactions', String(details.length)]
    ]
  };

  if (renderFormat(req, res, utilizationReportTemplate, reportData)) return;
  res.json({ success: true, data: reportData });
};

exports.history = async (req, res) => {
  const { start, end, year, quarter } = quarterRange(req);
  const txns = await Transaction.findAll({
    where: { requestDatetime: { [Op.gte]: start, [Op.lt]: end } },
    include: TXN_INCLUDE_FOR_REPORTS,
    order: [['requestDatetime', 'ASC']]
  });

  const data = [];
  txns.forEach((t) => {
    const borrowerName = t.borrower ? `${t.borrower.firstName} ${t.borrower.lastName}` : 'Unknown Borrower';
    const byEquipment = new Map();
    (t.details || []).forEach((d) => {
      const name = d.item && d.item.equipment ? d.item.equipment.equipmentName : 'Unknown';
      byEquipment.set(name, (byEquipment.get(name) || 0) + 1);
    });
    byEquipment.forEach((qty, name) => {
      data.push([fmtDate(t.requestDatetime), txnCode(t), borrowerName, `${name} (${qty})`, 'Borrowed', t.transactionStatus]);
      if (t.returnDatetime && new Date(t.returnDatetime) >= start && new Date(t.returnDatetime) < end) {
        data.push([fmtDate(t.returnDatetime), txnCode(t), borrowerName, `${name} (${qty})`, 'Returned', t.transactionStatus]);
      }
    });
  });

  const reportData = {
    title: 'TRANSACTION HISTORY REPORT',
    period: periodLabel(year, quarter),
    heads: ['Date', 'Transaction No.', 'Borrower', 'Equipment', 'Action', 'Status'],
    data,
    stats: [['Total Transactions', String(txns.length)]]
  };

  if (renderFormat(req, res, transactionHistoryTemplate, reportData)) return;
  res.json({ success: true, data: reportData });
};

exports.inventory = async (req, res) => {
  const equipment = await Equipment.findAll({
    include: [
      { model: Category, as: 'category' },
      { model: Item, as: 'items' }
    ],
    order: [['equipmentName', 'ASC']]
  });

  let missingItems = 0;
  const data = equipment.map((e) => {
    const items = e.items || [];
    const registered = items.length;
    // Medium #8 from the 2026-09-08 system audit: `registered -
    // availableQuantity` still over-counts "Borrowed" — a registered item
    // that's Reserved (a pending, not-yet-released request), Damaged, Under
    // Repair, Lost, or Decommissioned also isn't in availableQuantity, but
    // none of those are actually borrowed either. Each Item already carries
    // its own ground-truth availabilityStatus (set exclusively by the
    // release/return workflow — see qr.controller.js's manual-status guard,
    // which explicitly blocks hand-editing a Borrowed or Reserved item), so
    // count that directly instead of deriving it arithmetically.
    const borrowed = items.filter((i) => i.availabilityStatus === 'Borrowed').length;
    if (registered === 0 && e.totalQuantity > 0) missingItems += 1;
    return [
      e.equipmentName,
      e.category ? e.category.categoryName : '—',
      String(e.totalQuantity),
      String(e.availableQuantity),
      String(borrowed),
      String(registered)
    ];
  });

  const totalUnits = equipment.reduce((n, e) => n + e.totalQuantity, 0);
  const totalAvailable = equipment.reduce((n, e) => n + e.availableQuantity, 0);

  const reportData = {
    title: 'EQUIPMENT INVENTORY REPORT',
    heads: ['Equipment', 'Category', 'Total Qty', 'Available', 'Borrowed', 'Items Registered (QR)'],
    data,
    stats: [
      ['Total Equipment Types', String(equipment.length)],
      ['Total Units', String(totalUnits)],
      ['Total Units Available', String(totalAvailable)],
      ['Equipment Missing QR/Items', String(missingItems)]
    ]
  };

  // No dedicated per-report template file was scaffolded for inventory (only
  // 5 of the 7 report types had one); its shape is identical to the other
  // table reports so it uses the shared renderer directly.
  const format = req.query.format;
  if (format === 'pdf') return sendPdf(res, reportData, 'equipment-inventory-report');
  if (format === 'excel') {
    return sendExcel(res, reportData, 'equipment-inventory-report').catch((err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: err.message });
      } else {
        console.error('report.controller: excel export failed after headers sent:', err);
        res.end();
      }
    });
  }
  res.json({ success: true, data: reportData });
};

exports.condition = async (req, res) => {
  const equipment = await Equipment.findAll({
    include: [
      { model: Category, as: 'category' },
      { model: Item, as: 'items' }
    ]
  });

  let goodUnits = 0;
  let damagedUnits = 0;
  let lostUnits = 0;

  const data = equipment.map((e) => {
    const items = e.items || [];
    const counts = { Good: 0, Damaged: 0, 'Under Repair': 0, Lost: 0 };
    items.forEach((i) => { counts[i.itemCondition] = (counts[i.itemCondition] || 0) + 1; });
    goodUnits += counts.Good;
    damagedUnits += counts.Damaged;
    lostUnits += counts.Lost;

    const worst = counts.Lost ? 'Lost' : counts.Damaged ? 'Damaged' : counts['Under Repair'] ? 'Under Repair' : 'Good';
    const remarks =
      worst === 'Good'
        ? 'All units serviceable'
        : `${counts[worst]} unit${counts[worst] === 1 ? '' : 's'} ${worst.toLowerCase()}`;

    return [e.equipmentName, e.category ? e.category.categoryName : '—', String(items.length), worst, remarks];
  });

  const reportData = {
    title: 'EQUIPMENT CONDITION REPORT',
    heads: ['Equipment', 'Category', 'Quantity', 'Condition', 'Remarks'],
    data,
    stats: [
      ['Good Units', String(goodUnits)],
      ['Damaged Units', String(damagedUnits)],
      ['Lost Units', String(lostUnits)]
    ]
  };

  if (renderFormat(req, res, equipmentConditionTemplate, reportData)) return;
  res.json({ success: true, data: reportData });
};

// Groups every transaction requested during the given month by the day of
// month it was requested on, for the Transaction Log Report calendar.
//
// Same Medium #6 timezone issue as quarterRange() above applies to the
// month *boundary* here, so it gets the same PHT-pinned fix. Note this
// doesn't touch the day-bucketing below (`new Date(t.requestDatetime).
// getDate()`), which still reads the day-of-month in the server process's
// local timezone — a transaction made very late/early in the day PHT could
// still land in the neighboring calendar cell if the server itself doesn't
// run in PHT. That's a display-grouping nuance distinct from this range
// possibly excluding/including the wrong transactions entirely, and is
// left as-is here.
exports.transactionLog = async (req, res) => {
  const phtNow = nowInPht();
  const year = parseInt(req.query.year, 10) || phtNow.getUTCFullYear();
  const month = parseInt(req.query.month, 10) || phtNow.getUTCMonth() + 1; // 1-12

  const start = startOfPhtDate(year, month - 1, 1);
  const end = startOfPhtDate(year, month, 1); // exclusive

  const rows = await Transaction.findAll({
    where: { requestDatetime: { [Op.gte]: start, [Op.lt]: end } },
    include: INCLUDE,
    order: [['requestDatetime', 'ASC']]
  });

  const byDay = {};
  rows.forEach((t) => {
    const day = new Date(t.requestDatetime).getDate();
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(serialize(t));
  });

  const format = req.query.format;
  if (format === 'pdf' || format === 'excel') {
    // The calendar-by-day shape returned for the default JSON view doesn't
    // translate to a table, so flatten it into the same
    // { title, heads, data, stats } shape the other reports use.
    // Deriving this from `month` directly rather than formatting `start` —
    // `start` is now a UTC instant pinned to PHT midnight (see above), so
    // rendering it with toLocaleDateString() would use the server
    // process's own local timezone and could show the wrong month on a
    // UTC-configured server (that instant falls on the *previous* day in
    // UTC for every month).
    const monthName = new Date(2000, month - 1, 1).toLocaleDateString('en-US', { month: 'long' });
    const heads = ['Day', 'Transaction No.', 'Time', 'Borrower', 'College/Unit', 'Status'];
    const data = [];
    Object.keys(byDay)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((day) => {
        byDay[day].forEach((t) => {
          data.push([String(day), t.id, t.time, t.name, t.college, t.status]);
        });
      });
    const reportData = {
      title: `TRANSACTION LOG REPORT - ${monthName} ${year}`,
      heads,
      data,
      stats: [['Total Transactions', String(rows.length)]]
    };

    // No dedicated per-report template file was scaffolded for the
    // transaction log either; it uses the shared renderer directly.
    if (format === 'pdf') return sendPdf(res, reportData, 'transaction-log-report');
    return sendExcel(res, reportData, 'transaction-log-report').catch((err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: err.message });
      } else {
        console.error('report.controller: excel export failed after headers sent:', err);
        res.end();
      }
    });
  }

  res.json({ success: true, data: { year, month, byDay } });
};
