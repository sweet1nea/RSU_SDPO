'use strict';

const { Op } = require('sequelize');
const {
  Transaction,
  TransactionDetail,
  Borrower,
  User,
  Item,
  Equipment,
  Category,
  TransactionLog,
  DamageLossRecord,
  sequelize
} = require('../models');
const { notifyBorrower, notifyRoles } = require('../helpers/notify');
const { logStatusChange } = require('../helpers/transactionLog');
const { formatDate, formatTime, parsePhtDateTime, toPhtWallClock, DAY_MS } = require('../helpers/dateHelper');
const { formatEquipmentCode } = require('../helpers/equipmentCode');
const { missingDocuments } = require('../constants/borrowerCategories');
const { STATUS, AWAITING_REVIEW } = require('../constants/transactionStatus');

const INCLUDE = [
  { model: Borrower, as: 'borrower', include: [{ model: User, as: 'user' }] },
  { model: User, as: 'reviewer' },
  { model: User, as: 'approver' },
  { model: User, as: 'documentsVerifier' },
  {
    model: TransactionDetail,
    as: 'details',
    include: [{ model: Item, as: 'item', include: [{ model: Equipment, as: 'equipment', include: [{ model: Category, as: 'category' }] }] }]
  },
  { model: TransactionLog, as: 'logs' }
];

function httpError(statusCode, message, code, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (details) err.details = details;
  return err;
}

// Availability-threshold borrowing caps, per the approved RSU SDPO spec:
//   > 5 available  = Green  = up to 2 units may be borrowed per request
//   4-5 available  = Yellow = only 1 unit may be borrowed per request
//   1-3 available  = Red    = borrowing not allowed
// plus a per-equipment minimum-stock floor at 15% of total quantity
// (project-leader decision, 2026-09-12; lowered from 25% to 15% on
// 2026-10-02). Enforced for self-service requests; staff-created walk-in
// transactions are left to staff judgment per spec.
function lowStockFloor(totalQuantity) {
  return Math.ceil(totalQuantity * 0.15);
}

function maxBorrowableUnits(availableQuantity, totalQuantity) {
  let cap;
  if (availableQuantity > 5) cap = 2;
  else if (availableQuantity >= 4) cap = 1;
  else cap = 0;

  if (Number.isFinite(totalQuantity) && totalQuantity > 0 && availableQuantity <= lowStockFloor(totalQuantity)) {
    cap = 0;
  }
  return cap;
}

// Late Return Policy: a borrower with equipment overdue more than this many
// days past its due date cannot submit new requests until it's returned.
const LATE_RETURN_GRACE_DAYS = 3;

async function getLateReturnBlock(borrowerId) {
  const cutoff = new Date(Date.now() - LATE_RETURN_GRACE_DAYS * DAY_MS);
  const overdue = await Transaction.findAll({
    where: {
      borrowerId,
      transactionStatus: STATUS.OVERDUE,
      expectedReturnDatetime: { [Op.lt]: cutoff }
    },
    order: [['expectedReturnDatetime', 'ASC']]
  });
  if (overdue.length === 0) return null;
  const oldest = overdue[0];
  const daysOverdue = Math.floor((Date.now() - new Date(oldest.expectedReturnDatetime).getTime()) / DAY_MS);
  return {
    count: overdue.length,
    graceDays: LATE_RETURN_GRACE_DAYS,
    daysOverdue,
    oldestTransactionId: oldest.id
  };
}

