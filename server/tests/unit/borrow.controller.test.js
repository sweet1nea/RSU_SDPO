'use strict';

// Verifies server/controllers/borrow.controller.js — the request → document
// verification → Director approval → release workflow:
//   - Green/Yellow/Red availability caps + 25% minimum-stock floor
//   - units Reserved at submission, released back on Rejected/Cancelled
//   - flagged-borrower / pending-replacement / late-return restrictions,
//     enforced server-side before anything is created
//   - required documents per borrower type
//   - idempotent submission (requestKey)
//   - Admin/Staff document verification gate before the Director
//   - atomic status transitions (double-clicks get a 409, no side effects)

jest.mock('../../models', () => ({
  Transaction: { create: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), update: jest.fn() },
  TransactionDetail: { bulkCreate: jest.fn() },
  Borrower: { findOne: jest.fn(), findByPk: jest.fn() },
  User: { findByPk: jest.fn() },
  Item: { findAll: jest.fn(), update: jest.fn() },
  Equipment: { findByPk: jest.fn(), decrement: jest.fn(), increment: jest.fn() },
  Category: {},
  TransactionLog: {},
  DamageLossRecord: { findAll: jest.fn() },
  sequelize: { transaction: jest.fn() }
}));
jest.mock('../../helpers/notify', () => ({ notifyBorrower: jest.fn(), notifyStaff: jest.fn(), notifyRoles: jest.fn() }));
jest.mock('../../helpers/transactionLog', () => ({ logStatusChange: jest.fn() }));

const { Transaction, Borrower, User, Item, Equipment, DamageLossRecord, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { logStatusChange } = require('../../helpers/transactionLog');
const { notifyBorrower, notifyRoles } = require('../../helpers/notify');
const ctrl = require('../../controllers/borrow.controller');

function mockRes() {
  return { json: jest.fn(), status: jest.fn().mockReturnThis() };
}

const fakeT = { LOCK: { UPDATE: 'UPDATE' } };
const FUTURE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

// A borrower whose required documents (Student: authorization letter) are on file.
const READY_BORROWER = {
  id: 5,
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  borrowerCategory: 'Student',
  authorizationDocumentPath: 'authorization_documents/a.pdf',
  validIdPath: null
};

function stubFindByPkResult(overrides) {
  return Object.assign(
    {
      id: 1,
      requestDatetime: new Date('2026-09-01T02:00:00Z'),
      createdAt: new Date('2026-09-01T02:00:00Z'),
      borrower: null,
      reviewer: null,
      approver: null,
      details: [],
      logs: []
    },
    overrides
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockImplementation((cb) => cb(fakeT));
  Transaction.findAll.mockResolvedValue([]); // no overdue transactions
  Transaction.findOne.mockResolvedValue(null); // no prior submission with this requestKey
  Transaction.update.mockResolvedValue([1]); // conditional status update matches
  User.findByPk.mockResolvedValue({ id: 9, accountStatus: 'Active' });
  DamageLossRecord.findAll.mockResolvedValue([]); // nothing pending replacement
  Borrower.findOne.mockResolvedValue(READY_BORROWER);
});

const selfReq = (items, extra = {}) => ({ user: { id: 9 }, body: { items, expectedReturnDatetime: FUTURE, ...extra } });

describe('createSelfRequest — Green/Yellow/Red availability-threshold caps', () => {
  test('Red tier (1-3 available) blocks borrowing entirely, even for quantity 1', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Volleyball', availableQuantity: 2 });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({ statusCode: 409 });
    expect(Item.update).not.toHaveBeenCalled();
  });

  test('Yellow tier (4-5 available) caps at 1 unit — requesting 2 is rejected', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Basketball', availableQuantity: 5 });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 2 }]), mockRes())).rejects.toMatchObject({ statusCode: 409 });
  });

  test('splitting a quantity across two rows of the same equipment cannot bypass the cap', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Basketball', availableQuantity: 5 });
    await expect(
      ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }, { equipmentId: 1, quantity: 1 }]), mockRes())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('Yellow tier (4-5 available) allows exactly 1 unit and reserves it', async () => {
    const equipment = { id: 1, equipmentName: 'Basketball', availableQuantity: 5, decrement: jest.fn().mockResolvedValue() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([{ id: 101, equipmentId: 1, itemCode: 'EQ-001-001' }]);
    Transaction.create.mockResolvedValueOnce({ id: 55 });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id: 55 }));

    await ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes());

    expect(Item.update).toHaveBeenCalledWith({ availabilityStatus: 'Reserved' }, expect.objectContaining({ where: { id: [101] } }));
    expect(equipment.decrement).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 1 }));
  });

  test('Green tier (>5 available) caps at 2 units — requesting 3 is rejected', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Cones', availableQuantity: 20 });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 3 }]), mockRes())).rejects.toMatchObject({ statusCode: 409 });
  });

  test('Green tier (>5 available) allows exactly 2 units and reserves them', async () => {
    const equipment = { id: 1, equipmentName: 'Cones', availableQuantity: 20, decrement: jest.fn().mockResolvedValue() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([
      { id: 201, equipmentId: 1, itemCode: 'EQ-001-001' },
      { id: 202, equipmentId: 1, itemCode: 'EQ-001-002' }
    ]);
    Transaction.create.mockResolvedValueOnce({ id: 56 });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id: 56 }));

    await ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 2 }]), mockRes());

    expect(Item.update).toHaveBeenCalledWith({ availabilityStatus: 'Reserved' }, expect.objectContaining({ where: { id: [201, 202] } }));
    expect(equipment.decrement).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 2 }));
  });

  test('still rejects with insufficient-stock when fewer units are actually Available than the cap allows', async () => {
    const equipment = { id: 1, equipmentName: 'Cones', availableQuantity: 20, decrement: jest.fn() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([{ id: 201, equipmentId: 1, itemCode: 'EQ-001-001' }]);

    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 2 }]), mockRes())).rejects.toMatchObject({ statusCode: 409 });
    expect(equipment.decrement).not.toHaveBeenCalled();
  });
});

