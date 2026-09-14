'use strict';

const path = require('path');
const { Equipment, Category, Item } = require('../models');
const { getClient } = require('../config/supabase');

const PHOTOS_BUCKET = process.env.SUPABASE_EQUIPMENT_PHOTOS_BUCKET || 'equipment-photos';

// Per-unit status breakdown (Available/Borrowed/Reserved). Originally also
// tracked Maintenance/Decommissioned (migration 021), removed 2026-09-14
// per the SDPO's own revised requirements alongside those two Item statuses
// themselves — see migration 022_remove_item_maintenance_status.
const ITEM_STATUSES = ['Available', 'Borrowed', 'Reserved'];
function statusCounts(items) {
  const counts = { Available: 0, Borrowed: 0, Reserved: 0 };
  (items || []).forEach((item) => {
    if (Object.prototype.hasOwnProperty.call(counts, item.availabilityStatus)) {
      counts[item.availabilityStatus] += 1;
    }
  });
  return counts;
}

function serialize(equipment) {
  return {
    id: equipment.id,
    equipmentName: equipment.equipmentName,
    categoryId: equipment.categoryId,
    category: equipment.category ? { id: equipment.category.id, categoryName: equipment.category.categoryName } : null,
    totalQuantity: equipment.totalQuantity,
    availableQuantity: equipment.availableQuantity,
    description: equipment.description,
    // The actual bytes live in Supabase Storage (private bucket, same
    // pattern as borrower documents) and are streamed back through
    // downloadPhoto below — this is just a pointer to that route, not a
    // direct storage URL, so the client never needs its own credentials.
    photoUrl: equipment.photoPath ? `/api/equipment/${equipment.id}/photo` : null,
    // Present only when items were actually loaded (list/getOne below) —
    // callers that don't need the breakdown (create/update responses)
    // simply won't see this key rather than a misleadingly-all-zero one.
    ...(equipment.items ? { statusCounts: statusCounts(equipment.items) } : {})
  };
}

exports.list = async (req, res) => {
  const rows = await Equipment.findAll({
    include: [{ model: Category, as: 'category' }, { model: Item, as: 'items', attributes: ['id', 'availabilityStatus'] }],
    order: [['equipmentName', 'ASC']]
  });
  res.json({ success: true, data: rows.map(serialize) });
};

exports.getOne = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id, {
    include: [{ model: Category, as: 'category' }, { model: Item, as: 'items', attributes: ['id', 'availabilityStatus'] }]
  });
  if (!equipment) {
    const err = new Error('Equipment not found');
    err.statusCode = 404;
    throw err;
  }
  res.json({ success: true, data: serialize(equipment) });
};

exports.create = async (req, res) => {
  const { equipmentName, categoryId, totalQuantity, description } = req.body;
  if (!equipmentName || !categoryId || !totalQuantity || Number(totalQuantity) < 1) {
    const err = new Error('equipmentName, categoryId, and a totalQuantity of at least 1 are required');
    err.statusCode = 400;
    throw err;
  }
  // availableQuantity starts at 0, not totalQuantity — no physical items exist
  // for this equipment until they're actually QR-registered via QR Management
  // (see qr.controller.js#generate, which increments this as items are created).
  const created = await Equipment.create({
    equipmentName,
    categoryId,
    totalQuantity,
    availableQuantity: 0,
    description: description || null
  });
  const withCategory = await Equipment.findByPk(created.id, { include: [{ model: Category, as: 'category' }] });
  res.status(201).json({ success: true, data: serialize(withCategory) });
};

exports.update = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment) {
    const err = new Error('Equipment not found');
    err.statusCode = 404;
    throw err;
  }
  const { equipmentName, categoryId, totalQuantity, description } = req.body;

  if (totalQuantity !== undefined) {
    const issued = equipment.totalQuantity - equipment.availableQuantity;
    if (Number(totalQuantity) < issued) {
      const err = new Error(`Total quantity cannot be less than ${issued} — that many items are already issued`);
      err.statusCode = 400;
      throw err;
    }
    // Raising totalQuantity only raises the ceiling — the new capacity isn't
    // actually available until items are QR-registered for it (same reason
    // create() no longer pre-fills availableQuantity). Lowering it does
    // reduce availableQuantity, since that capacity is being removed outright.
    const delta = Number(totalQuantity) - equipment.totalQuantity;
    if (delta < 0) equipment.availableQuantity = Math.max(equipment.availableQuantity + delta, 0);
    equipment.totalQuantity = totalQuantity;
  }
  if (equipmentName !== undefined) equipment.equipmentName = equipmentName;
  if (categoryId !== undefined) equipment.categoryId = categoryId;
  if (description !== undefined) equipment.description = description;

  await equipment.save();
  const withCategory = await Equipment.findByPk(equipment.id, { include: [{ model: Category, as: 'category' }] });
  res.json({ success: true, data: serialize(withCategory) });
};

// A real photo per equipment listing (type-level — the Showroom and admin
// inventory view both group by Equipment, not by individual physical Item,
// so one photo per listing is what "thumbnail previews" in the S7 backlog
// meant in practice). Uploading a new photo overwrites the pointer; the old
// storage object is left in place rather than deleted (same trade-off the
// borrower-document uploads already make — storage cleanup isn't wired up
// anywhere in this codebase yet).
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
  const withCategory = await Equipment.findByPk(equipment.id, { include: [{ model: Category, as: 'category' }] });
  res.json({ success: true, data: serialize(withCategory) });
};

exports.downloadPhoto = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment || !equipment.photoPath) {
    const err = new Error('This equipment has no photo on file');
    err.statusCode = 404;
    throw err;
  }

  const { data, error } = await getClient().storage.from(PHOTOS_BUCKET).download(equipment.photoPath);
  if (error || !data) {
    return res.status(404).json({ success: false, message: 'Photo file is missing in storage' });
  }
  res.set('Content-Type', data.type || 'application/octet-stream');
  // Photos are small and shown on every Showroom card load — safe to let
  // the browser cache them for a while; a re-upload gets a brand-new
  // storage key (see uploadPhoto above), so this can never serve stale
  // bytes under the same URL.
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(await data.arrayBuffer()));
};

exports.remove = async (req, res) => {
  const equipment = await Equipment.findByPk(req.params.id);
  if (!equipment) {
    const err = new Error('Equipment not found');
    err.statusCode = 404;
    throw err;
  }
  const itemCount = await Item.count({ where: { equipmentId: equipment.id } });
  if (itemCount > 0) {
    const err = new Error(`Cannot delete — ${itemCount} item(s)/QR code(s) already exist for this equipment`);
    err.statusCode = 409;
    throw err;
  }
  await equipment.destroy();
  res.json({ success: true, data: { id: Number(req.params.id) } });
};
