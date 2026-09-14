'use strict';

// Unit tests for server/controllers/report.controller.js — the 7 endpoints
// behind /api/reports (transaction-log, borrowing, overdue, utilization,
// inventory, history, condition). All Sequelize models are mocked; nothing
// here touches a real database.

jest.mock('../../models', () => require('../fixtures/mockModels')());

const {
  Transaction,
  TransactionDetail,
  Equipment,
  User
} = require('../../models');
const ctrl = require('../../controllers/report.controller');
const {
  makeCategory,
  makeEquipment,
  makeItem,
  makeBorrower,
  makeTransactionDetail,
  makeTransaction
} = require('../fixtures/reportFixtures');

function mockRes() {
  return { json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/reports/borrowing', () => {
  test('returns a JSON payload shaped {title, heads, data, stats}, grouped and counted correctly', async () => {
    const basketball = makeEquipment({ equipmentName: 'Basketball' });
    const volleyball = makeEquipment({ equipmentName: 'Volleyball' });

    const txnApproved = makeTransaction({
      transactionStatus: 'Approved',
      borrower: makeBorrower({ firstName: 'Juan', lastName: 'Dela Cruz' }),
      details: [
        makeTransactionDetail({ item: makeItem({ equipment: basketball }) }),
        makeTransactionDetail({ item: makeItem({ equipment: basketball }) }), // same equipment -> qty 2
        makeTransactionDetail({ item: makeItem({ equipment: volleyball }) })
      ]
    });
    const txnPending = makeTransaction({
      transactionStatus: 'Pending',
      details: [makeTransactionDetail({ item: makeItem({ equipment: basketball }) })]
    });
    const txnReturned = makeTransaction({
      transactionStatus: 'Returned',
      details: [makeTransactionDetail({ item: makeItem({ equipment: volleyball }) })]
    });

    Transaction.findAll.mockResolvedValue([txnApproved, txnPending, txnReturned]);

    const req = { query: { quarter: '1', year: '2026' } };
    const res = mockRes();
    await ctrl.borrowing(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.title).toBe('BORROWING REPORT');
    expect(payload.data.heads).toEqual([
      'Transaction No.',
      'Borrower',
      'Equipment',
      'Qty',
      'Borrow Date',
      'Expected Return',
      'Status'
    ]);

    // Basketball row for txnApproved should be aggregated to qty 2, not two rows.
    const basketballRow = payload.data.data.find((r) => r[2] === 'Basketball' && r[1] === 'Juan Dela Cruz');
    expect(basketballRow).toBeDefined();
    expect(basketballRow[3]).toBe('2');

    // 3 transactions total, but 4 grouped rows (2 for txnApproved + 1 each for the other two).
    expect(payload.data.data).toHaveLength(4);

    // stats: total=3, approved = status !== 'Pending' -> 2 (Approved + Returned)
    // completed = status in [Returned, Completed] -> 1
    const stats = Object.fromEntries(payload.data.stats);
    expect(stats['Total Borrowing Requests']).toBe('3');
    expect(stats['Approved Requests']).toBe('2');
    expect(stats['Completed Transactions']).toBe('1');
  });

  test('queries Transaction.findAll with a quarter/year window derived from req.query', async () => {
    Transaction.findAll.mockResolvedValue([]);
    const req = { query: { quarter: '2', year: '2025' } };
    await ctrl.borrowing(req, mockRes());

    expect(Transaction.findAll).toHaveBeenCalledTimes(1);
    const { Op } = require('sequelize');
    const args = Transaction.findAll.mock.calls[0][0];
    const gte = args.where.requestDatetime[Op.gte];
    const lt = args.where.requestDatetime[Op.lt];
    // Medium #6: the boundary is pinned to PHT (UTC+8), not whatever
    // timezone the test/CI/production process happens to run in — so this
    // asserts the actual UTC instant (00:00 PHT on Apr 1 == 16:00 UTC on
    // Mar 31) via the UTC getters, rather than the local getters used
    // before the fix, which would silently pass or fail depending on the
    // machine's own TZ setting instead of proving the PHT math itself.
    // Q2 = April - June PHT, i.e. [2025-03-31T16:00:00Z, 2025-06-30T16:00:00Z)
    expect(gte.getUTCFullYear()).toBe(2025);
    expect(gte.getUTCMonth()).toBe(2); // March (0-indexed)
    expect(gte.getUTCDate()).toBe(31);
    expect(gte.getUTCHours()).toBe(16);
    expect(lt.getUTCFullYear()).toBe(2025);
    expect(lt.getUTCMonth()).toBe(5); // June (0-indexed)
    expect(lt.getUTCDate()).toBe(30);
    expect(lt.getUTCHours()).toBe(16);
  });
});

