'use strict';

const { Op } = require('sequelize');
const { Item, Equipment, Category, Borrower, TransactionDetail, Transaction, sequelize } = require('../models');
const { formatEquipmentCode } = require('../helpers/equipmentCode');
const { createUnits } = require('./equipment.controller');

function serializeItem(item) {
  const equipmentName = item.equipment ? item.equipment.equipmentName : null;
  const category = item.equipment && item.equipment.category ? item.equipment.category.categoryName : null;
  return {
    id: item.id,
    code: item.itemCode,
    legacyCode: item.legacyItemCode || null,
    condition: item.itemCondition,
    status: item.availabilityStatus,
    engravingStatus: item.engravingStatus,
    createdAt: item.createdAt,
    equipmentId: item.equipmentId,
    equipmentCode: formatEquipmentCode(category, equipmentName, item.equipmentId),
    equipmentName,
    category
  };
}

// Resolves a scanned/entered code to its unit. Canonical codes are tried
// first; a code printed before codes were standardized (migration 023)
// still resolves to the same unit through legacyItemCode.
function whereCode(code) {
  const value = String(code || '').trim();
  return { [Op.or]: [{ itemCode: value }, { legacyItemCode: value }] };
}

exports.listItems = async (req, res) => {
  const rows = await Item.findAll({
    include: [{ model: Equipment, as: 'equipment', include: [{ model: Category, as: 'category' }] }],
    order: [['createdAt', 'DESC']]
  });
  res.json({ success: true, data: rows.map(serializeItem) });
};

exports.generate = async (req, res) => {
  const { equipmentId, quantity } = req.body;
  const qty = Number(quantity);
  if (!equipmentId || !Number.isInteger(qty) || qty < 1) {
    const err = new Error('equipmentId and a whole-number quantity of at least 1 are required');
    err.statusCode = 400;
    throw err;
  }

  // Equipment created through Equipment Management already gets one unit
  // per unit of stock. This only registers units an equipment record is
  // still missing (total quantity not yet backed by unit records), using
  // the same canonical "<Equipment ID>-<sequence>" codes.
  const createdIds = await sequelize.transaction(async (t) => {
    const equipment = await Equipment.findByPk(equipmentId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!equipment) {
      const err = new Error('Equipment not found');
      err.statusCode = 404;
      throw err;
    }
    const existingCount = await Item.count({ where: { equipmentId }, transaction: t });
    const remaining = equipment.totalQuantity - existingCount;
    if (qty > remaining) {
      const err = new Error(
        `Only ${Math.max(remaining, 0)} more item(s) can be generated for "${equipment.equipmentName}" ` +
          `(total quantity is ${equipment.totalQuantity}, ${existingCount} already exist)`
      );
      err.statusCode = 400;
      throw err;
    }

    // Same locked-row-plus-separate-category-lookup reasoning as
    // equipment.controller.js#update — see the comment there.
    const category = equipment.categoryId ? await Category.findByPk(equipment.categoryId, { transaction: t }) : null;
    const created = await createUnits({ id: equipment.id, equipmentName: equipment.equipmentName, category }, qty, t);
    // New units are Available, so they count toward available stock.
    await Equipment.increment('availableQuantity', { by: qty, where: { id: equipment.id }, transaction: t });
    return created.map((i) => i.id);
  });

  const withEquipment = await Item.findAll({
    where: { id: createdIds },
    include: [{ model: Equipment, as: 'equipment', include: [{ model: Category, as: 'category' }] }]
  });
  res.status(201).json({ success: true, data: withEquipment.map(serializeItem) });
};

// A manual "Maintenance"/"Decommissioned" status change used to live here
// (PATCH /api/qr/items/:id/status), letting staff pull a single physical
// unit out of the lending pool for repair or permanent retirement. Removed
// 2026-09-14 per the SDPO's own revised requirements, along with the two
// Item statuses themselves (see migration
// 022_remove_item_maintenance_status). Every remaining status
// (Available/Borrowed/Reserved) is set only by the real borrow/return
// workflow, so there is nothing left for a manual endpoint to do.