describe('createSelfRequest — 25%-of-total minimum-stock floor', () => {
  test('blocks borrowing at the 25%-of-total floor, even where the Yellow band alone would allow 1 unit', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Cones', availableQuantity: 5, totalQuantity: 20 });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/25% minimum-stock threshold/)
    });
    expect(Item.update).not.toHaveBeenCalled();
  });

  test('still allows borrowing just above the floor', async () => {
    const equipment = { id: 1, equipmentName: 'Cones', availableQuantity: 6, totalQuantity: 20, decrement: jest.fn().mockResolvedValue() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([
      { id: 301, equipmentId: 1, itemCode: 'EQ-001-001' },
      { id: 302, equipmentId: 1, itemCode: 'EQ-001-002' }
    ]);
    Transaction.create.mockResolvedValueOnce({ id: 57 });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id: 57 }));

    await ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 2 }]), mockRes());
    expect(equipment.decrement).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 2 }));
  });

  test('rounds the floor up (ceil)', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Rackets', availableQuantity: 3, totalQuantity: 10 });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({ statusCode: 409 });
  });

  test('a fixed-band Red rejection keeps its own message when totalQuantity is unknown', async () => {
    Equipment.findByPk.mockResolvedValueOnce({ id: 1, equipmentName: 'Volleyball', availableQuantity: 2 });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/minimum-stock guideline/)
    });
  });
});

describe('createSelfRequest — borrowing restrictions are enforced server-side before anything is created', () => {
  test('a flagged borrower (Restricted) is refused with BORROWER_FLAGGED', async () => {
    User.findByPk.mockResolvedValue({ id: 9, accountStatus: 'Restricted' });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({
      statusCode: 403,
      code: 'BORROWER_FLAGGED'
    });
    expect(Equipment.findByPk).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  test('a borrower with an item still pending replacement is refused with PENDING_REPLACEMENT', async () => {
    DamageLossRecord.findAll.mockResolvedValue([
      { id: 4, transactionId: 12, itemId: 40, resolutionStatus: 'Pending Replacement', item: { itemCode: 'EQ-002-001', equipment: { equipmentName: 'Volleyball' } } }
    ]);
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({
      statusCode: 403,
      code: 'PENDING_REPLACEMENT',
      message: expect.stringContaining('Volleyball (EQ-002-001)')
    });
    expect(DamageLossRecord.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { borrowerId: 5, resolutionStatus: { [Op.ne]: 'Resolved' } } })
    );
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  test('every active restriction is reported back so the client can show all of them', async () => {
    User.findByPk.mockResolvedValue({ id: 9, accountStatus: 'Restricted' });
    DamageLossRecord.findAll.mockResolvedValue([{ id: 4, itemId: 40, resolutionStatus: 'Replacement Submitted', item: null }]);
    const err = await ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes()).catch((e) => e);
    expect(err.details.restrictions.map((r) => r.code)).toEqual(['BORROWER_FLAGGED', 'PENDING_REPLACEMENT']);
  });

  test('missing required documents are refused with DOCUMENTS_MISSING', async () => {
    Borrower.findOne.mockResolvedValue({ ...READY_BORROWER, borrowerCategory: 'External', validIdPath: null });
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({
      statusCode: 400,
      code: 'DOCUMENTS_MISSING'
    });
  });

  test('a missing or past return date is rejected', async () => {
    await expect(
      ctrl.createSelfRequest({ user: { id: 9 }, body: { items: [{ equipmentId: 1 }], expectedReturnDatetime: '2020-01-01T10:00' } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(ctrl.createSelfRequest({ user: { id: 9 }, body: { items: [{ equipmentId: 1 }] } }, mockRes())).rejects.toMatchObject({
      statusCode: 400
    });
  });

  test('an account without a borrower profile is refused', async () => {
    Borrower.findOne.mockResolvedValue(null);
    await expect(ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }]), mockRes())).rejects.toMatchObject({
      statusCode: 403,
      code: 'PROFILE_INCOMPLETE'
    });
  });
});

