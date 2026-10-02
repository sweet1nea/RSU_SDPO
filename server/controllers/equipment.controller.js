'use strict';

const path = require('path');
const { Op } = require('sequelize');
const { Equipment, Category, Item, TransactionDetail, sequelize } = require('../models');
const { getClient } = require('../config/supabase');
const { formatEquipmentCode, formatItemCode, maxSequence } = require('../helpers/equipmentCode');

const PHOTOS_BUCKET = process.env.SUPABASE_EQUIPMENT_PHOTOS_BUCKET || 'equipment-photos';

// Per-unit status breakdown. Available/Borrowed/Reserved are the only unit
// statuses in the system (Maintenance/Decommissioned were removed — see
// migration 022_remove_item_maintenance_status).
function statusCounts(items) {
  const counts = { Available: 0, Borrowed: 0, Reserved: 0 };
  (items || []).forEach((item) => {
    if (Object.prototype.hasOwnProperty.call(counts, item.availabilityStatus)) {
      counts[item.availabilityStatus] += 1;
    }
  });
  return counts;
}

// The photo URL carries the stored object's key as a version, so the
// browser cache (see downloadPhoto) is only ever reused for the exact same
// photo: a re-upload changes the URL, while stock changes from borrowing
// requests (which also touch this row) never do — the image a borrower
// sees can't flip between a cached and a fresh copy mid-request.
function photoUrlFor(equipment) {
  if (!equipment.photoPath) return null;
  return `/api/equipment/${equipment.id}/photo?v=${encodeURIComponent(path.basename(equipment.photoPath))}`;
}

function serialize(equipment) {
  const items = equipment.items;
  const counts = items ? statusCounts(items) : null;
  return {
    id: equipment.id,
    equipmentCode: formatEquipmentCode(equipment.category ? equipment.category.categoryName : null, equipment.equipmentName, equipment.id),
    equipmentName: equipment.equipmentName,
    categoryId: equipment.categoryId,
    category: equipment.category ? { id: equipment.category.id, categoryName: equipment.category.categoryName } : null,
    totalQuantity: equipment.totalQuantity,
    availableQuantity: equipment.availableQuantity,
    description: equipment.description,
    // Streamed back through downloadPhoto below — a pointer to that route,
    // not a direct storage URL, so the client never needs credentials.
    photoUrl: photoUrlFor(equipment),
    // Present only when units were loaded (list/getOne) — counted from each
    // unit's own status, so "Borrowed" never includes reserved units.
    ...(counts
      ? {
          statusCounts: counts,
          borrowedQuantity: counts.Borrowed,
          reservedQuantity: counts.Reserved,
          itemCodes: items.filter((i) => i.itemCode).map((i) => i.itemCode)
        }
      : {})
  };
}

const ITEM_ATTRIBUTES = ['id', 'itemCode', 'availabilityStatus'];

async function loadSerialized(id, options = {}) {
  const equipment = await Equipment.findByPk(id, {
    include: [
      { model: Category, as: 'category' },
      { model: Item, as: 'items', attributes: ITEM_ATTRIBUTES }
    ],
    ...options
  });
  return equipment ? serialize(equipment) : null;
}

function parseQuantity(value) {
  const qty = Number(value);
  return Number.isInteger(qty) ? qty : NaN;
}

// Creates `count` new Available units for an equipment, continuing its
// unit sequence. Each unit's code is the QR payload for that unit.
//
// `equipment` only needs to carry the fields the code's letter prefix is
// built from — { id, equipmentName, category? } — not a full model
// instance. Callers that already have the row loaded (with its category)
// pass it straight through; callers that only have an id/categoryId look
// up just the category name first, so this never re-fetches the equipment
// row itself (which some callers hold under a row lock — see
// exports.update and qr.controller.js#generate).
async function createUnits(equipment, count, t) {
  if (count <= 0) return [];
  const equipmentId = equipment.id;
  const categoryName = equipment.category ? equipment.category.categoryName : null;
  const existing = await Item.findAll({ where: { equipmentId }, attributes: ['itemCode'], transaction: t });
  const start = maxSequence(equipmentId, existing.map((i) => i.itemCode));
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({
      equipmentId,
      itemCode: formatItemCode(categoryName, equipment.equipmentName, equipmentId, start + i),
      itemCondition: 'Good',
      availabilityStatus: 'Available',
      engravingStatus: 'Not Engraved'
    });
  }
  return Item.bulkCreate(rows, { transaction: t });
}

exports.list = async (req, res) => {
  const rows = await Equipment.findAll({
    include: [
      { model: Category, as: 'category' },
      { model: Item, as: 'items', attributes: ITEM_ATTRIBUTES }
    ],
    order: [['equipmentName', 'ASC']]
  });
  res.json({ success: true, data: rows.map(serialize) });
};

