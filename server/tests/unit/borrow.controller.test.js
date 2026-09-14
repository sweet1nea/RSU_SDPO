'use strict';

// Verifies server/controllers/borrow.controller.js — previously zero test
// coverage on this file (flagged in the 2026-09-08 system audit) despite it
// implementing the entire request -> review -> approve -> release -> return
// workflow. This file focuses on the new logic added to fix 2 Critical
// audit findings:
//   1. The Green/Yellow/Red availability-threshold borrowing caps (spec:
//      >5 available = up to 2 units, 4-5 = 1 unit, 1-3 = borrowing blocked)
//      were not enforced anywhere — createSelfRequest() now enforces them.
//   2. Items were never actually reserved when a request was submitted
//      (availabilityStatus stayed 'Available' all the way through Director
//      approval), so the same physical item could be double-booked, and
//      release() never re-checked availability before releasing. Items are
//      now moved to 'Reserved' at request-creation time and only consumed
//      (Reserved -> Borrowed) at release; Rejected/Cancelled give the
//      reservation back via releaseReservedItems().

jest.mock('../../models', () => ({
  Transaction: { create: jest.fn(), findByPk: jest.fn(), findAll: jest.fn() },
  TransactionDetail: { bulkCreate: jest.fn() },
  Borrower: { findOne: jest.fn(), findByPk: jest.fn() },
  User: {},
  Item: { findAll: jest.fn(), update: jest.fn() },
  Equipment: { findByPk: jest.fn(), decrement: jest.fn(), increment: jest.fn() },
  Category: {},
  MaintenanceFee: {},
  sequelize: { transaction: jest.fn() }
}));
jest.mock('../../helpers/notify', () => ({ notifyBorrower: jest.fn(), notifyStaff: jest.fn() }));
jest.mock('../../helpers/transactionLog', () => ({ logStatusChange: jest.fn() }));

