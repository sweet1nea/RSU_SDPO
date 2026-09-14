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
  Transaction: { findAll: jest.fn() }
}));

const { Equipment, Transaction } = require('../../models');
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
});

describe('GET /api/dashboard/summary — equipment stats', () => {
  test('sums totalQuantity/availableQuantity across all equipment, and computes availablePercent', async () => {
    Equipment.findAll.mockResolvedValue([
      makeEquipment({ totalQuantity: 10, availableQuantity: 5 }),
      makeEquipment({ totalQuantity: 10, availableQuantity: 5 })
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
  test('counts only Released transactions whose expected return date has passed', async () => {
    Equipment.findAll.mockResolvedValue([]);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    Transaction.findAll.mockResolvedValue([
      { transactionStatus: 'Released', expectedReturnDatetime: past }, // overdue
      { transactionStatus: 'Released', expectedReturnDatetime: future }, // not yet due
      { transactionStatus: 'Overdue', expectedReturnDatetime: past }, // already flipped by the sweep, not "Released" anymore
      { transactionStatus: 'Completed', expectedReturnDatetime: past }
    ]);

    const res = mockRes();
    await ctrl.summary({ query: {} }, res);

    expect(res.json.mock.calls[0][0].data.overdueCount).toBe(1);
  });
});

describe('GET /api/dashboard/summary — usage trend', () => {
  test('buckets releaseDatetime/returnDatetime into 7 daily labels, most recent last', async () => {
    Equipment.findAll.mockResolvedValue([]);
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    Transaction.findAll.mockResolvedValue([
      { releaseDatetime: today, returnDatetime: null },
      { releaseDatetime: today, returnDatetime: null },
      { releaseDatetime: null, returnDatetime: today }
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