exports.getOne = async (req, res) => {
  const data = await loadSerialized(req.params.id);
  if (!data) {
    const err = new Error('Equipment not found');
    err.statusCode = 404;
    throw err;
  }
  res.json({ success: true, data });
};

// The entered quantity IS the stock: every unit is registered (with its own
// QR item code) in the same database transaction that creates the
// equipment, so total and available stock both equal the quantity entered.
// Previously availableQuantity started at 0 until units were generated
// separately from QR Management, which is why new equipment showed 0 stock.
exports.create = async (req, res) => {
  const equipmentName = String(req.body.equipmentName || '').trim();
  const { categoryId, description } = req.body;
  const totalQuantity = parseQuantity(req.body.totalQuantity);
  if (!equipmentName || !categoryId || !Number.isInteger(totalQuantity) || totalQuantity < 1) {
    const err = new Error('equipmentName, categoryId, and a whole-number totalQuantity of at least 1 are required');
    err.statusCode = 400;
    throw err;
  }
  const category = await Category.findByPk(categoryId);
  if (!category) {
    const err = new Error('Selected category does not exist');
    err.statusCode = 400;
    throw err;
  }

  const created = await sequelize.transaction(async (t) => {
    const equipment = await Equipment.create(
      {
        equipmentName,
        categoryId,
        totalQuantity,
        availableQuantity: totalQuantity,
        description: description ? String(description).trim() || null : null
      },
      { transaction: t }
    );
    await createUnits({ id: equipment.id, equipmentName, category }, totalQuantity, t);
    return equipment;
  });

  res.status(201).json({ success: true, data: await loadSerialized(created.id) });
};

exports.update = async (req, res) => {
  const { equipmentName, categoryId, description } = req.body;
  const hasQuantity = req.body.totalQuantity !== undefined && req.body.totalQuantity !== null && req.body.totalQuantity !== '';
  const totalQuantity = hasQuantity ? parseQuantity(req.body.totalQuantity) : null;
  if (hasQuantity && (!Number.isInteger(totalQuantity) || totalQuantity < 1)) {
    const err = new Error('totalQuantity must be a whole number of at least 1');
    err.statusCode = 400;
    throw err;
  }
  if (equipmentName !== undefined && !String(equipmentName).trim()) {
    const err = new Error('Equipment name cannot be empty');
    err.statusCode = 400;
    throw err;
  }
  if (categoryId !== undefined && !(await Category.findByPk(categoryId))) {
    const err = new Error('Selected category does not exist');
    err.statusCode = 400;
    throw err;
  }

  await sequelize.transaction(async (t) => {
    const equipment = await Equipment.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!equipment) {
      const err = new Error('Equipment not found');
      err.statusCode = 404;
      throw err;
    }

    if (hasQuantity && totalQuantity !== equipment.totalQuantity) {
      const items = await Item.findAll({ where: { equipmentId: equipment.id }, transaction: t, lock: t.LOCK.UPDATE });
      const delta = totalQuantity - equipment.totalQuantity;
      if (delta > 0) {
        // More stock: register the additional units right away so they're
        // immediately borrowable. The equipment row itself was fetched
        // above under a row lock (FOR UPDATE) without its category
        // association — joining Category onto a locked row isn't safe in
        // Postgres, so the category name is looked up on its own here,
        // only when it's actually needed for the new units' codes.
        const category = equipment.categoryId ? await Category.findByPk(equipment.categoryId, { transaction: t }) : null;
        await createUnits({ id: equipment.id, equipmentName: equipment.equipmentName, category }, delta, t);
      } else {
        // Less stock. Some older records carry non-serviceable stock in their
        // total with no unit record behind it (see migration 023); that part
        // is reduced first. Beyond it, only units that are Available and
        // have never been part of a transaction can be retired — anything
        // borrowed, reserved, or with history stays for the audit trail.
        const unregistered = Math.max(equipment.totalQuantity - items.length, 0);
        const unitsToRemove = Math.max(-delta - unregistered, 0);
        if (unitsToRemove > 0) {
          const used = await TransactionDetail.findAll({
            where: { itemId: { [Op.in]: items.map((i) => i.id) } },
            attributes: ['itemId'],
            transaction: t
          });
          const usedIds = new Set(used.map((d) => d.itemId));
          // Available, never-borrowed units are only safe to actually
          // delete when they ALSO have no QR label on them yet. A unit
          // that's already stickered (PrintCo) or laser-engraved
          // (engravingStatus 'Engraved'/'Tagged') represents real,
          // already-spent physical labeling work — deleting its row would
          // silently orphan that label, so a later scan of the physical
          // sticker/engraving resolves to nothing (2026-10-01 system
          // audit). Those units are excluded from auto-removal entirely;
          // retiring one is a deliberate staff decision (delete the
          // specific unit from the equipment's unit list), not something
          // a quantity-number edit should do on its own.
          const eligible = items.filter((i) => i.availabilityStatus === 'Available' && !usedIds.has(i.id));
          const removable = eligible
            .filter((i) => i.engravingStatus === 'Not Engraved')
            .sort((a, b) => b.id - a.id)
            .slice(0, unitsToRemove);
          if (removable.length < unitsToRemove) {
            const labeledCount = eligible.length - eligible.filter((i) => i.engravingStatus === 'Not Engraved').length;
            const reason =
              labeledCount > 0
                ? `${labeledCount} of the remaining unit(s) already have a QR sticker or engraving and were kept — retire those from the unit list directly if they're no longer needed`
                : 'the other units are borrowed, reserved, or have transaction history';
            const err = new Error(`Total quantity can only be lowered to ${items.length - removable.length} — ${reason}.`);
            err.statusCode = 409;
            throw err;
          }
          await Item.destroy({ where: { id: removable.map((i) => i.id) }, transaction: t });
        }
      }
      const available = await Item.count({ where: { equipmentId: equipment.id, availabilityStatus: 'Available' }, transaction: t });
      equipment.totalQuantity = totalQuantity;
      equipment.availableQuantity = available;
    }
    if (equipmentName !== undefined) equipment.equipmentName = String(equipmentName).trim();
    if (categoryId !== undefined) equipment.categoryId = categoryId;
    if (description !== undefined) equipment.description = description ? String(description).trim() || null : null;

    await equipment.save({ transaction: t });
  });

  res.json({ success: true, data: await loadSerialized(req.params.id) });
};