const { Transaction, TransactionDetail, Borrower, Item, Equipment, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { logStatusChange } = require('../../helpers/transactionLog');
const { notifyBorrower } = require('../../helpers/notify');
const ctrl = require('../../controllers/borrow.controller');

function mockRes() {
  return { json: jest.fn(), status: jest.fn().mockReturnThis() };
}

// Every real call site does `sequelize.transaction(async (t) => {...})`, and
// the new locking calls read `t.LOCK.UPDATE` — the fake t must have that
// shape or those lines throw in tests exactly like they would against a
// stub without it.
const fakeT = { LOCK: { UPDATE: 'UPDATE' } };
function runTransactions() {
  sequelize.transaction.mockImplementation((cb) => cb(fakeT));
}

// Minimal txn shape sufficient for serialize() to run without throwing.
function stubFindByPkResult(overrides) {
  return Object.assign(
    {
      id: 1,
      requestDatetime: new Date('2026-09-01'),
      createdAt: new Date('2026-09-01'),
      borrower: null,
      reviewer: null,
      approver: null,
      details: [],
      maintenanceFees: []
    },
    overrides
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  runTransactions();
  // createSelfRequest() now checks for a Late Return Policy block via
  // Transaction.findAll before anything else — default to "no overdue
  // transactions" so every existing test doesn't have to know about this;
  // the dedicated describe block below overrides it to test the block itself.
  Transaction.findAll.mockResolvedValue([]);
});

describe('createSelfRequest — Green/Yellow/Red availability-threshold caps', () => {
  const baseReq = (items) => ({ user: { id: 9 }, body: { items } });

  beforeEach(() => {
    Borrower.findOne.mockResolvedValue({ id: 5, firstName: 'Juan', lastName: 'Dela Cruz' });
  });

  test('Red tier (1-3 available) blocks borrowing entirely, even for quantity 1', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Volleyball', availableQuantity: 2 });
    await expect(ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({
      statusCode: 409
    });
    expect(Item.update).not.toHaveBeenCalled();
  });

  test('Yellow tier (4-5 available) caps at 1 unit — requesting 2 is rejected', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Basketball', availableQuantity: 5 });
    await expect(ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 2 }]), mockRes())).rejects.toMatchObject({
      statusCode: 409
    });
  });

  test('Yellow tier (4-5 available) allows exactly 1 unit', async () => {
    const equipment = { id: 1, equipmentName: 'Basketball', availableQuantity: 5, decrement: jest.fn().mockResolvedValue() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([{ id: 101, equipmentId: 1, itemCode: 'BB-1-001' }]);
    Transaction.create.mockResolvedValueOnce({ id: 55 });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id: 55 }));

    await ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 1 }]), mockRes());

    expect(Item.update).toHaveBeenCalledWith(
      { availabilityStatus: 'Reserved' },
      expect.objectContaining({ where: { id: [101] } })
    );
    expect(equipment.decrement).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 1 }));
  });

  test('Green tier (>5 available) caps at 2 units — requesting 3 is rejected', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Cones', availableQuantity: 20 });
    await expect(ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 3 }]), mockRes())).rejects.toMatchObject({
      statusCode: 409
    });
  });

  test('Green tier (>5 available) allows exactly 2 units and reserves them', async () => {
    const equipment = { id: 1, equipmentName: 'Cones', availableQuantity: 20, decrement: jest.fn().mockResolvedValue() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([
      { id: 201, equipmentId: 1, itemCode: 'CN-1-001' },
      { id: 202, equipmentId: 1, itemCode: 'CN-1-002' }
    ]);
    Transaction.create.mockResolvedValueOnce({ id: 56 });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id: 56 }));

    await ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 2 }]), mockRes());

    expect(Item.update).toHaveBeenCalledWith(
      { availabilityStatus: 'Reserved' },
      expect.objectContaining({ where: { id: [201, 202] } })
    );
    expect(equipment.decrement).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 2 }));
  });

  test('still rejects with insufficient-stock when fewer items are actually Available than the cap allows', async () => {
    const equipment = { id: 1, equipmentName: 'Cones', availableQuantity: 20, decrement: jest.fn() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    // Cap allows 2, but only 1 Available row actually comes back (e.g. a
    // concurrent request already reserved the other one).
    Item.findAll.mockResolvedValueOnce([{ id: 201, equipmentId: 1, itemCode: 'CN-1-001' }]);

    await expect(ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 2 }]), mockRes())).rejects.toMatchObject({
      statusCode: 409
    });
    expect(equipment.decrement).not.toHaveBeenCalled();
  });
});

