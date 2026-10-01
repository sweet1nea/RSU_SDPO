'use strict';

// Verifies server/controllers/qr.controller.js#lookup, focused on a real gap
// found during the S7 Phase 3 QR/scan audit: the scan-result overlay
// (client/pages/scan.html) is supposed to show Due Date alongside Checkout
// Timestamp for a borrowed item, but the API response backing it never
// included the transaction's expectedReturnDatetime at all — only
// releaseDatetime/returnDatetime. Also covers the existing not-found path.

jest.mock('../../models', () => ({
  Item: { findOne: jest.fn(), findByPk: jest.fn() },
  Equipment: { increment: jest.fn(), decrement: jest.fn() },
  Category: {},
  Borrower: {},
  TransactionDetail: { count: jest.fn() },
  Transaction: {},
  sequelize: { transaction: jest.fn((cb) => cb({ LOCK: { UPDATE: 'UPDATE' } })) }
}));

const { Item, Equipment, TransactionDetail, sequelize } = require('../../models');
const ctrl = require('../../controllers/qr.controller');

function mockRes() {
  return { json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/qr/lookup/:itemCode (lookup)', () => {
  test('includes expectedReturnDatetime (Due Date) on the last transaction for a borrowed item', async () => {
    const item = {
      itemCode: 'BB-1-001',
      itemCondition: 'Good',
      availabilityStatus: 'Borrowed',
      equipment: { equipmentName: 'Basketball', category: { categoryName: 'Basketball' } },
      currentBorrower: { firstName: 'Juan', lastName: 'Dela Cruz', collegeOrUnit: 'CCS' },
      transactionDetails: [
        {
          transaction: {
            requestDatetime: '2026-08-20T00:00:00.000Z',
            transactionStatus: 'Released',
            releaseDatetime: '2026-08-21T09:00:00.000Z',
            returnDatetime: null,
            expectedReturnDatetime: '2026-08-28T17:00:00.000Z'
          }
        }
      ]
    };
    Item.findOne.mockResolvedValueOnce(item);

    const req = { params: { itemCode: 'BB-1-001' } };
    const res = mockRes();
    await ctrl.lookup(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.lastTransaction).toEqual(
      expect.objectContaining({ expectedReturnDatetime: '2026-08-28T17:00:00.000Z' })
    );
  });

  test('picks the most recent transaction by requestDatetime when an item has more than one', async () => {
    const item = {
      itemCode: 'BB-1-002',
      itemCondition: 'Good',
      availabilityStatus: 'Borrowed',
      equipment: { equipmentName: 'Basketball', category: null },
      currentBorrower: null,
      transactionDetails: [
        { transaction: { requestDatetime: '2026-01-01T00:00:00.000Z', transactionStatus: 'Completed', expectedReturnDatetime: '2026-01-05T00:00:00.000Z' } },
        { transaction: { requestDatetime: '2026-08-20T00:00:00.000Z', transactionStatus: 'Released', expectedReturnDatetime: '2026-08-28T00:00:00.000Z' } }
      ]
    };
    Item.findOne.mockResolvedValueOnce(item);

    const res = mockRes();
    await ctrl.lookup({ params: { itemCode: 'BB-1-002' } }, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.lastTransaction.expectedReturnDatetime).toBe('2026-08-28T00:00:00.000Z');
  });

  test('rejects with 404 when the Item Code is not recognized', async () => {
    Item.findOne.mockResolvedValueOnce(null);
    await expect(ctrl.lookup({ params: { itemCode: 'NOPE-000' } }, mockRes())).rejects.toMatchObject({
      statusCode: 404
    });
  });

  test('lastTransaction is null when the item has no transaction history', async () => {
    const item = {
      itemCode: 'BB-1-003',
      itemCondition: 'Good',
      availabilityStatus: 'Available',
      equipment: { equipmentName: 'Basketball', category: null },
      currentBorrower: null,
      transactionDetails: []
    };
    Item.findOne.mockResolvedValueOnce(item);

    const res = mockRes();
    await ctrl.lookup({ params: { itemCode: 'BB-1-003' } }, res);

    expect(res.json.mock.calls[0][0].data.lastTransaction).toBeNull();
  });

  // High #4 from the 2026-09-08 system audit: this route is intentionally
  // public/unauthenticated (any phone's default QR app or a USB scanner
  // needs it to work with no login), but Item Codes are low-entropy and
  // predictable — returning a borrower's full name let anyone who
  // photographed a sticker learn exactly who had it checked out.
  test('masks the current borrower to first name + last initial instead of a full name', async () => {
    const item = {
      itemCode: 'BB-1-004',
      itemCondition: 'Good',
      availabilityStatus: 'Borrowed',
      equipment: { equipmentName: 'Basketball', category: null },
      currentBorrower: { firstName: 'Juan', lastName: 'Dela Cruz', collegeOrUnit: 'CCS' },
      transactionDetails: []
    };
    Item.findOne.mockResolvedValueOnce(item);

    const res = mockRes();
    await ctrl.lookup({ params: { itemCode: 'BB-1-004' } }, res);

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.borrower.name).toBe('Juan D.');
    expect(payload.borrower.name).not.toContain('Dela Cruz');
    // collegeOrUnit is low-sensitivity/aggregate — left as-is, still useful
    // context for staff without identifying the individual.
    expect(payload.borrower.collegeOrUnit).toBe('CCS');
  });

  test('borrower is null (not masked-empty) when the item currently has no borrower', async () => {
    const item = {
      itemCode: 'BB-1-005',
      itemCondition: 'Good',
      availabilityStatus: 'Available',
      equipment: { equipmentName: 'Basketball', category: null },
      currentBorrower: null,
      transactionDetails: []
    };
    Item.findOne.mockResolvedValueOnce(item);

    const res = mockRes();
    await ctrl.lookup({ params: { itemCode: 'BB-1-005' } }, res);

    expect(res.json.mock.calls[0][0].data.borrower).toBeNull();
  });
});

