'use strict';

const { Op } = require('sequelize');
const { Equipment, Category, Item, Transaction, TransactionDetail, Borrower, User } = require('../models');
const { DAY_MS, startOfPhtDay, phtDayKey, phtWeekdayShort, formatDate } = require('../helpers/dateHelper');
const { termFromQuery, academicYearOptions } = require('../helpers/academicTerm');
const { STATUS, AWAITING_REVIEW, POST_APPROVAL, OPEN_REQUEST, OUT_WITH_BORROWER } = require('../constants/transactionStatus');

// Every figure here is computed from the database on each request — no
// cached or hardcoded statistic. Two kinds of numbers are returned:
//   - inventory figures (stock, borrowed, overdue) are "right now" and
//     don't depend on the semester;
//   - activity figures (requests, approvals, returns, trend) are limited to
//     the selected academic year + semester (helpers/academicTerm.js),
//     bounded in Philippine Time.

// Rounds up to a multiple of 4 so the chart's four y-axis intervals are
// always whole numbers (e.g. 8 -> 0/2/4/6/8, never 0/1.25/2.5/...).
function niceMax(value) {
  if (value <= 0) return 4;
  const unit = value <= 8 ? 1 : value <= 20 ? 2 : value <= 50 ? 5 : value <= 100 ? 10 : Math.ceil(value / 40 / 10) * 10;
  return Math.ceil(value / (4 * unit)) * 4 * unit;
}

// Whole-number percentages that always add up to exactly 100 (largest-
// remainder method). Rounding each share on its own can total 99 or 101,
// which left a gap or overlap in the category pie.
function percentsSummingTo100(quantities) {
  const total = quantities.reduce((n, q) => n + q, 0);
  if (total <= 0) return quantities.map(() => 0);
  const exact = quantities.map((q) => (q / total) * 100);
  const floors = exact.map(Math.floor);
  let remaining = 100 - floors.reduce((n, f) => n + f, 0);
  exact
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (remaining > 0) {
        floors[i] += 1;
        remaining -= 1;
      }
    });
  return floors;
}

function termPayload(term) {
  return {
    academicYearStart: term.academicYearStart,
    academicYear: term.academicYear,
    semester: term.semester,
    semesterLabel: term.semesterLabel,
    start: term.start,
    end: term.end,
    rangeLabel: `${formatDate(term.start)} – ${formatDate(new Date(term.end.getTime() - 1))}`
  };
}

async function availableAcademicYears() {
  const earliest = await Transaction.min('requestDatetime');
  return academicYearOptions(earliest);
}

function inTerm(value, term) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return t >= term.start.getTime() && t < term.end.getTime();
}

function unitCount(txn) {
  return (txn.details || []).length;
}

// Equipment stock, counted from each unit's own status.
function inventoryFigures(equipment) {
  let totalEquipment = 0;
  let availableEquipment = 0;
  let borrowedEquipment = 0;
  let reservedEquipment = 0;
  equipment.forEach((e) => {
    totalEquipment += e.totalQuantity;
    (e.items || []).forEach((i) => {
      if (i.availabilityStatus === 'Available') availableEquipment += 1;
      else if (i.availabilityStatus === 'Borrowed') borrowedEquipment += 1;
      else if (i.availabilityStatus === 'Reserved') reservedEquipment += 1;
    });
  });
  return {
    equipmentTypes: equipment.length,
    totalEquipment,
    availableEquipment,
    borrowedEquipment,
    reservedEquipment,
    availablePercent: totalEquipment > 0 ? Math.round((availableEquipment / totalEquipment) * 100) : 0,
    categories: new Set(equipment.map((e) => e.categoryId)).size
  };
}

// Released/returned unit counts for each of the last 7 PHT days of the
// selected term (ending today if the term is current).
async function usageTrend(term, where = {}) {
  const lastInstant = new Date(Math.min(Date.now(), term.end.getTime() - 1));
  const lastDayStart = startOfPhtDay(lastInstant);
  const days = [];
  for (let i = 6; i >= 0; i -= 1) days.push(new Date(lastDayStart.getTime() - i * DAY_MS));
  const windowStart = days[0];
  const windowEnd = new Date(lastDayStart.getTime() + DAY_MS);

  const rows = await Transaction.findAll({
    where: {
      ...where,
      [Op.or]: [
        { releaseDatetime: { [Op.gte]: windowStart, [Op.lt]: windowEnd } },
        { returnDatetime: { [Op.gte]: windowStart, [Op.lt]: windowEnd } }
      ]
    },
    include: [{ model: TransactionDetail, as: 'details', attributes: ['id'] }]
  });

  const keys = days.map(phtDayKey);
  const borrowed = keys.map(() => 0);
  const returned = keys.map(() => 0);
  rows.forEach((t) => {
    if (t.releaseDatetime) {
      const idx = keys.indexOf(phtDayKey(t.releaseDatetime));
      if (idx >= 0) borrowed[idx] += unitCount(t);
    }
    if (t.returnDatetime) {
      const idx = keys.indexOf(phtDayKey(t.returnDatetime));
      if (idx >= 0) returned[idx] += unitCount(t);
    }
  });
  return {
    labels: days.map(phtWeekdayShort),
    dates: days.map((d) => formatDate(d)),
    borrowed,
    returned,
    max: niceMax(Math.max(...borrowed, ...returned, 1))
  };
}