// 2026-09-12: project-leader-requested addition — a per-equipment minimum
// stock floor at 25% of totalQuantity, on top of the fixed Green/Yellow/Red
// bands above. This matters most for equipment with a large total, where
// the fixed bands alone would keep allowing borrowing well past the point
// SDPO wants a quarter of stock held back (e.g. 25% of a 20-unit total is
// 5, which the fixed bands alone still treat as Yellow/1-unit-allowed).
describe('createSelfRequest — 25%-of-total minimum-stock floor', () => {
  const baseReq = (items) => ({ user: { id: 9 }, body: { items } });

  beforeEach(() => {
    Borrower.findOne.mockResolvedValue({ id: 5, firstName: 'Juan', lastName: 'Dela Cruz' });
  });

  test('blocks borrowing entirely once available drops to the 25%-of-total floor, even though the fixed Yellow band alone would allow 1 unit', async () => {
    // total 20 -> floor = ceil(20 * 0.25) = 5; available 5 is Yellow under
    // the fixed bands (would normally allow 1 unit) but is at the floor.
    Equipment.findByPk.mockResolvedValueOnce({
      id: 1,
      equipmentName: 'Cones',
      availableQuantity: 5,
      totalQuantity: 20
    });
    await expect(
      ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 1 }]), mockRes())
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/25% minimum-stock threshold/)
    });
    expect(Item.update).not.toHaveBeenCalled();
  });

  test('still allows borrowing when available is just above the 25%-of-total floor', async () => {
    // total 20 -> floor = 5; available 6 is above the floor and Green under
    // the fixed bands, so 2 units should still be allowed.
    const equipment = {
      id: 1,
      equipmentName: 'Cones',
      availableQuantity: 6,
      totalQuantity: 20,
      decrement: jest.fn().mockResolvedValue()
    };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([
      { id: 301, equipmentId: 1, itemCode: 'CN-1-001' },
      { id: 302, equipmentId: 1, itemCode: 'CN-1-002' }
    ]);
    Transaction.create.mockResolvedValueOnce({ id: 57 });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id: 57 }));

    await ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 2 }]), mockRes());

    expect(equipment.decrement).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 2 }));
  });

  test('rounds the floor up (ceil), so a total not evenly divisible by 4 still blocks at the stricter integer floor', async () => {
    // total 10 -> floor = ceil(10 * 0.25) = ceil(2.5) = 3.
    Equipment.findByPk.mockResolvedValueOnce({
      id: 1,
      equipmentName: 'Badminton Rackets',
      availableQuantity: 3,
      totalQuantity: 10
    });
    await expect(
      ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 1 }]), mockRes())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('a fixed-band Red rejection message is unchanged (does not claim the 25% floor) when totalQuantity is unknown', async () => {
    // No totalQuantity on the mock at all — the floor check must skip
    // cleanly rather than throwing on NaN, and the original fixed-band
    // message must still be used.
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Volleyball', availableQuantity: 2 });
    await expect(
      ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 1 }]), mockRes())
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/minimum-stock guideline/)
    });
  });
});