describe('createSelfRequest — idempotent submission and notifications', () => {
  function successfulSubmission(id) {
    const equipment = { id: 1, equipmentName: 'Cones', availableQuantity: 20, decrement: jest.fn().mockResolvedValue() };
    Equipment.findByPk.mockResolvedValueOnce(equipment);
    Item.findAll.mockResolvedValueOnce([{ id: 201, equipmentId: 1, itemCode: 'EQ-001-001' }]);
    Transaction.create.mockResolvedValueOnce({ id });
    Transaction.findByPk.mockResolvedValueOnce(stubFindByPkResult({ id }));
  }

  test('a resubmitted requestKey returns the existing request without creating or notifying again', async () => {
    Transaction.findOne.mockResolvedValueOnce(stubFindByPkResult({ id: 70 }));
    const res = mockRes();
    await ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }], { requestKey: 'abcdef123456' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true, data: expect.objectContaining({ dbId: 70 }) }));
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(notifyBorrower).not.toHaveBeenCalled();
    expect(notifyRoles).not.toHaveBeenCalled();
  });

  test('stores the requestKey and notifies the borrower once and Admin/Staff once, with dedupe keys', async () => {
    successfulSubmission(71);
    await ctrl.createSelfRequest(selfReq([{ equipmentId: 1, quantity: 1 }], { requestKey: 'abcdef123456' }), mockRes());

    expect(Transaction.create).toHaveBeenCalledWith(expect.objectContaining({ requestKey: 'abcdef123456', transactionStatus: 'Acknowledged' }), expect.anything());
    expect(notifyBorrower).toHaveBeenCalledTimes(1);
    expect(notifyBorrower).toHaveBeenCalledWith(9, expect.any(String), 'Request Submitted', 'txn-71-submitted');
    expect(notifyRoles).toHaveBeenCalledTimes(1);
    expect(notifyRoles).toHaveBeenCalledWith(['Admin', 'Staff'], expect.any(String), 'New Request', 'txn-71-new-request');
  });

  test('the return date/time is interpreted as Philippine Time', async () => {
    successfulSubmission(72);
    const year = new Date().getFullYear() + 1;
    await ctrl.createSelfRequest(
      { user: { id: 9 }, body: { items: [{ equipmentId: 1, quantity: 1 }], expectedReturnDatetime: `${year}-03-10T15:00` } },
      mockRes()
    );
    const created = Transaction.create.mock.calls[0][0];
    expect(created.expectedReturnDatetime.toISOString()).toBe(`${year}-03-10T07:00:00.000Z`);
  });
});