// Every reason this borrower may not submit a new request right now, each
// with a stable `code` the client uses to show the right warning. Evaluated
// server-side on every submission, so no client state (a refreshed page, an
// edited form, a direct API call) can skip it.
async function getBorrowingRestrictions(borrower, user) {
  const restrictions = [];

  if (user && user.accountStatus === 'Restricted') {
    restrictions.push({
      code: 'BORROWER_FLAGGED',
      message:
        'Your account is flagged by the SDPO because of a damaged or lost equipment report. New borrowing requests are not allowed until the SDPO lifts the flag — please visit the SDPO office.'
    });
  }

  const pendingReplacements = await DamageLossRecord.findAll({
    where: { borrowerId: borrower.id, resolutionStatus: { [Op.ne]: 'Resolved' } },
    include: [{ model: Item, as: 'item', include: [{ model: Equipment, as: 'equipment' }] }],
    order: [['id', 'ASC']]
  });
  if (pendingReplacements.length) {
    const names = pendingReplacements
      .map((r) => (r.item && r.item.equipment ? `${r.item.equipment.equipmentName} (${r.item.itemCode})` : `item #${r.itemId}`))
      .join(', ');
    restrictions.push({
      code: 'PENDING_REPLACEMENT',
      message: `You have ${pendingReplacements.length} item(s) that still require replacement: ${names}. Resolve the pending replacement with the SDPO before submitting a new request.`,
      records: pendingReplacements.map((r) => ({ id: r.id, transactionId: r.transactionId, status: r.resolutionStatus }))
    });
  }

  const lateBlock = await getLateReturnBlock(borrower.id);
  if (lateBlock) {
    restrictions.push({
      code: 'LATE_RETURN',
      message: `You have equipment overdue by ${lateBlock.daysOverdue} day(s) (Transaction #${lateBlock.oldestTransactionId}). New borrowing requests are blocked until all overdue equipment is returned.`,
      ...lateBlock
    });
  }

  return restrictions;
}

// Counterpart to the reservation done at request creation: gives still-
// Reserved units back to the available pool when a request is Rejected or
// Cancelled before release.
async function releaseReservedItems(txn, t) {
  const reserved = txn.details.filter((d) => d.item.availabilityStatus === 'Reserved');
  if (reserved.length === 0) return;
  await Item.update(
    { availabilityStatus: 'Available' },
    { where: { id: reserved.map((d) => d.item.id) }, transaction: t }
  );
  const byEquipment = {};
  reserved.forEach((d) => {
    byEquipment[d.item.equipmentId] = (byEquipment[d.item.equipmentId] || 0) + 1;
  });
  for (const [equipmentId, qty] of Object.entries(byEquipment)) {
    await Equipment.increment('availableQuantity', { by: qty, where: { id: equipmentId }, transaction: t });
  }
}

// Atomic, validated status change: the UPDATE only matches while the row is
// still in one of the allowed `from` statuses. Two concurrent clicks (or a
// stale page acting on an already-processed request) can therefore never
// both succeed — the second gets a 409 and none of its side effects
// (notifications, stock movements) run. This is also the single place the
// workflow's allowed transitions are enforced.
async function transition(txn, fromStatuses, toStatus, fields, t) {
  const changes = { transactionStatus: toStatus, ...(fields || {}) };
  const [count] = await Transaction.update(changes, {
    where: { id: txn.id, transactionStatus: { [Op.in]: fromStatuses } },
    transaction: t
  });
  if (!count) {
    throw httpError(
      409,
      `This request was already updated (it is no longer ${fromStatuses.map((s) => `"${s}"`).join(' or ')}). Refresh to see its current status.`,
      'STALE_STATUS'
    );
  }
  Object.assign(txn, changes);
  return txn;
}

function txnCode(t) {
  const year = toPhtWallClock(t.requestDatetime || t.createdAt).getUTCFullYear();
  return `TN${t.id}-${year}`;
}

// Most recent audit-trail entry reaching `newStatus` — shows *why* a request
// was rejected or when it was cancelled without a separate column.
function lastLogFor(t, newStatus) {
  const logs = (t.logs || []).filter((l) => l.newStatus === newStatus);
  if (logs.length === 0) return null;
  return logs.reduce((latest, l) => (new Date(l.changeDatetime) > new Date(latest.changeDatetime) ? l : latest));
}