describe('release() re-validates items are still Reserved before releasing', () => {
  test('refuses to release when an item has drifted out of Reserved', async () => {
    const txn = stubFindByPkResult({
      id: 7,
      transactionStatus: 'Approved',
      receivedByBorrowerDatetime: new Date('2026-09-01'),
      details: [{ item: { itemCode: 'BB-1-001', availabilityStatus: 'Available', update: jest.fn(), equipment: { equipmentName: 'Basketball' } } }]
    });
    Transaction.findByPk.mockResolvedValueOnce(txn);

    await expect(
      ctrl.release({ params: { id: 7 }, body: { itemCodes: ['BB-1-001'] }, user: { id: 3 } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('refuses to release when the borrower has not yet acknowledged receipt', async () => {
    const txn = stubFindByPkResult({
      id: 9,
      transactionStatus: 'Approved',
      receivedByBorrowerDatetime: null,
      details: [{ item: { itemCode: 'BB-1-001', availabilityStatus: 'Reserved', update: jest.fn(), equipment: { equipmentName: 'Basketball' } } }]
    });
    Transaction.findByPk.mockResolvedValueOnce(txn);

    await expect(
      ctrl.release({ params: { id: 9 }, body: { itemCodes: ['BB-1-001'] }, user: { id: 3 } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/acknowledg/i) });
  });

  test('releases successfully without double-decrementing availableQuantity (already decremented at reservation time)', async () => {
    const itemUpdate = jest.fn().mockResolvedValue();
    const txn = stubFindByPkResult({
      id: 8,
      transactionStatus: 'Approved',
      borrowerId: 5,
      receivedByBorrowerDatetime: new Date('2026-09-01'),
      details: [{ item: { itemCode: 'BB-1-001', availabilityStatus: 'Reserved', equipmentId: 1, update: itemUpdate, equipment: { equipmentName: 'Basketball' } } }]
    });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);
    txn.save = jest.fn().mockResolvedValue();

    await ctrl.release({ params: { id: 8 }, body: { itemCodes: ['BB-1-001'] }, user: { id: 3 } }, mockRes());

    expect(itemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ availabilityStatus: 'Borrowed', currentBorrowerId: 5 }),
      expect.anything()
    );
    // The old behavior decremented Equipment.availableQuantity again here —
    // that would now double-count stock that was already taken out of the
    // pool when the item was reserved.
    expect(Equipment.decrement).not.toHaveBeenCalled();
  });
});

describe('acknowledgeReceipt() — pre-issuance electronic acknowledgement', () => {
  test('rejects a borrower who does not own the transaction', async () => {
    const txn = stubFindByPkResult({ id: 20, transactionStatus: 'Approved', borrowerId: 5 });
    Borrower.findOne.mockResolvedValueOnce({ id: 6 });
    Transaction.findByPk.mockResolvedValueOnce(txn);

    await expect(
      ctrl.acknowledgeReceipt({ params: { id: 20 }, user: { id: 9 } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('rejects when the transaction is not yet Approved', async () => {
    const txn = stubFindByPkResult({ id: 21, transactionStatus: 'For Approval', borrowerId: 5 });
    Borrower.findOne.mockResolvedValueOnce({ id: 5 });
    Transaction.findByPk.mockResolvedValueOnce(txn);

    await expect(
      ctrl.acknowledgeReceipt({ params: { id: 21 }, user: { id: 9 } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('rejects if receipt was already acknowledged', async () => {
    const txn = stubFindByPkResult({
      id: 22,
      transactionStatus: 'Approved',
      borrowerId: 5,
      receivedByBorrowerDatetime: new Date('2026-09-01')
    });
    Borrower.findOne.mockResolvedValueOnce({ id: 5 });
    Transaction.findByPk.mockResolvedValueOnce(txn);

    await expect(
      ctrl.acknowledgeReceipt({ params: { id: 22 }, user: { id: 9 } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('records the acknowledgement timestamp and returns the updated transaction', async () => {
    const txn = stubFindByPkResult({
      id: 23,
      transactionStatus: 'Approved',
      borrowerId: 5,
      receivedByBorrowerDatetime: null
    });
    txn.save = jest.fn().mockResolvedValue();
    Borrower.findOne.mockResolvedValueOnce({ id: 5 });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    const res = mockRes();
    await ctrl.acknowledgeReceipt({ params: { id: 23 }, user: { id: 9 } }, res);

    expect(txn.receivedByBorrowerDatetime).toBeInstanceOf(Date);
    expect(txn.save).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: expect.objectContaining({ dbId: 23 }) })
    );
  });
});

describe('rejecting/cancelling a request releases its Reserved items back to stock', () => {
  function reservedTxn(overrides) {
    return Object.assign(
      stubFindByPkResult({
        transactionStatus: 'Pending',
        details: [
          { item: { id: 301, equipmentId: 1, availabilityStatus: 'Reserved', itemCode: 'CN-1-001', equipment: { equipmentName: 'Cones' } } },
          { item: { id: 302, equipmentId: 1, availabilityStatus: 'Reserved', itemCode: 'CN-1-002', equipment: { equipmentName: 'Cones' } } }
        ]
      }),
      overrides
    );
  }

  test('reject() sets Reserved items back to Available and restores availableQuantity', async () => {
    const txn = reservedTxn({ id: 10 });
    txn.save = jest.fn().mockResolvedValue();
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.reject({ params: { id: 10 }, user: { id: 3, userRole: 'Staff' }, body: {} }, mockRes());

    expect(Item.update).toHaveBeenCalledWith(
      { availabilityStatus: 'Available' },
      expect.objectContaining({ where: { id: [301, 302] } })
    );
    expect(Equipment.increment).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 2, where: { id: '1' } }));
    expect(txn.transactionStatus).toBe('Rejected');
  });

  test('reject() records remarks in the audit log and includes them in the borrower notification', async () => {
    const txn = reservedTxn({ id: 14, borrower: { user: { id: 40 } } });
    txn.save = jest.fn().mockResolvedValue();
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.reject(
      { params: { id: 14 }, user: { id: 3, userRole: 'Staff' }, body: { remarks: 'Missing valid ID' } },
      mockRes()
    );

    expect(logStatusChange).toHaveBeenCalledWith(14, 3, 'Pending', 'Rejected', 'Missing valid ID');
    expect(notifyBorrower).toHaveBeenCalledWith(40, expect.stringContaining('Missing valid ID'), 'Rejection');
  });

  test('reject() forbids a non-Director from rejecting a transaction already at the For Approval stage', async () => {
    const txn = reservedTxn({ id: 15, transactionStatus: 'For Approval' });
    Transaction.findByPk.mockResolvedValueOnce(txn);

    await expect(
      ctrl.reject({ params: { id: 15 }, user: { id: 3, userRole: 'Staff' }, body: {} }, mockRes())
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(Item.update).not.toHaveBeenCalled();
  });

  test('reject() allows a Director to reject a transaction at the For Approval stage', async () => {
    const txn = reservedTxn({ id: 16, transactionStatus: 'For Approval' });
    txn.save = jest.fn().mockResolvedValue();
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.reject({ params: { id: 16 }, user: { id: 3, userRole: 'Director' }, body: {} }, mockRes());

    expect(txn.transactionStatus).toBe('Rejected');
  });

  test('reject() still allows Staff to reject at the earlier Pending/Acknowledged stage (no role restriction there)', async () => {
    const txn = reservedTxn({ id: 17, transactionStatus: 'Acknowledged' });
    txn.save = jest.fn().mockResolvedValue();
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.reject({ params: { id: 17 }, user: { id: 3, userRole: 'Staff' }, body: {} }, mockRes());

    expect(txn.transactionStatus).toBe('Rejected');
  });

  test('cancelSelfRequest() releases items the same way', async () => {
    const txn = reservedTxn({ id: 11, borrowerId: 5 });
    txn.save = jest.fn().mockResolvedValue();
    Borrower.findOne.mockResolvedValueOnce({ id: 5 });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.cancelSelfRequest({ params: { id: 11 }, user: { id: 9 } }, mockRes());

    expect(Item.update).toHaveBeenCalledWith(
      { availabilityStatus: 'Available' },
      expect.objectContaining({ where: { id: [301, 302] } })
    );
    expect(txn.transactionStatus).toBe('Cancelled');
  });

  test('review() with action "reject" releases items too', async () => {
    const txn = reservedTxn({ id: 12, transactionStatus: 'Acknowledged' });
    txn.save = jest.fn().mockResolvedValue();
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.review({ params: { id: 12 }, user: { id: 3 }, body: { action: 'reject' } }, mockRes());

    expect(Item.update).toHaveBeenCalledWith(
      { availabilityStatus: 'Available' },
      expect.objectContaining({ where: { id: [301, 302] } })
    );
    expect(txn.transactionStatus).toBe('Rejected');
  });

  test('review() with action "accept" does NOT release items (they stay Reserved through approval)', async () => {
    const txn = reservedTxn({ id: 13, transactionStatus: 'Acknowledged' });
    txn.save = jest.fn().mockResolvedValue();
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.review({ params: { id: 13 }, user: { id: 3 }, body: { action: 'accept' } }, mockRes());

    expect(Item.update).not.toHaveBeenCalled();
    expect(txn.transactionStatus).toBe('For Approval');
  });
});

describe('Late Return Policy — blocks new self-service requests while an overdue item is unreturned', () => {
  const baseReq = (items) => ({ user: { id: 9 }, body: { items } });

  beforeEach(() => {
    Borrower.findOne.mockResolvedValue({ id: 5 });
  });

  test('createSelfRequest() rejects with 403 when an Overdue transaction is past the grace window', async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    Transaction.findAll.mockResolvedValueOnce([{ id: 77, expectedReturnDatetime: fourDaysAgo }]);

    await expect(
      ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 1 }]), mockRes())
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/overdue/i) });
    expect(Equipment.findByPk).not.toHaveBeenCalled();
  });

  test('createSelfRequest() is NOT blocked while an Overdue transaction is still within the grace window', async () => {
    // The real query filters expectedReturnDatetime < (now - graceDays), so
    // a transaction only 1 day overdue would never be returned by it —
    // mirror that here rather than the controller re-filtering in JS.
    Transaction.findAll.mockResolvedValueOnce([]);
    const equipment = { id: 1, equipmentName: 'Basketball', availableQuantity: 10, decrement: jest.fn().mockResolvedValue() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([{ id: 101, equipmentId: 1, itemCode: 'BB-1-001' }]);
    Transaction.create.mockResolvedValueOnce({ id: 79 });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id: 79 }));

    await ctrl.createSelfRequest(baseReq([{ equipmentId: 1, quantity: 1 }]), mockRes());

    expect(Equipment.findByPk).toHaveBeenCalled();
  });

  test('lateReturnStatus() reports blocked:true with the overdue summary', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    Transaction.findAll.mockResolvedValueOnce([{ id: 80, expectedReturnDatetime: fiveDaysAgo }]);

    const res = mockRes();
    await ctrl.lateReturnStatus({ user: { id: 9 } }, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ blocked: true, oldestTransactionId: 80, daysOverdue: expect.any(Number) })
      })
    );
  });

  test('lateReturnStatus() reports blocked:false when nothing is overdue past the grace window', async () => {
    const res = mockRes();
    await ctrl.lateReturnStatus({ user: { id: 9 } }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { blocked: false } });
  });

  test('queries only Overdue transactions for this borrower, filtered to more than 3 days past due', async () => {
    const res = mockRes();
    await ctrl.lateReturnStatus({ user: { id: 9 } }, res);

    expect(Transaction.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          borrowerId: 5,
          transactionStatus: 'Overdue',
          expectedReturnDatetime: expect.objectContaining({ [Op.lt]: expect.any(Date) })
        })
      })
    );
    const call = Transaction.findAll.mock.calls[0][0];
    const cutoff = call.where.expectedReturnDatetime[Op.lt];
    const expectedCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    // Allow a few seconds of slack for test-runtime clock drift.
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(5000);
  });
});

