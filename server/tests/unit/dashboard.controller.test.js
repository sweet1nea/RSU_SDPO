'use strict';

// Verifies server/controllers/dashboard.controller.js#summary — previously
// zero test coverage (High #3, 2026-09-08 system audit).
//
// Also covers a fix made alongside adding this coverage: `borrowedEquipment`
// was computed as `totalQuantity - availableQuantity`, the same bug as the
// Equipment Inventory Report's "Borrowed" column (Medium #8, already fixed
// in report.controller.js#inventory) — it over-counts Reserved/Damaged/
// Under-Repair/Decommissioned items as "Borrowed" too. Now counts each
// item's own availabilityStatus directly.

jest.mock('../../models', () => ({
  Equipment: { findAll: jest.fn() },
  Category: {},
  Item: {},
  TransactionDetail: {},
  Transaction: { findAll: jest.fn(), min: jest.fn() },
  Borrower: { count: jest.fn(), findOne: jest.fn() },
  User: { count: jest.fn() }
}));

const { Equipment, Transaction, Borrower, User } = require('../../models');
const ctrl = require('../../controllers/dashboard.controller');

function mockRes() {
  return { json: jest.fn() };
}

function makeEquipment(overrides = {}) {
  return Object.assign(
    {
      id: 1,
      equipmentName: 'Basketball',
      totalQuantity: 10,
      availableQuantity: 8,
      createdAt: new Date('2020-01-01'),
      category: { categoryName: 'Ball Sports' },
      items: []
    },
    overrides
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  Transaction.min.mockResolvedValue(null);
  Borrower.count.mockResolvedValue(0);
  User.count.mockResolvedValue(0);
});