describe('eligibility()', () => {
  test('reports canRequest:false with the late-return restriction', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    Transaction.findAll.mockResolvedValueOnce([{ id: 80, expectedReturnDatetime: fiveDaysAgo }]);
    const res = mockRes();
    await ctrl.eligibility({ user: { id: 9 } }, res);
    const data = res.json.mock.calls[0][0].data;
    expect(data.canRequest).toBe(false);
    expect(data.restrictions[0]).toMatchObject({ code: 'LATE_RETURN', oldestTransactionId: 80 });
  });

  test('late-return query covers only Overdue transactions more than 3 days past due', async () => {
    await ctrl.eligibility({ user: { id: 9 } }, mockRes());
    const call = Transaction.findAll.mock.calls[0][0];
    expect(call.where).toMatchObject({ borrowerId: 5, transactionStatus: 'Overdue' });
    const cutoff = call.where.expectedReturnDatetime[Op.lt];
    expect(Math.abs(cutoff.getTime() - (Date.now() - 3 * 24 * 60 * 60 * 1000))).toBeLessThan(5000);
  });

  test('reports canRequest:true when nothing restricts the borrower', async () => {
    const res = mockRes();
    await ctrl.eligibility({ user: { id: 9 } }, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { canRequest: true, restrictions: [] } });
  });
});

describe('review() — Admin/Staff document verification gate', () => {
  function pendingTxn(overrides) {
    return stubFindByPkResult({
      transactionStatus: 'Acknowledged',
      borrower: { ...READY_BORROWER, user: { id: 40 } },
      details: [{ item: { id: 301, equipmentId: 1, availabilityStatus: 'Reserved', itemCode: 'EQ-001-001', equipment: { equipmentName: 'Cones' } } }],
      ...overrides
    });
  }

  test('accept verifies the documents, moves to For Approval, and notifies the Director', async () => {
    const txn = pendingTxn({ id: 13 });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.review({ params: { id: 13 }, user: { id: 3 }, body: { action: 'accept' } }, mockRes());

    expect(Transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ transactionStatus: 'For Approval', documentsVerifiedBy: 3, documentsVerifiedDatetime: expect.any(Date) }),
      { where: { id: 13, transactionStatus: { [Op.in]: ['Pending', 'Acknowledged'] } }, transaction: undefined }
    );
    expect(Item.update).not.toHaveBeenCalled(); // units stay Reserved through approval
    expect(txn.transactionStatus).toBe('For Approval');
    expect(notifyRoles).toHaveBeenCalledWith(['Director'], expect.any(String), 'Awaiting Approval', 'txn-13-awaiting-approval');
  });

  test('accept is refused when required documents are missing', async () => {
    const txn = pendingTxn({ id: 18, borrower: { ...READY_BORROWER, authorizationDocumentPath: null, user: { id: 40 } } });
    Transaction.findByPk.mockResolvedValueOnce(txn);
    await expect(ctrl.review({ params: { id: 18 }, user: { id: 3 }, body: { action: 'accept' } }, mockRes())).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCUMENTS_MISSING'
    });
    expect(Transaction.update).not.toHaveBeenCalled();
  });

  test('a second click on an already-reviewed request gets a 409 and sends no notification', async () => {
    const txn = pendingTxn({ id: 19 });
    Transaction.findByPk.mockResolvedValueOnce(txn);
    Transaction.update.mockResolvedValueOnce([0]); // someone else already moved it
    await expect(ctrl.review({ params: { id: 19 }, user: { id: 3 }, body: { action: 'accept' } }, mockRes())).rejects.toMatchObject({
      statusCode: 409,
      code: 'STALE_STATUS'
    });
    expect(notifyBorrower).not.toHaveBeenCalled();
    expect(notifyRoles).not.toHaveBeenCalled();
    expect(logStatusChange).not.toHaveBeenCalled();
  });

  test('reject releases Reserved units back to stock', async () => {
    const txn = pendingTxn({ id: 12 });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);
    await ctrl.review({ params: { id: 12 }, user: { id: 3 }, body: { action: 'reject' } }, mockRes());
    expect(Item.update).toHaveBeenCalledWith({ availabilityStatus: 'Available' }, expect.objectContaining({ where: { id: [301] } }));
    expect(txn.transactionStatus).toBe('Rejected');
  });
});