// Dates are formatted in Philippine Time on the server (formatDate/
// formatTime) and also returned as ISO instants so clients can format them
// consistently without trusting their own clock/timezone.
function serialize(t) {
  const b = t.borrower;
  const firstItem = (t.details || [])[0];
  const rejectionLog = t.transactionStatus === STATUS.REJECTED ? lastLogFor(t, STATUS.REJECTED) : null;
  const cancellationLog = t.transactionStatus === STATUS.CANCELLED ? lastLogFor(t, STATUS.CANCELLED) : null;
  return {
    dbId: t.id,
    borrowerId: t.borrowerId,
    id: txnCode(t),
    date: formatDate(t.requestDatetime),
    time: formatTime(t.requestDatetime),
    name: b ? [b.firstName, b.lastName].filter(Boolean).join(' ') : 'Unknown Borrower',
    email: b && b.user ? b.user.emailAddress : '—',
    bsf: `BSF-${String(t.id).padStart(4, '0')}`,
    type: b ? b.borrowerCategory : '—',
    college: b ? b.collegeOrUnit : '—',
    purpose: t.purpose || '—',
    due: formatDate(t.expectedReturnDatetime),
    dueTime: formatTime(t.expectedReturnDatetime),
    returned: t.returnDatetime ? formatDate(t.returnDatetime) : null,
    status: t.transactionStatus,
    reason: rejectionLog ? rejectionLog.remarks : null,
    cancelledAt: cancellationLog ? formatDate(cancellationLog.changeDatetime) : null,
    receivedByBorrowerDatetime: t.receivedByBorrowerDatetime || null,
    review: t.reviewer ? t.reviewer.username : '—',
    approve: t.approver ? t.approver.username : '—',
    documentsVerified: !!t.documentsVerifiedDatetime,
    documentsVerifiedBy: t.documentsVerifier ? t.documentsVerifier.username : null,
    timestamps: {
      requested: t.requestDatetime || null,
      reviewed: t.reviewDatetime || null,
      documentsVerified: t.documentsVerifiedDatetime || null,
      approved: t.approvalDatetime || null,
      released: t.releaseDatetime || null,
      receivedByBorrower: t.receivedByBorrowerDatetime || null,
      returned: t.returnDatetime || null,
      expectedReturn: t.expectedReturnDatetime || null
    },
    category:
      firstItem && firstItem.item && firstItem.item.equipment && firstItem.item.equipment.category
        ? firstItem.item.equipment.category.categoryName
        : '—',
    items: (t.details || []).map((d) => ({
      code: d.item.itemCode,
      legacyCode: d.item.legacyItemCode || null,
      equipmentId: d.item.equipmentId,
      equipmentCode: formatEquipmentCode(d.item.equipmentId),
      name: d.item.equipment.equipmentName,
      category: d.item.equipment.category ? d.item.equipment.category.categoryName : null,
      photoUrl: d.item.equipment.photoPath
        ? `/api/equipment/${d.item.equipmentId}/photo?v=${encodeURIComponent(String(d.item.equipment.photoPath).split('/').pop())}`
        : null,
      returnedCondition: d.returnedCondition,
      conditionNotes: d.conditionNotes
    }))
  };
}

exports.list = async (req, res) => {
  const rows = await Transaction.findAll({ include: INCLUDE, order: [['requestDatetime', 'DESC']] });
  res.json({ success: true, data: rows.map(serialize) });
};

// Borrower-scoped list — a borrower only ever sees their own transactions.
exports.mine = async (req, res) => {
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  if (!borrower) {
    return res.json({ success: true, data: [] });
  }
  const rows = await Transaction.findAll({
    where: { borrowerId: borrower.id },
    include: INCLUDE,
    order: [['requestDatetime', 'DESC']]
  });
  res.json({ success: true, data: rows.map(serialize) });
};

// Lets the borrowing UI warn the borrower up front (flagged account,
// pending replacement, late return, incomplete profile) before they fill
// out a request. The same checks are enforced again in createSelfRequest.
exports.eligibility = async (req, res) => {
  const [borrower, user] = await Promise.all([
    Borrower.findOne({ where: { userId: req.user.id } }),
    User.findByPk(req.user.id)
  ]);
  if (!borrower) {
    return res.json({
      success: true,
      data: {
        canRequest: false,
        restrictions: [{ code: 'PROFILE_INCOMPLETE', message: 'Complete your borrower profile (name, college/unit, borrower type) in Settings before requesting equipment.' }]
      }
    });
  }
  const restrictions = await getBorrowingRestrictions(borrower, user);
  res.json({ success: true, data: { canRequest: restrictions.length === 0, restrictions } });
};