// Request-outcome counts for transactions requested within the term.
function requestFigures(termTxns, term) {
  const count = (statuses) => termTxns.filter((t) => statuses.includes(t.transactionStatus)).length;
  const returnedTxns = termTxns.filter((t) => inTerm(t.returnDatetime, term));
  return {
    totalTransactions: termTxns.length,
    pendingRequests: count(OPEN_REQUEST),
    awaitingReview: count(AWAITING_REVIEW),
    awaitingApproval: count([STATUS.FOR_APPROVAL]),
    approvedRequests: count(POST_APPROVAL),
    rejectedRequests: count([STATUS.REJECTED]),
    cancelledRequests: count([STATUS.CANCELLED]),
    completedTransactions: count([STATUS.COMPLETED]),
    returnedEquipment: returnedTxns.reduce((n, t) => n + unitCount(t), 0)
  };
}

function overdueCount(txns, now = new Date()) {
  return txns.filter(
    (t) =>
      t.transactionStatus === STATUS.OVERDUE ||
      (t.transactionStatus === STATUS.RELEASED && t.expectedReturnDatetime && new Date(t.expectedReturnDatetime) < now)
  ).length;
}

exports.summary = async (req, res) => {
  const term = termFromQuery(req.query);
  const [equipment, termTxns, outTxns, totalBorrowers, flaggedBorrowers, academicYears] = await Promise.all([
    Equipment.findAll({
      include: [
        { model: Category, as: 'category' },
        { model: Item, as: 'items', attributes: ['id', 'availabilityStatus'] }
      ]
    }),
    Transaction.findAll({
      where: { requestDatetime: { [Op.gte]: term.start, [Op.lt]: term.end } },
      include: [{ model: TransactionDetail, as: 'details', attributes: ['id'] }]
    }),
    Transaction.findAll({ where: { transactionStatus: OUT_WITH_BORROWER } }),
    Borrower.count(),
    User.count({ where: { userRole: 'Borrower', accountStatus: 'Restricted' } }),
    availableAcademicYears()
  ]);

  const inventory = inventoryFigures(equipment);
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  // Category distribution — share of total units per category, top 5 + Other.
  // Categories with no units are left out (they would only add a 0% legend
  // row), and the percentages are adjusted to total exactly 100.
  const byCategory = new Map();
  equipment.forEach((e) => {
    const name = e.category ? e.category.categoryName : 'Uncategorized';
    byCategory.set(name, (byCategory.get(name) || 0) + (e.totalQuantity || 0));
  });
  const sortedCategories = Array.from(byCategory.entries())
    .filter(([, qty]) => qty > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = sortedCategories.slice(0, 5);
  const restTotal = sortedCategories.slice(5).reduce((n, [, qty]) => n + qty, 0);
  if (restTotal > 0) top.push(['Other', restTotal]);
  const categoryPercents = percentsSummingTo100(top.map(([, qty]) => qty));

  res.json({
    success: true,
    data: {
      term: termPayload(term),
      academicYears,
      ...inventory,
      recentlyAdded: equipment.filter((e) => e.createdAt && new Date(e.createdAt) >= thirtyDaysAgo).length,
      overdueCount: overdueCount(outTxns),
      ...requestFigures(termTxns, term),
      totalBorrowers,
      activeBorrowers: new Set(termTxns.map((t) => t.borrowerId)).size,
      flaggedBorrowers,
      usageTrend: await usageTrend(term),
      categoryDistribution: top.map(([categoryName, qty], i) => ({
        categoryName,
        quantity: qty,
        percent: categoryPercents[i]
      }))
    }
  });
};

// Borrower dashboard: the signed-in borrower's own activity for the
// selected term, plus current catalog availability. Scoped by the token's
// user — a borrower can never see anyone else's figures.
exports.mine = async (req, res) => {
  const term = termFromQuery(req.query);
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  const [equipment, academicYears] = await Promise.all([
    Equipment.findAll({ include: [{ model: Item, as: 'items', attributes: ['id', 'availabilityStatus'] }] }),
    availableAcademicYears()
  ]);
  const inventory = inventoryFigures(equipment);

  let mine = {
    ...requestFigures([], term),
    activeBorrowings: 0,
    borrowedUnits: 0,
    overdueCount: 0
  };
  if (borrower) {
    const [termTxns, outTxns] = await Promise.all([
      Transaction.findAll({
        where: { borrowerId: borrower.id, requestDatetime: { [Op.gte]: term.start, [Op.lt]: term.end } },
        include: [{ model: TransactionDetail, as: 'details', attributes: ['id'] }]
      }),
      Transaction.findAll({
        where: { borrowerId: borrower.id, transactionStatus: OUT_WITH_BORROWER },
        include: [{ model: TransactionDetail, as: 'details', attributes: ['id'] }]
      })
    ]);
    mine = {
      ...requestFigures(termTxns, term),
      activeBorrowings: outTxns.length,
      borrowedUnits: outTxns.reduce((n, t) => n + unitCount(t), 0),
      overdueCount: overdueCount(outTxns)
    };
  }

  res.json({
    success: true,
    data: {
      term: termPayload(term),
      academicYears,
      catalog: {
        equipmentTypes: inventory.equipmentTypes,
        totalEquipment: inventory.totalEquipment,
        availableEquipment: inventory.availableEquipment,
        categories: inventory.categories
      },
      mine
    }
  });
};