describe('approve() — Director', () => {
  test('requires documents to have been verified first', async () => {
    const txn = stubFindByPkResult({ id: 30, transactionStatus: 'For Approval', documentsVerifiedDatetime: null });
    Transaction.findByPk.mockResolvedValueOnce(txn);
    await expect(ctrl.approve({ params: { id: 30 }, user: { id: 2 } }, mockRes())).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCUMENTS_NOT_VERIFIED'
    });
  });

  test('approves a verified request and notifies the borrower once', async () => {
    const txn = stubFindByPkResult({ id: 31, transactionStatus: 'For Approval', documentsVerifiedDatetime: new Date(), borrower: { user: { id: 40 } } });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);
    await ctrl.approve({ params: { id: 31 }, user: { id: 2 } }, mockRes());
    expect(txn.transactionStatus).toBe('Approved');
    expect(txn.approvedBy).toBe(2);
    expect(notifyBorrower).toHaveBeenCalledWith(40, expect.any(String), 'Approval', 'txn-31-approved');
  });

  test('cannot approve a request that skipped document review', async () => {
    const txn = stubFindByPkResult({ id: 32, transactionStatus: 'Acknowledged' });
    Transaction.findByPk.mockResolvedValueOnce(txn);
    await expect(ctrl.approve({ params: { id: 32 }, user: { id: 2 } }, mockRes())).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('release()', () => {
  const reservedDetail = (update) => ({
    item: { itemCode: 'EQ-001-001', legacyItemCode: 'BB-1-001', availabilityStatus: 'Reserved', equipmentId: 1, update, equipment: { equipmentName: 'Basketball' } }
  });

  test('refuses to release when a unit has drifted out of Reserved', async () => {
    const txn = stubFindByPkResult({
      id: 7,
      transactionStatus: 'Approved',
      details: [{ item: { itemCode: 'EQ-001-001', availabilityStatus: 'Available', update: jest.fn(), equipment: { equipmentName: 'Basketball' } } }]
    });
    Transaction.findByPk.mockResolvedValueOnce(txn);
    await expect(ctrl.release({ params: { id: 7 }, body: { itemCodes: ['EQ-001-001'] }, user: { id: 3 } }, mockRes())).rejects.toMatchObject({
      statusCode: 409
    });
  });

  // The borrower electronic-acknowledgement-of-receipt gate (and the
  // acknowledgeReceipt() endpoint that set it) was removed by request —
  // staff can release equipment as soon as a request is Approved, with no
  // separate borrower confirmation step. release() no longer checks
  // receivedByBorrowerDatetime at all.
  test('releases (also by a legacy label code) without double-decrementing stock', async () => {
    const itemUpdate = jest.fn().mockResolvedValue();
    const txn = stubFindByPkResult({ id: 8, transactionStatus: 'Approved', borrowerId: 5, details: [reservedDetail(itemUpdate)] });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);

    await ctrl.release({ params: { id: 8 }, body: { itemCodes: ['BB-1-001'] }, user: { id: 3 } }, mockRes());

    expect(itemUpdate).toHaveBeenCalledWith(expect.objectContaining({ availabilityStatus: 'Borrowed', currentBorrowerId: 5 }), expect.anything());
    expect(Equipment.decrement).not.toHaveBeenCalled();
    expect(txn.transactionStatus).toBe('Released');
  });

  test('a code from a different unit does not match', async () => {
    const txn = stubFindByPkResult({ id: 10, transactionStatus: 'Approved', details: [reservedDetail(jest.fn())] });
    Transaction.findByPk.mockResolvedValueOnce(txn);
    await expect(ctrl.release({ params: { id: 10 }, body: { itemCodes: ['EQ-001-002'] }, user: { id: 3 } }, mockRes())).rejects.toMatchObject({
      statusCode: 409
    });
  });
});

describe('reject() / cancelSelfRequest() release Reserved units back to stock', () => {
  function reservedTxn(overrides) {
    return stubFindByPkResult({
      transactionStatus: 'Acknowledged',
      details: [
        { item: { id: 301, equipmentId: 1, availabilityStatus: 'Reserved', itemCode: 'EQ-001-001', equipment: { equipmentName: 'Cones' } } },
        { item: { id: 302, equipmentId: 1, availabilityStatus: 'Reserved', itemCode: 'EQ-001-002', equipment: { equipmentName: 'Cones' } } }
      ],
      ...overrides
    });
  }

  test('reject() restores units and availableQuantity', async () => {
    const txn = reservedTxn({ id: 10 });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);
    await ctrl.reject({ params: { id: 10 }, user: { id: 3, userRole: 'Staff' }, body: {} }, mockRes());
    expect(Item.update).toHaveBeenCalledWith({ availabilityStatus: 'Available' }, expect.objectContaining({ where: { id: [301, 302] } }));
    expect(Equipment.increment).toHaveBeenCalledWith('availableQuantity', expect.objectContaining({ by: 2, where: { id: '1' } }));
    expect(txn.transactionStatus).toBe('Rejected');
  });

  test('reject() records remarks and notifies the borrower once', async () => {
    const txn = reservedTxn({ id: 14, borrower: { user: { id: 40 } } });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);
    await ctrl.reject({ params: { id: 14 }, user: { id: 3, userRole: 'Staff' }, body: { remarks: 'Missing valid ID' } }, mockRes());
    expect(logStatusChange).toHaveBeenCalledWith(14, 3, 'Acknowledged', 'Rejected', 'Missing valid ID');
    expect(notifyBorrower).toHaveBeenCalledWith(40, expect.stringContaining('Missing valid ID'), 'Rejection', 'txn-14-rejected');
  });

  test('reject() forbids Staff at the For Approval stage', async () => {
    Transaction.findByPk.mockResolvedValueOnce(reservedTxn({ id: 15, transactionStatus: 'For Approval' }));
    await expect(ctrl.reject({ params: { id: 15 }, user: { id: 3, userRole: 'Staff' }, body: {} }, mockRes())).rejects.toMatchObject({
      statusCode: 403
    });
    expect(Item.update).not.toHaveBeenCalled();
  });

  test('reject() allows the Director at the For Approval stage', async () => {
    const txn = reservedTxn({ id: 16, transactionStatus: 'For Approval' });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);
    await ctrl.reject({ params: { id: 16 }, user: { id: 3, userRole: 'Director' }, body: {} }, mockRes());
    expect(txn.transactionStatus).toBe('Rejected');
  });

  test('a duplicate reject never releases stock twice', async () => {
    Transaction.findByPk.mockResolvedValueOnce(reservedTxn({ id: 17 }));
    Transaction.update.mockResolvedValueOnce([0]);
    await expect(ctrl.reject({ params: { id: 17 }, user: { id: 3, userRole: 'Staff' }, body: {} }, mockRes())).rejects.toMatchObject({
      statusCode: 409
    });
    expect(Item.update).not.toHaveBeenCalled();
    expect(Equipment.increment).not.toHaveBeenCalled();
  });

  test('cancelSelfRequest() releases units the same way', async () => {
    const txn = reservedTxn({ id: 11, borrowerId: 5 });
    Transaction.findByPk.mockResolvedValueOnce(txn).mockResolvedValueOnce(txn);
    await ctrl.cancelSelfRequest({ params: { id: 11 }, user: { id: 9 } }, mockRes());
    expect(Item.update).toHaveBeenCalledWith({ availabilityStatus: 'Available' }, expect.objectContaining({ where: { id: [301, 302] } }));
    expect(txn.transactionStatus).toBe('Cancelled');
  });
});