exports.create = async (req, res) => {
  const { borrowerId, itemIds, purpose } = req.body;
  if (!borrowerId || !Array.isArray(itemIds) || itemIds.length === 0) {
    throw httpError(400, 'borrowerId and a non-empty itemIds array are required');
  }
  const expectedReturnDatetime = parsePhtDateTime(req.body.expectedReturnDatetime);
  if (req.body.expectedReturnDatetime && !expectedReturnDatetime) {
    throw httpError(400, 'expectedReturnDatetime is not a valid date/time');
  }

  const borrower = await Borrower.findByPk(borrowerId, { include: [{ model: User, as: 'user' }] });
  if (!borrower) {
    throw httpError(404, 'Borrower not found');
  }
  // Same restrictions as self-service: staff can't create a transaction
  // for a flagged borrower or one with an unresolved replacement either.
  const restrictions = await getBorrowingRestrictions(borrower, borrower.user);
  if (restrictions.length) {
    throw httpError(403, restrictions[0].message, restrictions[0].code, { restrictions });
  }

  const created = await sequelize.transaction(async (t) => {
    // FOR UPDATE row-locks the chosen units so two concurrent requests can't
    // both reserve the same physical item.
    const items = await Item.findAll({ where: { id: itemIds }, transaction: t, lock: t.LOCK.UPDATE });
    if (items.length !== itemIds.length) {
      throw httpError(404, 'One or more selected items were not found');
    }
    const notAvailable = items.filter((i) => i.availabilityStatus !== 'Available');
    if (notAvailable.length > 0) {
      throw httpError(409, `These items are not available: ${notAvailable.map((i) => i.itemCode).join(', ')}`);
    }

    // Reserve immediately; availableQuantity moves at reservation time.
    await Item.update({ availabilityStatus: 'Reserved' }, { where: { id: items.map((i) => i.id) }, transaction: t });
    const byEquipment = {};
    items.forEach((i) => {
      byEquipment[i.equipmentId] = (byEquipment[i.equipmentId] || 0) + 1;
    });
    for (const [equipmentId, qty] of Object.entries(byEquipment)) {
      await Equipment.decrement('availableQuantity', { by: qty, where: { id: equipmentId }, transaction: t });
    }

    // Starts Acknowledged like a self-request; it still has to pass the
    // Admin/Staff document verification and Director approval steps.
    const txn = await Transaction.create(
      {
        borrowerId,
        purpose: purpose || null,
        expectedReturnDatetime,
        requestDatetime: new Date(),
        transactionStatus: STATUS.ACKNOWLEDGED,
        borrowerAcknowledged: true,
        acknowledgementTimestamp: new Date()
      },
      { transaction: t }
    );
    await TransactionDetail.bulkCreate(
      items.map((i) => ({ transactionId: txn.id, itemId: i.id })),
      { transaction: t }
    );
    return txn;
  });

  await logStatusChange(created.id, req.user.id, STATUS.ACKNOWLEDGED, STATUS.ACKNOWLEDGED, 'Request created by SDPO staff');
  const withIncludes = await Transaction.findByPk(created.id, { include: INCLUDE });
  res.status(201).json({ success: true, data: serialize(withIncludes) });
};

// Normalizes the client idempotency key: short, URL-safe, optional.
function normalizeRequestKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value).trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
    throw httpError(400, 'requestKey must be 8-64 letters, digits, "-" or "_"');
  }
  return key;
}