describe('GET /api/reports/overdue', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(new Date('2026-01-25T00:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('computes days overdue relative to "now" and reports restricted-borrower count', async () => {
    const txn = makeTransaction({
      transactionStatus: 'Overdue',
      expectedReturnDatetime: new Date('2026-01-20T00:00:00Z'), // 5 days before fake "now"
      borrower: makeBorrower({ firstName: 'Maria', lastName: 'Santos' }),
      details: [makeTransactionDetail({ item: makeItem({ equipment: makeEquipment({ equipmentName: 'Volleyball' }) }) })]
    });
    Transaction.findAll.mockResolvedValue([txn]);
    User.count.mockResolvedValue(2);

    const req = { query: { quarter: '1', year: '2026' } };
    const res = mockRes();
    await ctrl.overdue(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.title).toBe('OVERDUE REPORT');
    expect(payload.data.data).toHaveLength(1);
    const [borrowerName, equipmentName, qty, , daysOverdue] = payload.data.data[0];
    expect(borrowerName).toBe('Maria Santos');
    expect(equipmentName).toBe('Volleyball');
    expect(qty).toBe('1');
    expect(daysOverdue).toBe('5');

    const stats = Object.fromEntries(payload.data.stats);
    expect(stats['Total Overdue Transactions']).toBe('1');
    expect(stats['Restricted Borrowers']).toBe('2');
    expect(User.count).toHaveBeenCalledWith({ where: { accountStatus: 'Restricted' } });
  });

  test('query includes both explicit Overdue status and Released-but-past-due transactions', async () => {
    const { Op } = require('sequelize');
    Transaction.findAll.mockResolvedValue([]);
    User.count.mockResolvedValue(0);
    await ctrl.overdue({ query: { quarter: '1', year: '2026' } }, mockRes());

    const where = Transaction.findAll.mock.calls[0][0].where;
    const orClause = where[Op.or];
    expect(Array.isArray(orClause)).toBe(true);
    expect(orClause).toContainEqual({ transactionStatus: 'Overdue' });
    expect(orClause[1]).toMatchObject({ transactionStatus: 'Released' });
    expect(orClause[1].expectedReturnDatetime).toBeDefined();
  });
});

describe('GET /api/reports/utilization', () => {
  test('counts times-borrowed per equipment from TransactionDetail rows within the window', async () => {
    const basketball = makeEquipment({ equipmentName: 'Basketball', availableQuantity: 6 });
    const volleyball = makeEquipment({ equipmentName: 'Volleyball', availableQuantity: 3 });

    Equipment.findAll.mockResolvedValue([basketball, volleyball]);
    TransactionDetail.findAll.mockResolvedValue([
      { item: { equipmentId: basketball.id } },
      { item: { equipmentId: basketball.id } },
      { item: { equipmentId: volleyball.id } }
    ]);

    const req = { query: { quarter: '1', year: '2026' } };
    const res = mockRes();
    await ctrl.utilization(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.title).toBe('EQUIPMENT UTILIZATION REPORT');
    const basketballRow = payload.data.data.find((r) => r[0] === 'Basketball');
    const volleyballRow = payload.data.data.find((r) => r[0] === 'Volleyball');
    expect(basketballRow[2]).toBe('2'); // times borrowed
    expect(basketballRow[3]).toBe('6'); // available quantity
    expect(volleyballRow[2]).toBe('1');

    const stats = Object.fromEntries(payload.data.stats);
    expect(stats['Total Equipment']).toBe('2');
    expect(stats['Total Borrowing Transactions']).toBe('3');
  });

  test('a detail row whose item is missing (null) is skipped instead of crashing', async () => {
    Equipment.findAll.mockResolvedValue([]);
    TransactionDetail.findAll.mockResolvedValue([{ item: null }]);
    const res = mockRes();
    await expect(ctrl.utilization({ query: {} }, res)).resolves.not.toThrow();
    const stats = Object.fromEntries(res.json.mock.calls[0][0].data.stats);
    expect(stats['Total Borrowing Transactions']).toBe('1');
  });
});