describe('serialize()', () => {
  test('a Rejected transaction exposes its rejection remarks as `reason`', async () => {
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
    expect(res.json.mock.calls[0][0].data[0].reason).toBe('Missing valid ID');
  });

  test('a Cancelled transaction exposes a formatted cancellation date', async () => {
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
    expect(data.cancelledAt).toBe('Sep 3, 2026');
  });

  test('dates and times are rendered in Philippine Time regardless of server timezone', async () => {
    // 2026-08-31T17:30Z is 1:30 AM on Sep 1 in Manila.
    const txn = stubFindByPkResult({ id: 93, transactionStatus: 'Acknowledged', requestDatetime: new Date('2026-08-31T17:30:00Z') });
    Transaction.findAll.mockResolvedValueOnce([txn]);
    const res = mockRes();
    await ctrl.list({}, res);
    const data = res.json.mock.calls[0][0].data[0];
    expect(data.date).toBe('Sep 1, 2026');
    expect(data.time).toBe('1:30 AM');
    expect(data.id).toBe('TN93-2026');
  });

  test('units carry the canonical Equipment ID of their equipment', async () => {
    const txn = stubFindByPkResult({
      id: 94,
      transactionStatus: 'Approved',
      details: [{ item: { itemCode: 'EQ-005-002', equipmentId: 5, equipment: { equipmentName: 'Volleyball', category: { categoryName: 'Volleyball' } } } }]
    });
    Transaction.findAll.mockResolvedValueOnce([txn]);
    const res = mockRes();
    await ctrl.list({}, res);
    expect(res.json.mock.calls[0][0].data[0].items[0]).toMatchObject({ code: 'EQ-005-002', equipmentId: 5, equipmentCode: 'EQ-005' });
    expect(res.json.mock.calls[0][0].data[0]).not.toHaveProperty('fees');
  });
});