// Self-service request: the borrower picks equipment + quantity and the
// server assigns specific available units. borrowerId is always derived
// from the token, never trusted from the body.
exports.createSelfRequest = async (req, res) => {
  const { items, purpose } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'items (equipmentId + quantity) is required');
  }
  const requestKey = normalizeRequestKey(req.body.requestKey);

  const [borrower, user] = await Promise.all([
    Borrower.findOne({ where: { userId: req.user.id } }),
    User.findByPk(req.user.id)
  ]);
  if (!borrower) {
    throw httpError(403, 'Complete your borrower profile in Settings before submitting a borrowing request', 'PROFILE_INCOMPLETE');
  }

  // Idempotency: the same submission retried (double-click, network retry,
  // refresh-and-resubmit) returns the request it already created instead of
  // creating — and notifying about — a second one.
  if (requestKey) {
    const existing = await Transaction.findOne({ where: { borrowerId: borrower.id, requestKey }, include: INCLUDE });
    if (existing) {
      return res.status(200).json({ success: true, data: serialize(existing), duplicate: true });
    }
  }

  // Flagged borrower / pending replacement / late return — checked before
  // anything is created.
  const restrictions = await getBorrowingRestrictions(borrower, user);
  if (restrictions.length) {
    throw httpError(403, restrictions[0].message, restrictions[0].code, { restrictions });
  }

  const missing = missingDocuments(borrower);
  if (missing.length) {
    throw httpError(400, `Upload the required document(s) before submitting: ${missing.join(', ')}`, 'DOCUMENTS_MISSING', { missing });
  }

  const expectedReturnDatetime = parsePhtDateTime(req.body.expectedReturnDatetime);
  if (!expectedReturnDatetime) {
    throw httpError(400, 'A valid expected return date and time is required');
  }
  if (expectedReturnDatetime.getTime() <= Date.now()) {
    throw httpError(400, 'The expected return date and time must be in the future');
  }

  // Merge repeated lines for the same equipment so the per-request cap
  // can't be sidestepped by splitting a quantity across rows.
  const merged = new Map();
  for (const line of items) {
    const equipmentId = Number(line.equipmentId);
    const quantity = line.quantity === undefined ? 1 : Number(line.quantity);
    if (!Number.isInteger(equipmentId) || equipmentId < 1 || !Number.isInteger(quantity) || quantity < 1) {
      throw httpError(400, 'Each item needs a valid equipmentId and a whole-number quantity of at least 1');
    }
    merged.set(equipmentId, (merged.get(equipmentId) || 0) + quantity);
  }
  const lines = [...merged.entries()].map(([equipmentId, quantity]) => ({ equipmentId, quantity }));

  let created;
  try {
    created = await sequelize.transaction(async (t) => {
      const selectedItems = [];
      for (const { equipmentId, quantity } of lines) {
        // FOR UPDATE serializes concurrent requests for the same equipment.
        const equipment = await Equipment.findByPk(equipmentId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!equipment) {
          throw httpError(404, `Equipment #${equipmentId} not found`);
        }

        const cap = maxBorrowableUnits(equipment.availableQuantity, equipment.totalQuantity);
        if (quantity > cap) {
          const atFloor =
            cap === 0 &&
            Number.isFinite(equipment.totalQuantity) &&
            equipment.totalQuantity > 0 &&
            equipment.availableQuantity <= lowStockFloor(equipment.totalQuantity);
          throw httpError(
            409,
            atFloor
              ? `Warning: "${equipment.equipmentName}" can't be borrowed at this moment — only ${equipment.availableQuantity} of ${equipment.totalQuantity} left, at or below the SDPO's 15% minimum-stock threshold.`
              : cap === 0
                ? `"${equipment.equipmentName}" is low in stock (${equipment.availableQuantity} available) and can't be borrowed right now under the SDPO's minimum-stock guideline.`
                : `Only ${cap} unit(s) of "${equipment.equipmentName}" may be borrowed per request while stock is at ${equipment.availableQuantity} available (SDPO minimum-stock guideline).`
          );
        }

        const available = await Item.findAll({
          where: { equipmentId, availabilityStatus: 'Available' },
          order: [['id', 'ASC']],
          limit: quantity,
          lock: t.LOCK.UPDATE,
          transaction: t
        });
        if (available.length < quantity) {
          throw httpError(409, `Not enough stock for "${equipment.equipmentName}" — ${available.length} available, ${quantity} requested`);
        }

        await Item.update(
          { availabilityStatus: 'Reserved' },
          { where: { id: available.map((i) => i.id) }, transaction: t }
        );
        await equipment.decrement('availableQuantity', { by: quantity, transaction: t });
        selectedItems.push(...available);
      }

      const txn = await Transaction.create(
        {
          borrowerId: borrower.id,
          purpose: purpose ? String(purpose).trim() || null : null,
          expectedReturnDatetime,
          requestDatetime: new Date(),
          requestKey,
          transactionStatus: STATUS.ACKNOWLEDGED,
          borrowerAcknowledged: true,
          acknowledgementTimestamp: new Date()
        },
        { transaction: t }
      );
      await TransactionDetail.bulkCreate(
        selectedItems.map((i) => ({ transactionId: txn.id, itemId: i.id })),
        { transaction: t }
      );
      return txn;
    });
  } catch (err) {
    // Two copies of the same submission racing past the lookup above: the
    // unique (borrower_id, request_key) index rejects the second insert.
    if (requestKey && err && err.name === 'SequelizeUniqueConstraintError') {
      const existing = await Transaction.findOne({ where: { borrowerId: borrower.id, requestKey }, include: INCLUDE });
      if (existing) return res.status(200).json({ success: true, data: serialize(existing), duplicate: true });
    }
    throw err;
  }

  await logStatusChange(created.id, req.user.id, STATUS.ACKNOWLEDGED, STATUS.ACKNOWLEDGED, 'Request submitted by borrower');
  await notifyBorrower(
    req.user.id,
    `Your borrow request (Transaction #${created.id}) was submitted and is awaiting document review by SDPO staff.`,
    'Request Submitted',
    `txn-${created.id}-submitted`
  );
  // Admin/Staff review the documents first; the Director is notified only
  // once the request actually reaches them (see review()).
  await notifyRoles(
    ['Admin', 'Staff'],
    `New borrow request from ${[borrower.firstName, borrower.lastName].filter(Boolean).join(' ')} (Transaction #${created.id}) — submitted documents need review.`,
    'New Request',
    `txn-${created.id}-new-request`
  );

  const withIncludes = await Transaction.findByPk(created.id, { include: INCLUDE });
  res.status(201).json({ success: true, data: serialize(withIncludes) });
};