describe('GET /api/reports/history', () => {
  test('emits a Borrowed row always, and a Returned row only when returnDatetime falls inside the window', async () => {
    const inWindow = makeTransaction({
      requestDatetime: new Date('2026-01-05T00:00:00Z'),
      returnDatetime: new Date('2026-01-10T00:00:00Z'),
      transactionStatus: 'Returned',
      details: [makeTransactionDetail({ item: makeItem({ equipment: makeEquipment({ equipmentName: 'Basketball' }) }) })]
    });
    const notReturnedYet = makeTransaction({
      requestDatetime: new Date('2026-01-06T00:00:00Z'),
      returnDatetime: null,
      transactionStatus: 'Released',
      details: [makeTransactionDetail({ item: makeItem({ equipment: makeEquipment({ equipmentName: 'Volleyball' }) }) })]
    });

    Transaction.findAll.mockResolvedValue([inWindow, notReturnedYet]);
    const req = { query: { quarter: '1', year: '2026' } };
    const res = mockRes();
    await ctrl.history(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.title).toBe('TRANSACTION HISTORY REPORT');
    const actions = payload.data.data.map((r) => r[4]);
    // inWindow -> Borrowed + Returned; notReturnedYet -> Borrowed only
    expect(actions.filter((a) => a === 'Borrowed')).toHaveLength(2);
    expect(actions.filter((a) => a === 'Returned')).toHaveLength(1);
  });
});

describe('GET /api/reports/inventory', () => {
  test('derives borrowed count from each item\'s own availabilityStatus, not arithmetic, and flags equipment missing QR-registered items', async () => {
    // Medium #8 from the 2026-09-08 system audit: `registered -
    // availableQuantity` over-counts "Borrowed" — a Reserved (pending, not
    // yet released) item also isn't in availableQuantity, but isn't
    // actually borrowed either. Only 1 of these 8 registered items is
    // really out on loan; the old arithmetic would have reported 3
    // (8 registered - 5 available).
    const fullyRegistered = makeEquipment({
      equipmentName: 'Basketball',
      totalQuantity: 10,
      availableQuantity: 5,
      items: [
        makeItem({ availabilityStatus: 'Borrowed' }),
        makeItem({ availabilityStatus: 'Reserved' }),
        makeItem({ availabilityStatus: 'Reserved' }),
        makeItem({ availabilityStatus: 'Available' }),
        makeItem({ availabilityStatus: 'Available' }),
        makeItem({ availabilityStatus: 'Available' }),
        makeItem({ availabilityStatus: 'Available' }),
        makeItem({ availabilityStatus: 'Available' })
      ]
    });
    const missingItems = makeEquipment({
      equipmentName: 'Cones',
      totalQuantity: 20,
      availableQuantity: 20,
      items: []
    });

    Equipment.findAll.mockResolvedValue([fullyRegistered, missingItems]);
    const res = mockRes();
    await ctrl.inventory({ query: {} }, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.title).toBe('EQUIPMENT INVENTORY REPORT');

    const basketballRow = payload.data.data.find((r) => r[0] === 'Basketball');
    // Only the one item whose availabilityStatus is actually 'Borrowed'
    // counts — Reserved items are excluded even though they're not in
    // availableQuantity either.
    expect(basketballRow[4]).toBe('1');
    expect(basketballRow[5]).toBe('8');

    const conesRow = payload.data.data.find((r) => r[0] === 'Cones');
    expect(conesRow[4]).toBe('0'); // no registered items at all
    expect(conesRow[5]).toBe('0');

    const stats = Object.fromEntries(payload.data.stats);
    expect(stats['Total Equipment Types']).toBe('2');
    expect(stats['Total Units']).toBe('30');
    expect(stats['Total Units Available']).toBe('25'); // 5 (basketball) + 20 (cones)
    expect(stats['Equipment Missing QR/Items']).toBe('1'); // only Cones: registered 0 but totalQuantity > 0
  });
});