describe('GET /api/dashboard/summary — equipment stats', () => {
  // "Available" is counted from each unit's own status (same source as
  // "Borrowed"), so the two figures can never disagree with the units.
  test('sums totalQuantity and Available units across all equipment, and computes availablePercent', async () => {
    Equipment.findAll.mockResolvedValue([
      makeEquipment({ totalQuantity: 10, availableQuantity: 5, items: [...Array.from({ length: 5 }, () => ({ availabilityStatus: 'Available' })), ...Array.from({ length: 5 }, () => ({ availabilityStatus: 'Borrowed' }))] }),
      makeEquipment({ totalQuantity: 10, availableQuantity: 5, items: Array.from({ length: 5 }, () => ({ availabilityStatus: 'Available' })) })
    ]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.totalEquipment).toBe(20);
    expect(payload.availableEquipment).toBe(10);
    expect(payload.availablePercent).toBe(50);
  });

  test('availablePercent is 0, not NaN/Infinity, when there is no equipment at all', async () => {
    Equipment.findAll.mockResolvedValue([]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    expect(res.json.mock.calls[0][0].data.availablePercent).toBe(0);
    expect(res.json.mock.calls[0][0].data.totalEquipment).toBe(0);
  });

  test('borrowedEquipment counts each item\'s own availabilityStatus === "Borrowed", not totalQuantity - availableQuantity', async () => {
    // 5 registered items: 1 Borrowed, 2 Reserved, 2 Available.
    // availableQuantity intentionally set to only 2 (matching the 2 truly
    // Available items) — the old formula would have reported 8 "borrowed"
    // (10 - 2), when really only 1 item is actually out on loan.
    const equipment = makeEquipment({
      totalQuantity: 10,
      availableQuantity: 2,
      items: [
        { availabilityStatus: 'Borrowed' },
        { availabilityStatus: 'Reserved' },
        { availabilityStatus: 'Reserved' },
        { availabilityStatus: 'Available' },
        { availabilityStatus: 'Available' }
      ]
    });
    Equipment.findAll.mockResolvedValue([equipment]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    expect(res.json.mock.calls[0][0].data.borrowedEquipment).toBe(1);
  });

  test('recentlyAdded counts only equipment created within the last 30 days', async () => {
    const old = makeEquipment({ id: 1, createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) });
    const recent = makeEquipment({ id: 2, createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) });
    Equipment.findAll.mockResolvedValue([old, recent]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    expect(res.json.mock.calls[0][0].data.recentlyAdded).toBe(1);
  });
});

describe('GET /api/dashboard/summary — overdueCount', () => {
  // Transactions the hourly sweep has already flipped to 'Overdue' are
  // still overdue — they used to drop out of this count entirely.
  test('counts Overdue transactions plus Released ones whose expected return date has passed', async () => {
    Equipment.findAll.mockResolvedValue([]);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    Transaction.findAll.mockResolvedValue([
      { transactionStatus: 'Released', expectedReturnDatetime: past }, // overdue
      { transactionStatus: 'Released', expectedReturnDatetime: future }, // not yet due
      { transactionStatus: 'Overdue', expectedReturnDatetime: past }, // flipped by the sweep — still overdue
      { transactionStatus: 'Completed', expectedReturnDatetime: past }
    ]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    expect(res.json.mock.calls[0][0].data.overdueCount).toBe(2);
  });
});

describe('GET /api/dashboard/summary — usage trend', () => {
  // Counts units (transaction details), bucketed by Philippine calendar day.
  test('buckets released/returned units into 7 PHT daily labels, most recent last', async () => {
    Equipment.findAll.mockResolvedValue([]);
    const now = new Date();
    Transaction.findAll.mockResolvedValue([
      { releaseDatetime: now, returnDatetime: null, details: [{ id: 1 }] },
      { releaseDatetime: now, returnDatetime: null, details: [{ id: 2 }] },
      { releaseDatetime: null, returnDatetime: now, details: [{ id: 3 }] }
    ]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    const trend = res.json.mock.calls[0][0].data.usageTrend;
    expect(trend.labels).toHaveLength(7);
    expect(trend.borrowed).toHaveLength(7);
    expect(trend.returned).toHaveLength(7);
    expect(trend.borrowed[6]).toBe(2); // today is the last bucket
    expect(trend.returned[6]).toBe(1);
    expect(trend.borrowed.slice(0, 6).every((n) => n === 0)).toBe(true);
  });

  test('max is at least 1 even with zero activity, so the chart never divides by zero', async () => {
    Equipment.findAll.mockResolvedValue([]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    expect(res.json.mock.calls[0][0].data.usageTrend.max).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/dashboard/summary — category distribution', () => {
  test('groups equipment quantity by category name and computes percent of total', async () => {
    Equipment.findAll.mockResolvedValue([
      makeEquipment({ totalQuantity: 30, category: { categoryName: 'Ball Sports' } }),
      makeEquipment({ totalQuantity: 10, category: { categoryName: 'Track & Field' } }),
      makeEquipment({ totalQuantity: 10, category: null }) // Uncategorized
    ]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    const dist = res.json.mock.calls[0][0].data.categoryDistribution;
    const ball = dist.find((d) => d.categoryName === 'Ball Sports');
    expect(ball.quantity).toBe(30);
    expect(ball.percent).toBe(60); // 30 of 50 total units
    expect(dist.find((d) => d.categoryName === 'Uncategorized').quantity).toBe(10);
  });

  test('collapses categories beyond the top 5 into a single "Other" bucket', async () => {
    const equipment = [];
    for (let i = 1; i <= 7; i++) {
      // Descending quantities so the ranking is deterministic: category 1
      // has the most units, category 7 the fewest.
      equipment.push(makeEquipment({ totalQuantity: (8 - i) * 10, category: { categoryName: `Category ${i}` } }));
    }
    Equipment.findAll.mockResolvedValue(equipment);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    const dist = res.json.mock.calls[0][0].data.categoryDistribution;
    expect(dist).toHaveLength(6); // top 5 + Other
    expect(dist[5].categoryName).toBe('Other');
    // Other = categories 6 and 7 = 20 + 10 = 30 units.
    expect(dist[5].quantity).toBe(30);
  });

  test('omits the "Other" bucket entirely when there are 5 or fewer categories', async () => {
    Equipment.findAll.mockResolvedValue([
      makeEquipment({ category: { categoryName: 'A' } }),
      makeEquipment({ category: { categoryName: 'B' } })
    ]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    const dist = res.json.mock.calls[0][0].data.categoryDistribution;
    expect(dist.find((d) => d.categoryName === 'Other')).toBeUndefined();
  });
});

describe('GET /api/dashboard/summary — chart fixes', () => {
  test('category percentages always add up to exactly 100', async () => {
    // 1/3 each rounds to 33+33+33 = 99 if rounded independently.
    Equipment.findAll.mockResolvedValue([
      makeEquipment({ totalQuantity: 10, category: { categoryName: 'A' } }),
      makeEquipment({ totalQuantity: 10, category: { categoryName: 'B' } }),
      makeEquipment({ totalQuantity: 10, category: { categoryName: 'C' } })
    ]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    const dist = res.json.mock.calls[0][0].data.categoryDistribution;
    expect(dist.reduce((n, d) => n + d.percent, 0)).toBe(100);
  });

  test('categories with no units are left out of the distribution', async () => {
    Equipment.findAll.mockResolvedValue([
      makeEquipment({ totalQuantity: 12, category: { categoryName: 'Ball Sports' } }),
      makeEquipment({ totalQuantity: 0, category: { categoryName: 'Empty Category' } })
    ]);
    Transaction.findAll.mockResolvedValue([]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    const dist = res.json.mock.calls[0][0].data.categoryDistribution;
    expect(dist.map((d) => d.categoryName)).toEqual(['Ball Sports']);
    expect(dist[0].percent).toBe(100);
  });

  test('trend max is a multiple of 4 so every y-axis label is a whole number', async () => {
    Equipment.findAll.mockResolvedValue([]);
    const now = new Date();
    for (const units of [0, 1, 3, 7, 13, 30, 77]) {
      Transaction.findAll.mockResolvedValue([
        { releaseDatetime: now, returnDatetime: null, details: Array.from({ length: units }, (_, i) => ({ id: i })) }
      ]);
      const res = mockRes();
      await ctrl.summary({ query: {} }, res);
      const { max } = res.json.mock.calls[0][0].data.usageTrend;
      expect(max % 4).toBe(0);
      expect(max).toBeGreaterThanOrEqual(Math.max(units, 1));
    }
  });

  test('trend returns one full date label per day for the chart tooltips', async () => {
    Equipment.findAll.mockResolvedValue([]);
    Transaction.findAll.mockResolvedValue([]);
    const res = mockRes();
    await ctrl.summary({ query: {} }, res);
    expect(res.json.mock.calls[0][0].data.usageTrend.dates).toHaveLength(7);
  });
});

describe('GET /api/dashboard/summary — semester selection', () => {
  test('requests made in the selected semester are counted; the term is reported back', async () => {
    Equipment.findAll.mockResolvedValue([]);
    Transaction.findAll.mockResolvedValue([]);
    const res = mockRes();
    await ctrl.summary({ query: { academicYear: '2025', semester: '2' } }, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.term).toMatchObject({ academicYear: '2025-2026', semester: 2, semesterLabel: '2nd Semester' });
    // 2nd Semester 2025-2026 = Jan 1 – Jul 31 2026, bounded at 00:00 PHT.
    expect(data.term.start.toISOString()).toBe('2025-12-31T16:00:00.000Z');
    expect(data.term.end.toISOString()).toBe('2026-07-31T16:00:00.000Z');
    const termQuery = Transaction.findAll.mock.calls.find((c) => c[0].where && c[0].where.requestDatetime)[0];
    const { Op } = require('sequelize');
    expect(termQuery.where.requestDatetime[Op.gte].toISOString()).toBe('2025-12-31T16:00:00.000Z');
    expect(termQuery.where.requestDatetime[Op.lt].toISOString()).toBe('2026-07-31T16:00:00.000Z');
  });

  test('switching semesters changes the query window (1st Semester = Aug–Dec)', async () => {
    Equipment.findAll.mockResolvedValue([]);
    Transaction.findAll.mockResolvedValue([]);
    const res = mockRes();
    await ctrl.summary({ query: { academicYear: '2025', semester: '1' } }, res);
    const term = res.json.mock.calls[0][0].data.term;
    expect(term.start.toISOString()).toBe('2025-07-31T16:00:00.000Z');
    expect(term.end.toISOString()).toBe('2025-12-31T16:00:00.000Z');
  });

  test('request outcome counts come from the term\'s transactions', async () => {
    Equipment.findAll.mockResolvedValue([]);
    Transaction.findAll.mockImplementation(async (opts) =>
      opts.where && opts.where.requestDatetime
        ? [
            { borrowerId: 1, transactionStatus: 'Acknowledged', details: [] },
            { borrowerId: 1, transactionStatus: 'For Approval', details: [] },
            { borrowerId: 2, transactionStatus: 'Approved', details: [] },
            { borrowerId: 2, transactionStatus: 'Completed', returnDatetime: new Date('2026-02-01T00:00:00Z'), details: [{}, {}] },
            { borrowerId: 3, transactionStatus: 'Rejected', details: [] }
          ]
        : []
    );
    const res = mockRes();
    await ctrl.summary({ query: { academicYear: '2025', semester: '2' } }, res);
    const d = res.json.mock.calls[0][0].data;
    expect(d).toMatchObject({
      totalTransactions: 5,
      pendingRequests: 2,
      awaitingReview: 1,
      awaitingApproval: 1,
      approvedRequests: 2,
      rejectedRequests: 1,
      returnedEquipment: 2,
      activeBorrowers: 3
    });
  });
});

describe('GET /api/dashboard/me — borrower dashboard', () => {
  test('only counts the signed-in borrower\'s own transactions', async () => {
    Equipment.findAll.mockResolvedValue([]);
    Borrower.findOne.mockResolvedValue({ id: 44 });
    Transaction.findAll.mockResolvedValue([]);
    const res = mockRes();
    await ctrl.mine({ user: { id: 9 }, query: {} }, res);
    expect(Borrower.findOne).toHaveBeenCalledWith({ where: { userId: 9 } });
    Transaction.findAll.mock.calls.forEach(([opts]) => expect(opts.where.borrowerId).toBe(44));
    expect(res.json.mock.calls[0][0].data.mine).toMatchObject({ pendingRequests: 0, borrowedUnits: 0 });
  });
});