// One real photo per equipment listing. Uploading a new photo overwrites
// the pointer (and therefore the photo URL's version); the old storage
// object is left in place.
exports.uploadPhoto = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment) {
    const err = new Error('Equipment not found');
    err.statusCode = 404;
    throw err;
  }

  const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const key = `equipment-${equipment.id}-${Date.now()}${ext}`;
  const { error } = await getClient()
    .storage.from(PHOTOS_BUCKET)
    .upload(key, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (error) {
    const err = new Error(`Failed to upload photo: ${error.message}`);
    err.statusCode = 502;
    throw err;
  }

  equipment.photoPath = key;
  await equipment.save();
  res.json({ success: true, data: await loadSerialized(equipment.id) });
};

exports.downloadPhoto = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment || !equipment.photoPath) {
    const err = new Error('This equipment has no photo on file');
    err.statusCode = 404;
    throw err;
  }

  let data, error;
  try {
    ({ data, error } = await getClient().storage.from(PHOTOS_BUCKET).download(equipment.photoPath));
  } catch (err) {
    // A thrown exception here (auth/network/service failure) is a different
    // problem than a genuinely missing file: log the real cause server-side
    // and tell the browser's <img onerror> fallback to quietly show the
    // category icon instead of flooding the console with an unexplained 500.
    console.error('[equipment] Photo storage download failed for', equipment.photoPath, '-', err.message);
    return res.status(502).json({ success: false, message: 'Could not load the photo from storage. Please try again in a moment.' });
  }
  if (error || !data) {
    if (error) console.error('[equipment] Photo storage download error for', equipment.photoPath, '-', error.message);
    return res.status(404).json({ success: false, message: 'Photo file is missing in storage' });
  }
  res.set('Content-Type', data.type || 'application/octet-stream');
  // Safe to cache: the URL is versioned by storage key (see photoUrlFor).
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(await data.arrayBuffer()));
};

exports.remove = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment) {
    const err = new Error('Equipment not found');
    err.statusCode = 404;
    throw err;
  }
  await sequelize.transaction(async (t) => {
    const items = await Item.findAll({ where: { equipmentId: equipment.id }, attributes: ['id', 'availabilityStatus'], transaction: t });
    const itemIds = items.map((i) => i.id);
    const usedCount = itemIds.length
      ? await TransactionDetail.count({ where: { itemId: { [Op.in]: itemIds } }, transaction: t })
      : 0;
    if (usedCount > 0 || items.some((i) => i.availabilityStatus !== 'Available')) {
      const err = new Error('Cannot delete — this equipment has borrowing history or units currently in use');
      err.statusCode = 409;
      throw err;
    }
    if (itemIds.length) await Item.destroy({ where: { id: itemIds }, transaction: t });
    await equipment.destroy({ transaction: t });
  });
  res.json({ success: true, data: { id: Number(req.params.id) } });
};

exports.createUnits = createUnits;
exports.serialize = serialize;