// PATCH /api/qr/items/:id/status (updateItemStatus) and its tests were
// removed 2026-09-14 along with the Maintenance/Decommissioned Item
// statuses themselves, per the SDPO's own revised requirements — see
// migration 022_remove_item_maintenance_status.

// DELETE /api/qr/items/:id (deleteItem) — added 2026-10-02 so staff can
// retire a single generated QR code/unit directly from QR Management,
// instead of only ever being able to lower an equipment's total quantity
// (which deliberately skips already-labeled units — see
// equipment.controller.js#update).
describe('DELETE /api/qr/items/:id (deleteItem)', () => {
  function mockItem(overrides) {
    return {
      id: 7,
      equipmentId: 3,
      availabilityStatus: 'Available',
      destroy: jest.fn().mockResolvedValue(),
      ...overrides
    };
  }

  test('deletes an Available, never-used unit and decrements the equipment counts', async () => {
    const item = mockItem();
    Item.findByPk.mockResolvedValueOnce(item);
    TransactionDetail.count.mockResolvedValueOnce(0);

    const res = mockRes();
    await ctrl.deleteItem({ params: { id: '7' } }, res);

    expect(item.destroy).toHaveBeenCalled();
    expect(Equipment.decrement).toHaveBeenCalledWith(
      { totalQuantity: 1, availableQuantity: 1 },
      expect.objectContaining({ where: { id: 3 } })
    );
    expect(res.json.mock.calls[0][0]).toEqual({ success: true, data: { equipmentId: 3 } });
  });

  test('rejects with 404 when the item does not exist', async () => {
    Item.findByPk.mockResolvedValueOnce(null);
    await expect(ctrl.deleteItem({ params: { id: '999' } }, mockRes())).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects with 409 when the unit is not Available (e.g. Borrowed)', async () => {
    const item = mockItem({ availabilityStatus: 'Borrowed' });
    Item.findByPk.mockResolvedValueOnce(item);

    await expect(ctrl.deleteItem({ params: { id: '7' } }, mockRes())).rejects.toMatchObject({ statusCode: 409 });
    expect(item.destroy).not.toHaveBeenCalled();
  });

  test('rejects with 409 when the unit has transaction history', async () => {
    const item = mockItem();
    Item.findByPk.mockResolvedValueOnce(item);
    TransactionDetail.count.mockResolvedValueOnce(2);

    await expect(ctrl.deleteItem({ params: { id: '7' } }, mockRes())).rejects.toMatchObject({ statusCode: 409 });
    expect(item.destroy).not.toHaveBeenCalled();
  });
});