// This lookup route is intentionally public (no auth) so a QR sticker
// scanned by any phone camera, default QR app, or USB scanner resolves —
// but Item Codes are low-entropy and predictable (e.g. "BB-5-001"), so
// they're easy to enumerate. Returning a borrower's full name here would let
// anyone who just photographs a sticker learn exactly who has that item
// checked out, with no login at all. Masked to first name + last initial —
// enough for SDPO staff who already know their borrowers to recognize who
// has an item, without exposing a full name to an unauthenticated scan.
function maskBorrowerName(firstName, lastName) {
  const first = String(firstName || '').trim();
  const lastInitial = String(lastName || '').trim().charAt(0);
  return [first, lastInitial ? lastInitial + '.' : ''].filter(Boolean).join(' ') || 'Borrower';
}

exports.lookup = async (req, res) => {
  const item = await Item.findOne({
    where: whereCode(req.params.itemCode),
    include: [
      { model: Equipment, as: 'equipment', include: [{ model: Category, as: 'category' }] },
      { model: Borrower, as: 'currentBorrower' },
      { model: TransactionDetail, as: 'transactionDetails', include: [{ model: Transaction, as: 'transaction' }] }
    ]
  });

  if (!item) {
    const err = new Error('Item Code not recognized');
    err.statusCode = 404;
    throw err;
  }

  const latestDetail = (item.transactionDetails || []).reduce((latest, d) => {
    const dTime = d.transaction ? new Date(d.transaction.requestDatetime || 0).getTime() : 0;
    const latestTime = latest && latest.transaction ? new Date(latest.transaction.requestDatetime || 0).getTime() : -1;
    return dTime > latestTime ? d : latest;
  }, null);

  res.json({
    success: true,
    data: {
      code: item.itemCode,
      scannedCode: String(req.params.itemCode),
      equipmentId: item.equipmentId,
      equipmentCode: formatEquipmentCode(item.equipment.category ? item.equipment.category.categoryName : null, item.equipment.equipmentName, item.equipmentId),
      name: item.equipment.equipmentName,
      category: item.equipment.category ? item.equipment.category.categoryName : null,
      condition: item.itemCondition,
      status: item.availabilityStatus,
      borrower: item.currentBorrower
        ? { name: maskBorrowerName(item.currentBorrower.firstName, item.currentBorrower.lastName), collegeOrUnit: item.currentBorrower.collegeOrUnit }
        : null,
      lastTransaction:
        latestDetail && latestDetail.transaction
          ? {
              status: latestDetail.transaction.transactionStatus,
              releaseDatetime: latestDetail.transaction.releaseDatetime,
              returnDatetime: latestDetail.transaction.returnDatetime,
              expectedReturnDatetime: latestDetail.transaction.expectedReturnDatetime
            }
          : null
    }
  });
};

// Deletes a single generated QR code (an Item/unit row), requested directly
// from QR Management — e.g. one generated by mistake, or for a unit that's
// being physically retired. Deliberately separate from (and less cautious
// than) the auto-removal that equipment.controller.js#update does when
// lowering total quantity: that path skips already-labeled units on
// purpose, because retiring a specific labeled unit should be a deliberate
// staff action here, not an automatic side effect of changing a number.
// Still blocked for a unit that's in use or has transaction history, so the
// audit trail and any physically-reserved/borrowed unit are never silently
// orphaned.
exports.deleteItem = async (req, res) => {
  const result = await sequelize.transaction(async (t) => {
    const item = await Item.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!item) {
      const err = new Error('QR code not found');
      err.statusCode = 404;
      throw err;
    }
    if (item.availabilityStatus !== 'Available') {
      const err = new Error(`This unit is currently ${item.availabilityStatus} and can't be deleted — only Available units can be removed.`);
      err.statusCode = 409;
      throw err;
    }
    const usedCount = await TransactionDetail.count({ where: { itemId: item.id }, transaction: t });
    if (usedCount > 0) {
      const err = new Error("This unit has transaction history and can't be deleted — it stays on record for the audit trail.");
      err.statusCode = 409;
      throw err;
    }
    const equipmentId = item.equipmentId;
    await item.destroy({ transaction: t });
    await Equipment.decrement({ totalQuantity: 1, availableQuantity: 1 }, { where: { id: equipmentId }, transaction: t });
    return { equipmentId };
  });
  res.json({ success: true, data: result });
};