describe('GET /api/reports/condition', () => {
  test('picks the worst condition per equipment (Lost > Damaged > Under Repair > Good) and aggregates unit counts', async () => {
    const mostlyGood = makeEquipment({
      equipmentName: 'Volleyball',
      items: [makeItem({ itemCondition: 'Good' }), makeItem({ itemCondition: 'Good' }), makeItem({ itemCondition: 'Damaged' })]
    });
    const oneLost = makeEquipment({
      equipmentName: 'Whistle',
      items: [makeItem({ itemCondition: 'Good' }), makeItem({ itemCondition: 'Lost' })]
    });
    const allGood = makeEquipment({
      equipmentName: 'Cones',
      items: [makeItem({ itemCondition: 'Good' })]
    });

    Equipment.findAll.mockResolvedValue([mostlyGood, oneLost, allGood]);
    const res = mockRes();
    await ctrl.condition({ query: {} }, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.title).toBe('EQUIPMENT CONDITION REPORT');

    const volleyballRow = payload.data.data.find((r) => r[0] === 'Volleyball');
    expect(volleyballRow[3]).toBe('Damaged');
    expect(volleyballRow[4]).toBe('1 unit damaged');

    const whistleRow = payload.data.data.find((r) => r[0] === 'Whistle');
    expect(whistleRow[3]).toBe('Lost');

    const conesRow = payload.data.data.find((r) => r[0] === 'Cones');
    expect(conesRow[3]).toBe('Good');
    expect(conesRow[4]).toBe('All units serviceable');

    // Good units: 2 (Volleyball) + 1 (Whistle) + 1 (Cones) = 4
    // Damaged: 1, Lost: 1
    const stats = Object.fromEntries(payload.data.stats);
    expect(stats['Good Units']).toBe('4');
    expect(stats['Damaged Units']).toBe('1');
    expect(stats['Lost Units']).toBe('1');
  });
});

describe('GET /api/reports/transaction-log', () => {
  test('groups transactions by day-of-month using the shared borrow.controller serializer', async () => {
    const txn1 = makeTransaction({
      id: 101,
      requestDatetime: new Date('2026-01-05T10:00:00Z'),
      borrower: makeBorrower({ firstName: 'Ana', lastName: 'Reyes' }),
      details: [makeTransactionDetail({ item: makeItem({ equipment: makeEquipment({ equipmentName: 'Basketball' }) }) })]
    });
    const txn2 = makeTransaction({
      id: 102,
      requestDatetime: new Date('2026-01-05T15:00:00Z'),
      borrower: makeBorrower({ firstName: 'Ben', lastName: 'Cruz' }),
      details: []
    });
    const txn3 = makeTransaction({
      id: 103,
      requestDatetime: new Date('2026-01-12T09:00:00Z'),
      details: []
    });

    Transaction.findAll.mockResolvedValue([txn1, txn2, txn3]);
    const req = { query: { year: '2026', month: '1' } };
    const res = mockRes();
    await ctrl.transactionLog(req, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.year).toBe(2026);
    expect(payload.data.month).toBe(1);
    expect(payload.data.byDay['5']).toHaveLength(2);
    expect(payload.data.byDay['12']).toHaveLength(1);
    expect(payload.data.byDay['5'][0].name).toBe('Ana Reyes');
    // serialize() output shape sanity check
    expect(payload.data.byDay['5'][0]).toMatchObject({ dbId: 101, id: 'TXN-2026-0101' });
  });
});