async function loadTransactionOr404(id) {
  const txn = await Transaction.findByPk(id, { include: INCLUDE });
  if (!txn) {
    throw httpError(404, 'Transaction not found');
  }
  return txn;
}

function assertStatus(txn, expected) {
  assertStatusIn(txn, [expected]);
}

function assertStatusIn(txn, expectedList) {
  if (!expectedList.includes(txn.transactionStatus)) {
    throw httpError(
      409,
      `This action requires the transaction to be ${expectedList.map((s) => `"${s}"`).join(' or ')} (it is currently "${txn.transactionStatus}")`
    );
  }
}

// Borrower withdraws their own request while it's still awaiting review.
exports.cancelSelfRequest = async (req, res) => {
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  const txn = await loadTransactionOr404(req.params.id);
  if (!borrower || txn.borrowerId !== borrower.id) {
    throw httpError(403, 'You do not have permission to cancel this request');
  }
  assertStatusIn(txn, AWAITING_REVIEW);
  const oldStatus = txn.transactionStatus;
  await sequelize.transaction(async (t) => {
    await transition(txn, AWAITING_REVIEW, STATUS.CANCELLED, {}, t);
    await releaseReservedItems(txn, t);
  });
  await logStatusChange(txn.id, req.user.id, oldStatus, STATUS.CANCELLED, 'Cancelled by borrower');
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Step 2 — Admin/Staff review of the borrower's submitted documents.
//   accept     → documents verified; request proceeds to the Director
//   correction → stays with the borrower to fix (status unchanged)
//   reject     → request rejected, reserved stock released
// A request can only reach the Director through 'accept', and 'accept'
// requires every document the borrower's type needs to be on file.
exports.review = async (req, res) => {
  const { action } = req.body;
  const remarks = req.body.remarks ? String(req.body.remarks).trim() : '';
  if (!['accept', 'correction', 'reject'].includes(action)) {
    throw httpError(400, 'action must be one of accept, correction, or reject');
  }

  const txn = await loadTransactionOr404(req.params.id);
  assertStatusIn(txn, AWAITING_REVIEW);
  const oldStatus = txn.transactionStatus;
  const now = new Date();
  const reviewFields = { reviewedBy: req.user.id, reviewDatetime: now };

  let nextStatus;
  if (action === 'accept') {
    const missing = missingDocuments(txn.borrower);
    if (missing.length) {
      throw httpError(
        409,
        `The borrower has not submitted all required documents (${missing.join(', ')}). Return the request for correction instead.`,
        'DOCUMENTS_MISSING',
        { missing }
      );
    }
    nextStatus = STATUS.FOR_APPROVAL;
    await transition(txn, AWAITING_REVIEW, nextStatus, {
      ...reviewFields,
      documentsVerifiedBy: req.user.id,
      documentsVerifiedDatetime: now
    });
  } else if (action === 'reject') {
    nextStatus = STATUS.REJECTED;
    await sequelize.transaction(async (t) => {
      await transition(txn, AWAITING_REVIEW, nextStatus, reviewFields, t);
      await releaseReservedItems(txn, t);
    });
  } else {
    nextStatus = STATUS.ACKNOWLEDGED;
    await transition(txn, AWAITING_REVIEW, nextStatus, reviewFields);
  }

  const log = await logStatusChange(
    txn.id,
    req.user.id,
    oldStatus,
    nextStatus,
    action === 'accept' ? `Documents verified${remarks ? ': ' + remarks : ''}` : remarks || null
  );

  if (txn.borrower && txn.borrower.user) {
    const message =
      action === 'accept'
        ? `Your submitted documents for Transaction #${txn.id} were verified. The request is now awaiting Director approval.`
        : action === 'reject'
          ? `Your borrow request (Transaction #${txn.id}) was rejected during review.${remarks ? ' Reason: ' + remarks : ''}`
          : `Your borrow request (Transaction #${txn.id}) needs correction before it can proceed.${remarks ? ' ' + remarks : ''}`;
    const key =
      action === 'accept'
        ? `txn-${txn.id}-documents-verified`
        : action === 'reject'
          ? `txn-${txn.id}-rejected`
          : `txn-${txn.id}-correction-${log && log.id ? log.id : now.getTime()}`;
    await notifyBorrower(txn.borrower.user.id, message, action === 'reject' ? 'Rejection' : 'Review', key);
  }
  if (action === 'accept') {
    const name = txn.borrower ? [txn.borrower.firstName, txn.borrower.lastName].filter(Boolean).join(' ') : 'a borrower';
    await notifyRoles(
      ['Director'],
      `Transaction #${txn.id} from ${name} passed document verification and is awaiting your approval.`,
      'Awaiting Approval',
      `txn-${txn.id}-awaiting-approval`
    );
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Step 3 — Director approval (Director/Admin only, enforced on the route).
exports.approve = async (req, res) => {
  const txn = await loadTransactionOr404(req.params.id);
  assertStatus(txn, STATUS.FOR_APPROVAL);
  if (!txn.documentsVerifiedDatetime) {
    throw httpError(409, 'Submitted documents must be verified by SDPO staff before the Director can approve this request', 'DOCUMENTS_NOT_VERIFIED');
  }
  await transition(txn, [STATUS.FOR_APPROVAL], STATUS.APPROVED, { approvedBy: req.user.id, approvalDatetime: new Date() });
  await logStatusChange(txn.id, req.user.id, STATUS.FOR_APPROVAL, STATUS.APPROVED);
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(
      txn.borrower.user.id,
      `Your borrow request (Transaction #${txn.id}) has been approved by the Director. Confirm receipt from your account when you pick up the equipment at the SDPO office.`,
      'Approval',
      `txn-${txn.id}-approved`
    );
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

exports.reject = async (req, res) => {
  const remarks = req.body.remarks ? String(req.body.remarks).trim() : '';
  const txn = await loadTransactionOr404(req.params.id);
  const allowed = [...AWAITING_REVIEW, STATUS.FOR_APPROVAL];
  assertStatusIn(txn, allowed);
  // Once a request reaches For Approval, only the Director (or Admin) decides.
  if (txn.transactionStatus === STATUS.FOR_APPROVAL && !['Director', 'Admin'].includes(req.user.userRole)) {
    throw httpError(403, 'Only a Director can reject a request that has reached the approval stage');
  }
  const oldStatus = txn.transactionStatus;
  await sequelize.transaction(async (t) => {
    await transition(txn, [oldStatus], STATUS.REJECTED, {}, t);
    await releaseReservedItems(txn, t);
  });
  await logStatusChange(txn.id, req.user.id, oldStatus, STATUS.REJECTED, remarks || null);
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(
      txn.borrower.user.id,
      `Your borrow request (Transaction #${txn.id}) was rejected.${remarks ? ' Reason: ' + remarks : ''}`,
      'Rejection',
      `txn-${txn.id}-rejected`
    );
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Codes on a transaction's units, accepting a pre-standardization label
// code (legacyItemCode) as the same unit.
function codeMatchesItem(code, item) {
  return code === item.itemCode || (!!item.legacyItemCode && code === item.legacyItemCode);
}

exports.release = async (req, res) => {
  const { itemCodes } = req.body;
  if (!Array.isArray(itemCodes) || itemCodes.length === 0) {
    throw httpError(400, 'itemCodes (the scanned item codes) is required');
  }

  const txn = await loadTransactionOr404(req.params.id);
  assertStatus(txn, STATUS.APPROVED);

  const scanned = itemCodes.map((c) => String(c).trim());
  const units = txn.details.map((d) => d.item);
  const allMatched =
    scanned.length === units.length &&
    units.every((item) => scanned.some((code) => codeMatchesItem(code, item))) &&
    scanned.every((code) => units.some((item) => codeMatchesItem(code, item)));
  if (!allMatched) {
    throw httpError(409, `Scanned items don't match this transaction. Expected: ${units.map((i) => i.itemCode).join(', ')}`);
  }

  const notReserved = txn.details.filter((d) => d.item.availabilityStatus !== 'Reserved');
  if (notReserved.length > 0) {
    throw httpError(
      409,
      `These items are no longer reserved for this transaction and can't be released: ${notReserved.map((d) => d.item.itemCode).join(', ')}`
    );
  }

  await sequelize.transaction(async (t) => {
    await transition(txn, [STATUS.APPROVED], STATUS.RELEASED, { releasedBy: req.user.id, releaseDatetime: new Date() }, t);
    // availableQuantity was already decremented at reservation time.
    for (const detail of txn.details) {
      await detail.item.update(
        { availabilityStatus: 'Borrowed', currentBorrowerId: txn.borrowerId },
        { transaction: t }
      );
    }
  });

  await logStatusChange(txn.id, req.user.id, STATUS.APPROVED, STATUS.RELEASED);
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(
      txn.borrower.user.id,
      `Equipment for your request (Transaction #${txn.id}) has been released to you. Please return it by ${formatDate(txn.expectedReturnDatetime)} ${formatTime(txn.expectedReturnDatetime)}.`,
      'Release',
      `txn-${txn.id}-released`
    );
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Final step for the damage/loss branch, once every record is Resolved
// (damageLoss.controller.js#resolve). Good returns complete automatically.
exports.complete = async (req, res) => {
  const txn = await loadTransactionOr404(req.params.id);
  assertStatus(txn, STATUS.RESOLVED);
  await transition(txn, [STATUS.RESOLVED], STATUS.COMPLETED);
  await logStatusChange(txn.id, req.user.id, STATUS.RESOLVED, STATUS.COMPLETED);
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(txn.borrower.user.id, `Transaction #${txn.id} has been marked Completed.`, 'Completed', `txn-${txn.id}-completed`);
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Shared with return.controller.js, damageLoss.controller.js and the reports.
exports.INCLUDE = INCLUDE;
exports.serialize = serialize;
exports.txnCode = txnCode;
exports.loadTransactionOr404 = loadTransactionOr404;
exports.assertStatus = assertStatus;
exports.assertStatusIn = assertStatusIn;
exports.transition = transition;
exports.codeMatchesItem = codeMatchesItem;
exports.getBorrowingRestrictions = getBorrowingRestrictions;
exports.maxBorrowableUnits = maxBorrowableUnits;
