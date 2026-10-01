'use strict';

// Regression coverage for "newly added equipment shows stock = 0": the
// entered quantity must become both the total and the available stock, with
// one unit (and QR item code) registered per unit of stock, and the item
// codes must carry the same Equipment ID as the equipment record.

jest.mock('../../models', () => ({
  Equipment: { create: jest.fn(), findByPk: jest.fn() },
  Category: { findByPk: jest.fn() },
  Item: { findAll: jest.fn(), bulkCreate: jest.fn(), count: jest.fn(), destroy: jest.fn() },
  TransactionDetail: { findAll: jest.fn(), count: jest.fn() },
  sequelize: { transaction: jest.fn() }
}));
jest.mock('../../config/supabase', () => ({ getClient: jest.fn() }));

const { Equipment, Category, Item, TransactionDetail, sequelize } = require('../../models');
const ctrl = require('../../controllers/equipment.controller');
const { formatEquipmentCode, formatItemCode, parseItemCode, maxSequence } = require('../../helpers/equipmentCode');

const fakeT = { LOCK: { UPDATE: 'UPDATE' } };

function mockRes() {
  return { json: jest.fn(), status: jest.fn().mockReturnThis() };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockImplementation((cb) => cb(fakeT));
  Category.findByPk.mockResolvedValue({ id: 2, categoryName: 'Volleyball' });
  Item.findAll.mockResolvedValue([]);
  Item.bulkCreate.mockImplementation(async (rows) => rows.map((r, i) => ({ id: 100 + i, ...r })));
});

describe('helpers/equipmentCode.js', () => {
  test('Equipment ID and item codes share the same prefix', () => {
    expect(formatEquipmentCode(5)).toBe('EQ-005');
    expect(formatItemCode(5, 1)).toBe('EQ-005-001');
    expect(formatItemCode(1234, 12)).toBe('EQ-1234-012');
    expect(parseItemCode('EQ-005-001')).toEqual({ equipmentId: 5, sequence: 1 });
    expect(parseItemCode('BSK-5-001')).toBeNull();
    expect(maxSequence(5, ['EQ-005-001', 'EQ-005-007', 'EQ-006-009', 'BSK-5-010'])).toBe(7);
  });
});