describe('serialize() — surfaces the rejection reason / cancellation date from the audit trail', () => {
  test('a Rejected transaction exposes the remarks from its most recent Rejected log entry as `reason`', async () => {
    const txn = stubFindByPkResult({
      id: 90,
      transactionStatus: 'Rejected',
      logs: [
        { newStatus: 'Acknowledged', remarks: null, changeDatetime: new Date('2026-09-01T08:00:00Z') },
        { newStatus: 'Rejected', remarks: 'Missing valid ID', changeDatetime: new Date('2026-09-02T08:00:00Z') }
      ]
    });
    Transaction.findAll.mockResolvedValueOnce([txn]);

    const res = mockRes();
    await ctrl.list({}, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ reason: 'Missing valid ID' })] })
    );
  });

  test('a Cancelled transaction exposes a formatted cancellation date as `cancelledAt`, not the fixed remarks text', async () => {
    const txn = stubFindByPkResult({
      id: 91,
      transactionStatus: 'Cancelled',
      logs: [{ newStatus: 'Cancelled', remarks: 'Cancelled by borrower', changeDatetime: new Date('2026-09-03T08:00:00Z') }]
    });
    Transaction.findAll.mockResolvedValueOnce([txn]);

    const res = mockRes();
    await ctrl.list({}, res);

    const data = res.json.mock.calls[0][0].data[0];
    expect(data.reason).toBeNull();
    expect(data.cancelledAt).toBeTruthy();
    expect(data.cancelledAt).not.toBe('Cancelled by borrower');
  });

  test('an Approved transaction has neither `reason` nor `cancelledAt` set', async () => {
    const txn = stubFindByPkResult({ id: 92, transactionStatus: 'Approved', logs: [] });
    Transaction.findAll.mockResolvedValueOnce([txn]);

    const res = mockRes();
    await ctrl.list({}, res);

    const data = res.json.mock.calls[0][0].data[0];
    expect(data.reason).toBeNull();
    expect(data.cancelledAt).toBeNull();
  });
});
