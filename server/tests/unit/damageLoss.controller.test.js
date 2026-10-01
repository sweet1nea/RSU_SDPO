'use strict';

// Verifies server/controllers/damageLoss.controller.js after damage/loss
// fees were removed: records serialize with no fee data, flagging never
// creates a fee, and resolving a record is idempotent (a repeated click
// can't credit the restored unit to stock twice).

jest.mock('../../models', () => ({
  DamageLossRecord: { findAll: jest.fn(), findByPk: jest.fn(), update: jest.fn(), count: jest.fn() },
  Transaction: { findByPk: jest.fn(), update: jest.fn() },
  Borrower: { findByPk: jest.fn() },
  User: {},
  Item: { findByPk: jest.fn() },
  Equipment: { increment: jest.fn() },
  Category: {},
  sequelize: { transaction: jest.fn() }
}));
jest.mock('../../helpers/notify', () => ({ notifyBorrower: jest.fn() }));
jest.mock('../../helpers/transactionLog', () => ({ logStatusChange: jest.fn() }));

const models = require('../../models');
const { DamageLossRecord, Transaction, Item, Equipment, sequelize } = models;
const { notifyBorrower } = require('../../helpers/notify');
const ctrl = require('../../controllers/damageLoss.controller');

function mockRes() {
  return { json: jest.fn() };
}

function baseRecord(overrides = {}) {
  return {
    id: 1,
    transactionId: 5,
    borrowerId: 3,
    itemId: 40,
    incidentType: 'Damaged',
    dateReported: '2026-08-01T02:00:00Z',
    conditionDetails: 'Cracked backboard',
    resolutionStatus: 'Pending Replacement',
    replacementEquipment: null,
    replacementDate: null,
    resolutionDate: null,
    transaction: { id: 5, requestDatetime: '2026-08-01T02:00:00Z', createdAt: '2026-08-01T02:00:00Z', transactionStatus: 'For Resolution' },
    borrower: {
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      borrowerCategory: 'Student',
      collegeOrUnit: 'CCS',
      user: { id: 9, accountStatus: 'Active', save: jest.fn().mockResolvedValue() }
    },
    item: { itemCode: 'EQ-001-001', equipment: { equipmentName: 'Basketball', category: { categoryName: 'Basketball' } } },
    recordedByUser: { username: 'staff1' },
    verifiedByUser: null,
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockImplementation((cb) => cb({}));
});

describe('GET /api/damage-loss (list)', () => {
  test('serializes records without any fee information', async () => {
    DamageLossRecord.findAll.mockResolvedValueOnce([baseRecord()]);
    const res = mockRes();
    await ctrl.list({}, res);
    const row = res.json.mock.calls[0][0].data[0];
    expect(row).not.toHaveProperty('fee');
    expect(row.transactionCode).toBe('TN1-2026-0005');
    expect(row.dateReported).toBe('Aug 1, 2026');
  });

  test('the controller no longer exposes a fee-status endpoint', () => {
    expect(ctrl.updateFeeStatus).toBeUndefined();
  });
});

describe('PATCH /api/damage-loss/:id/flag', () => {
  test('flags the borrower without creating any fee, even if a feeAmount is sent', async () => {
    const record = baseRecord();
    DamageLossRecord.findByPk.mockResolvedValue(record);
    await ctrl.flag({ params: { id: 1 }, body: { feeAmount: 500 } }, mockRes());
    expect(record.borrower.user.accountStatus).toBe('Restricted');
    expect(models.MaintenanceFee).toBeUndefined();
    expect(notifyBorrower).toHaveBeenCalledWith(9, expect.not.stringContaining('₱'), 'Account Restricted');
  });
});

describe('PATCH /api/damage-loss/:id/resolve', () => {
  test('restores the unit to stock exactly once', async () => {
    const record = baseRecord({ resolutionStatus: 'Replacement Verified' });
    DamageLossRecord.findByPk.mockResolvedValue(record);
    DamageLossRecord.update.mockResolvedValueOnce([1]);
    const item = { equipmentId: 2, update: jest.fn().mockResolvedValue() };
    Item.findByPk.mockResolvedValue(item);
    DamageLossRecord.count.mockResolvedValue(1);
    Transaction.findByPk.mockResolvedValue({ id: 5, transactionStatus: 'Replacement' });

    await ctrl.resolve({ params: { id: 1 }, user: { id: 2 } }, mockRes());
    expect(Equipment.increment).toHaveBeenCalledTimes(1);
  });

  test('a repeated resolve (record already resolved concurrently) is a 409 and never touches stock', async () => {
    const record = baseRecord({ resolutionStatus: 'Replacement Verified' });
    DamageLossRecord.findByPk.mockResolvedValue(record);
    DamageLossRecord.update.mockResolvedValueOnce([0]);

    await expect(ctrl.resolve({ params: { id: 1 }, user: { id: 2 } }, mockRes())).rejects.toMatchObject({ statusCode: 409 });
    expect(Item.findByPk).not.toHaveBeenCalled();
    expect(Equipment.increment).not.toHaveBeenCalled();
  });
});