describe('POST /api/equipment (create)', () => {
  test('total AND available stock equal the entered quantity, with one unit per stock', async () => {
    Equipment.create.mockResolvedValue({ id: 5 });
    Equipment.findByPk.mockResolvedValue({
      id: 5,
      equipmentName: 'Mikasa V200W',
      categoryId: 2,
      totalQuantity: 8,
      availableQuantity: 8,
      category: { id: 2, categoryName: 'Volleyball' },
      items: Array.from({ length: 8 }, (_, i) => ({ id: i, itemCode: formatItemCode(5, i + 1), availabilityStatus: 'Available' }))
    });
    const res = mockRes();

    await ctrl.create({ body: { equipmentName: ' Mikasa V200W ', categoryId: 2, totalQuantity: '8' } }, res);

    expect(Equipment.create).toHaveBeenCalledWith(
      expect.objectContaining({ equipmentName: 'Mikasa V200W', totalQuantity: 8, availableQuantity: 8 }),
      { transaction: fakeT }
    );
    const units = Item.bulkCreate.mock.calls[0][0];
    expect(units).toHaveLength(8);
    expect(units[0]).toMatchObject({ equipmentId: 5, itemCode: 'EQ-005-001', availabilityStatus: 'Available' });
    expect(units[7].itemCode).toBe('EQ-005-008');

    expect(res.status).toHaveBeenCalledWith(201);
    const data = res.json.mock.calls[0][0].data;
    expect(data).toMatchObject({ equipmentCode: 'EQ-005', totalQuantity: 8, availableQuantity: 8, borrowedQuantity: 0 });
    expect(data.itemCodes.every((c) => c.startsWith(data.equipmentCode + '-'))).toBe(true);
  });

  test.each([['0'], ['-3'], ['2.5'], ['abc'], [undefined]])('rejects a quantity of %p', async (qty) => {
    await expect(
      ctrl.create({ body: { equipmentName: 'Ball', categoryId: 2, totalQuantity: qty } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(Equipment.create).not.toHaveBeenCalled();
  });

  test('rejects an unknown category', async () => {
    Category.findByPk.mockResolvedValue(null);
    await expect(
      ctrl.create({ body: { equipmentName: 'Ball', categoryId: 99, totalQuantity: 3 } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('PUT /api/equipment/:id (update quantity)', () => {
  function equipmentRow(overrides) {
    return { id: 5, totalQuantity: 4, availableQuantity: 4, save: jest.fn().mockResolvedValue(), ...overrides };
  }

  test('raising the total registers the extra units immediately', async () => {
    const eq = equipmentRow();
    Equipment.findByPk.mockResolvedValueOnce(eq).mockResolvedValueOnce({ ...eq, category: null, items: [] });
    Item.findAll
      .mockResolvedValueOnce([1, 2, 3, 4].map((n) => ({ id: n, itemCode: formatItemCode(5, n), availabilityStatus: 'Available' })))
      .mockResolvedValueOnce([1, 2, 3, 4].map((n) => ({ itemCode: formatItemCode(5, n) })));
    Item.count.mockResolvedValue(6);

    await ctrl.update({ params: { id: 5 }, body: { totalQuantity: 6 } }, mockRes());

    const units = Item.bulkCreate.mock.calls[0][0];
    expect(units.map((u) => u.itemCode)).toEqual(['EQ-005-005', 'EQ-005-006']);
    expect(eq.totalQuantity).toBe(6);
    expect(eq.availableQuantity).toBe(6);
  });

  test('lowering the total cannot remove borrowed or used units', async () => {
    const eq = equipmentRow({ totalQuantity: 2, availableQuantity: 1 });
    Equipment.findByPk.mockResolvedValueOnce(eq);
    Item.findAll.mockResolvedValueOnce([
      { id: 1, availabilityStatus: 'Borrowed' },
      { id: 2, availabilityStatus: 'Available' }
    ]);
    TransactionDetail.findAll.mockResolvedValueOnce([{ itemId: 2 }]);

    await expect(ctrl.update({ params: { id: 5 }, body: { totalQuantity: 1 } }, mockRes())).rejects.toMatchObject({ statusCode: 409 });
    expect(Item.destroy).not.toHaveBeenCalled();
  });

  // 2026-10-01 system audit: lowering totalQuantity used to pick ANY
  // Available, never-borrowed unit to retire — including one that already
  // has a real QR sticker or laser engraving on it, silently orphaning
  // that physical label. Available-and-unused units without a label are
  // still fair game; labeled ones must be skipped.
  test('lowering the total skips Available units that already have a QR label, even though they were never borrowed', async () => {
    const eq = equipmentRow({ totalQuantity: 3, availableQuantity: 3 });
    Equipment.findByPk.mockResolvedValueOnce(eq);
    Item.findAll.mockResolvedValueOnce([
      { id: 1, availabilityStatus: 'Available', engravingStatus: 'Engraved' },
      { id: 2, availabilityStatus: 'Available', engravingStatus: 'Not Engraved' },
      { id: 3, availabilityStatus: 'Available', engravingStatus: 'Tagged' }
    ]);
    TransactionDetail.findAll.mockResolvedValueOnce([]);
    Item.count.mockResolvedValue(2);

    await ctrl.update({ params: { id: 5 }, body: { totalQuantity: 2 } }, mockRes());

    // Only the one unlabeled unit (id 2) was eligible, and exactly it was removed.
    expect(Item.destroy).toHaveBeenCalledWith({ where: { id: [2] }, transaction: fakeT });
  });

  test('lowering the total rejects with a specific message when only labeled units remain to retire', async () => {
    const eq = equipmentRow({ totalQuantity: 2, availableQuantity: 2 });
    Equipment.findByPk.mockResolvedValueOnce(eq);
    Item.findAll.mockResolvedValueOnce([
      { id: 1, availabilityStatus: 'Available', engravingStatus: 'Engraved' },
      { id: 2, availabilityStatus: 'Available', engravingStatus: 'Tagged' }
    ]);
    TransactionDetail.findAll.mockResolvedValueOnce([]);

    await expect(ctrl.update({ params: { id: 5 }, body: { totalQuantity: 1 } }, mockRes())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('already have a QR sticker or engraving')
    });
    expect(Item.destroy).not.toHaveBeenCalled();
  });
});
