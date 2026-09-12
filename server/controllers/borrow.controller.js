'use strict';

const { Op } = require('sequelize');
const { Transaction, TransactionDetail, Borrower, User, Item, Equipment, Category, MaintenanceFee, TransactionLog, sequelize } = require('../models');
const { notifyBorrower, notifyStaff } = require('../helpers/notify');
const { logStatusChange } = require('../helpers/transactionLog');

const INCLUDE = [
  { model: Borrower, as: 'borrower', include: [{ model: User, as: 'user' }] },
  { model: User, as: 'reviewer' },
  { model: User, as: 'approver' },
  {
    model: TransactionDetail,
    as: 'details',
    include: [{ model: Item, as: 'item', include: [{ model: Equipment, as: 'equipment', include: [{ model: Category, as: 'category' }] }] }]
  },
  { model: MaintenanceFee, as: 'maintenanceFees' },
  { model: TransactionLog, as: 'logs' }
];

// Availability-threshold borrowing caps, per the approved RSU SDPO spec:
//   > 5 available  = Green  = up to 2 units may be borrowed per request
//   4-5 available  = Yellow = only 1 unit may be borrowed per request
//   1-3 available  = Red    = borrowing not allowed
// (0 available never reaches this check — it's already caught by the
// "not enough stock" check below, since no positive quantity can be filled.)
//
// This is enforced as a hard rule for self-service requests
// (createSelfRequest) only. The spec itself frames these thresholds as
// "operational guidelines" whose "final approval remains subject to
// authorized SDPO personnel based on actual equipment availability" — so
// staff-initiated create() (used when a Property Custodian/Administrative
// Aide is physically registering a walk-in borrower, already holding the
// item) intentionally does not apply this cap; that in-person judgment call
// is the discretion the spec is describing. The Director's approve() step
// is a separate, later checkpoint and is likewise left to their judgment.
//
// On top of those fixed bands, each equipment also has its own minimum-
// stock floor at 25% of its total quantity (project-leader decision,
// 2026-09-12): once availableQuantity drops to or below that floor,
// borrowing is blocked outright regardless of which fixed band it's also
// in — this matters most for larger-total equipment, where the fixed "1-3"
// red band alone would let it stay borrowable well past the point SDPO
// wants a reserve kept back (e.g. 25% of a 20-unit total is 5, which the
// fixed bands alone would still treat as Yellow/1-unit-allowed). Computed
// with Math.ceil so the floor never rounds down to less than a true quarter
// of stock. Equipment with an unknown/non-positive totalQuantity skips this
// check entirely and falls back to the fixed bands alone.
function lowStockFloor(totalQuantity) {
  return Math.ceil(totalQuantity * 0.25);
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

// Late Return Policy, per the approved RSU SDPO spec: "Borrowers who fail to
// return equipment within two to three days after the due date shall be
// temporarily blocked from submitting another borrowing request... shall be
// restored after all overdue equipment has been returned and applicable
// penalties have been settled."
//
// This is deliberately implemented as a targeted check inside
// createSelfRequest() rather than by writing User.accountStatus='Blocked' —
// accountStatus already drives a full login lockout in auth.controller.js
// (`accountStatus !== 'Active'` refuses sign-in outright), which is the
// mechanism the damage/loss restriction system uses ('Restricted'). The
// spec's own wording for late returns is narrower: only *new borrowing
// requests* should be refused, not sign-in itself — a late borrower still
// needs to be able to log in to see their overdue item and its due date. So
// this reuses the existing Overdue status + expectedReturnDatetime instead
// of touching accountStatus, and unblocks itself automatically the moment
// the overdue transaction is returned (no separate field to remember to
// clear). Overdue-specific penalty fees (MaintenanceFee feeType 'Overdue')
// are not generated anywhere in this codebase yet, so "penalties settled" is
// vacuously satisfied for now; wiring up actual overdue-fee amounts is a
// separate feature, out of scope for this fix.
//
// Chose 3 days (the lenient end of the spec's "two to three days" range) as
// the grace window — see the equivalent hedge for the availability-threshold
// caps above; picking the more forgiving end when the spec itself gives a
// range is the same judgment call made there.
const LATE_RETURN_GRACE_DAYS = 3;

// Returns null if the borrower may submit new requests, or a small summary
// object if they're currently blocked by an overdue return past the grace
// window.
async function getLateReturnBlock(borrowerId) {
  const cutoff = new Date(Date.now() - LATE_RETURN_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const overdue = await Transaction.findAll({
    where: {
      borrowerId,
      transactionStatus: 'Overdue',
      expectedReturnDatetime: { [Op.lt]: cutoff }
    },
    order: [['expectedReturnDatetime', 'ASC']]
  });
  if (overdue.length === 0) return null;
  const oldest = overdue[0];
  const daysOverdue = Math.floor((Date.now() - new Date(oldest.expectedReturnDatetime).getTime()) / (24 * 60 * 60 * 1000));
  return {
    count: overdue.length,
    graceDays: LATE_RETURN_GRACE_DAYS,
    daysOverdue,
    oldestTransactionId: oldest.id
  };
}

// Counterpart to the item reservation done in create()/createSelfRequest():
// releases any still-Reserved items on this transaction back to Available
// stock and restores Equipment.availableQuantity. Must run whenever a
// transaction is Rejected or Cancelled before ever reaching Release — those
// items were pulled out of the available pool the moment the request was
// submitted, not at release time, so failing to give them back here would
// permanently strand that stock as neither available nor actually borrowed.
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

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}
function fmtTime(d) {
  return d ? new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
}

// Finds the most recent audit-trail entry (TransactionLog, already written
// by every status-changing action via logStatusChange()) whose newStatus
// matches, so the borrower-facing UI can show *why* a request was rejected
// or when it was cancelled without a separate column to keep in sync.
function lastLogFor(t, newStatus) {
  const logs = (t.logs || []).filter((l) => l.newStatus === newStatus);
  if (logs.length === 0) return null;
  return logs.reduce((latest, l) => (new Date(l.changeDatetime) > new Date(latest.changeDatetime) ? l : latest));
}

function serialize(t) {
  const b = t.borrower;
  const firstItem = (t.details || [])[0];
  const rejectionLog = t.transactionStatus === 'Rejected' ? lastLogFor(t, 'Rejected') : null;
  const cancellationLog = t.transactionStatus === 'Cancelled' ? lastLogFor(t, 'Cancelled') : null;
  return {
    dbId: t.id,
    borrowerId: t.borrowerId,
    id: `TXN-${new Date(t.requestDatetime || t.createdAt).getFullYear()}-${String(t.id).padStart(4, '0')}`,
    date: fmtDate(t.requestDatetime),
    time: fmtTime(t.requestDatetime),
    name: b ? `${b.firstName} ${b.lastName}` : 'Unknown Borrower',
    email: b && b.user ? b.user.emailAddress : '—',
    bsf: `BSF-${String(t.id).padStart(4, '0')}`,
    type: b ? b.borrowerCategory : '—',
    college: b ? b.collegeOrUnit : '—',
    purpose: t.purpose || '—',
    due: fmtDate(t.expectedReturnDatetime),
    returned: t.returnDatetime ? fmtDate(t.returnDatetime) : null,
    status: t.transactionStatus,
    reason: rejectionLog ? rejectionLog.remarks : null,
    cancelledAt: cancellationLog ? fmtDate(cancellationLog.changeDatetime) : null,
    receivedByBorrowerDatetime: t.receivedByBorrowerDatetime || null,
    review: t.reviewer ? t.reviewer.username : '—',
    approve: t.approver ? t.approver.username : '—',
    category: firstItem && firstItem.item && firstItem.item.equipment && firstItem.item.equipment.category ? firstItem.item.equipment.category.categoryName : '—',
    items: (t.details || []).map((d) => ({
      code: d.item.itemCode,
      name: d.item.equipment.equipmentName,
      returnedCondition: d.returnedCondition,
      conditionNotes: d.conditionNotes
    })),
    fees: (t.maintenanceFees || []).map((f) => ({
      id: f.id,
      feeType: f.feeType,
      feeAmount: f.feeAmount,
      feeStatus: f.feeStatus
    }))
  };
}

exports.list = async (req, res) => {
  const rows = await Transaction.findAll({ include: INCLUDE, order: [['requestDatetime', 'DESC']] });
  res.json({ success: true, data: rows.map(serialize) });
};

// Borrower-scoped equivalent of list() — used by the self-service pages
// (My Requests / My Borrowings / History) so a borrower only ever sees
// their own transactions, never the full staff-facing list.
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

// Lets the borrowing UI check — before the borrower even fills out a
// request — whether they're currently blocked by the Late Return Policy, so
// it can show a clear explanation instead of only surfacing the block as a
// rejected-submission error. See getLateReturnBlock() for the policy logic.
exports.lateReturnStatus = async (req, res) => {
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  if (!borrower) {
    return res.json({ success: true, data: { blocked: false } });
  }
  const block = await getLateReturnBlock(borrower.id);
  res.json({
    success: true,
    data: block ? { blocked: true, ...block } : { blocked: false }
  });
};

exports.create = async (req, res) => {
  const { borrowerId, itemIds, purpose, expectedReturnDatetime } = req.body;
  if (!borrowerId || !Array.isArray(itemIds) || itemIds.length === 0) {
    const err = new Error('borrowerId and a non-empty itemIds array are required');
    err.statusCode = 400;
    throw err;
  }

  const borrower = await Borrower.findByPk(borrowerId);
  if (!borrower) {
    const err = new Error('Borrower not found');
    err.statusCode = 404;
    throw err;
  }

  const created = await sequelize.transaction(async (t) => {
    // FOR UPDATE row-locks the candidate items for the life of this
    // transaction, so a concurrent request (self-service or staff) can't
    // select the same physical item before this one commits its Reserved
    // status below — without this lock, two near-simultaneous requests can
    // both read the same item as 'Available' and both get assigned it.
    const items = await Item.findAll({ where: { id: itemIds }, transaction: t, lock: t.LOCK.UPDATE });
    if (items.length !== itemIds.length) {
      const err = new Error('One or more selected items were not found');
      err.statusCode = 404;
      throw err;
    }
    const notAvailable = items.filter((i) => i.availabilityStatus !== 'Available');
    if (notAvailable.length > 0) {
      const err = new Error(`These items are not available: ${notAvailable.map((i) => i.itemCode).join(', ')}`);
      err.statusCode = 409;
      throw err;
    }

    // Reserve immediately — see releaseReservedItems()/release() for the
    // matching un-reserve-on-Rejected/Cancelled and consume-on-Released
    // halves of this. availableQuantity moves here, at reservation time,
    // not at release, so it accurately reflects what's actually still free
    // to request while this transaction is pending.
    await Item.update({ availabilityStatus: 'Reserved' }, { where: { id: items.map((i) => i.id) }, transaction: t });
    const byEquipment = {};
    items.forEach((i) => {
      byEquipment[i.equipmentId] = (byEquipment[i.equipmentId] || 0) + 1;
    });
    for (const [equipmentId, qty] of Object.entries(byEquipment)) {
      await Equipment.decrement('availableQuantity', { by: qty, where: { id: equipmentId }, transaction: t });
    }

    // Staff creating this on a borrower's behalf implies the ID/requirements
    // were just verified in person, so it starts Acknowledged just like a
    // self-request — there's no separate "Pending" gate to sit behind.
    const txn = await Transaction.create(
      {
        borrowerId,
        purpose: purpose || null,
        expectedReturnDatetime: expectedReturnDatetime || null,
        transactionStatus: 'Acknowledged',
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

  const withIncludes = await Transaction.findByPk(created.id, { include: INCLUDE });
  res.status(201).json({ success: true, data: serialize(withIncludes) });
};

// Self-service equivalent of create(): a borrower doesn't know specific item
// codes, only which equipment + how many units they want, so the server
// auto-assigns that many currently-available units of each requested
// equipment. borrowerId is derived from the token, never trusted from the body.
exports.createSelfRequest = async (req, res) => {
  const { items, purpose, expectedReturnDatetime } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items (equipmentId + quantity) is required');
    err.statusCode = 400;
    throw err;
  }

  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  if (!borrower) {
    const err = new Error('Only borrower accounts can submit a borrowing request');
    err.statusCode = 403;
    throw err;
  }

  const lateBlock = await getLateReturnBlock(borrower.id);
  if (lateBlock) {
    const err = new Error(
      `You have equipment overdue by ${lateBlock.daysOverdue} day(s) (Transaction #${lateBlock.oldestTransactionId}). New borrowing requests are blocked until all overdue equipment is returned and any applicable penalties are settled.`
    );
    err.statusCode = 403;
    throw err;
  }

  // Validate shape up front; stock/threshold checks happen inside the DB
  // transaction below, where the row locks that make them race-safe
  // actually apply.
  const lines = items.map((line) => {
    const equipmentId = Number(line.equipmentId);
    const quantity = Number(line.quantity) || 1;
    if (!equipmentId || quantity < 1) {
      const err = new Error('Each item needs a valid equipmentId and quantity');
      err.statusCode = 400;
      throw err;
    }
    return { equipmentId, quantity };
  });

  const created = await sequelize.transaction(async (t) => {
    const selectedItems = [];
    for (const { equipmentId, quantity } of lines) {
      // FOR UPDATE serializes concurrent requests against this same
      // equipment row, so the tier check just below and the item
      // reservation that follows can't race with another borrower's
      // request for the same equipment.
      const equipment = await Equipment.findByPk(equipmentId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!equipment) {
        const err = new Error(`Equipment #${equipmentId} not found`);
        err.statusCode = 404;
        throw err;
      }

      const cap = maxBorrowableUnits(equipment.availableQuantity, equipment.totalQuantity);
      if (quantity > cap) {
        const atFloor =
          cap === 0 &&
          Number.isFinite(equipment.totalQuantity) &&
          equipment.totalQuantity > 0 &&
          equipment.availableQuantity <= lowStockFloor(equipment.totalQuantity);
        const err = new Error(
          atFloor
            ? `Warning: "${equipment.equipmentName}" can't be borrowed at this moment — only ${equipment.availableQuantity} of ${equipment.totalQuantity} left, at or below the SDPO's 25% minimum-stock threshold.`
            : cap === 0
              ? `"${equipment.equipmentName}" is low in stock (${equipment.availableQuantity} available) and can't be borrowed right now under the SDPO's minimum-stock guideline.`
              : `Only ${cap} unit(s) of "${equipment.equipmentName}" may be borrowed per request while stock is at ${equipment.availableQuantity} available (SDPO minimum-stock guideline).`
        );
        err.statusCode = 409;
        throw err;
      }

      const available = await Item.findAll({
        where: { equipmentId, availabilityStatus: 'Available' },
        limit: quantity,
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (available.length < quantity) {
        const err = new Error(
          `Not enough stock for "${equipment.equipmentName}" — ${available.length} available, ${quantity} requested`
        );
        err.statusCode = 409;
        throw err;
      }

      // Reserve immediately — see releaseReservedItems()/release() for the
      // matching un-reserve-on-Rejected/Cancelled and consume-on-Released
      // halves of this.
      await Item.update(
        { availabilityStatus: 'Reserved' },
        { where: { id: available.map((i) => i.id) }, transaction: t }
      );
      await equipment.decrement('availableQuantity', { by: quantity, transaction: t });
      selectedItems.push(...available);
    }

    // The wizard's Acknowledge checkbox already gates submission client-side
    // (equipment-showroom-figma.html), so a self-request reaching here has
    // always been acknowledged — record that explicitly rather than sitting
    // in a separate unacknowledged "Pending" state first.
    const txn = await Transaction.create(
      {
        borrowerId: borrower.id,
        purpose: purpose || null,
        expectedReturnDatetime: expectedReturnDatetime || null,
        transactionStatus: 'Acknowledged',
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

  await notifyBorrower(
    req.user.id,
    `Your borrow request (Transaction #${created.id}) was submitted and is pending staff review.`,
    'Request Submitted'
  );
  await notifyStaff(
    `New borrow request from ${borrower.firstName} ${borrower.lastName} (Transaction #${created.id}) — pending review.`,
    'New Request'
  );

  const withIncludes = await Transaction.findByPk(created.id, { include: INCLUDE });
  res.status(201).json({ success: true, data: serialize(withIncludes) });
};

async function loadTransactionOr404(id) {
  const txn = await Transaction.findByPk(id, { include: INCLUDE });
  if (!txn) {
    const err = new Error('Transaction not found');
    err.statusCode = 404;
    throw err;
  }
  return txn;
}

function assertStatus(txn, expected) {
  assertStatusIn(txn, [expected]);
}

function assertStatusIn(txn, expectedList) {
  if (!expectedList.includes(txn.transactionStatus)) {
    const err = new Error(
      `This action requires the transaction to be ${expectedList.map((s) => `"${s}"`).join(' or ')} (it is currently "${txn.transactionStatus}")`
    );
    err.statusCode = 409;
    throw err;
  }
}

// Lets a borrower withdraw their own request while it's still awaiting
// staff review — mirrors review/approve but scoped to the requester.
exports.cancelSelfRequest = async (req, res) => {
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  const txn = await loadTransactionOr404(req.params.id);
  if (!borrower || txn.borrowerId !== borrower.id) {
    const err = new Error('You do not have permission to cancel this request');
    err.statusCode = 403;
    throw err;
  }
  assertStatusIn(txn, ['Pending', 'Acknowledged']);
  const oldStatus = txn.transactionStatus;
  await sequelize.transaction(async (t) => {
    await releaseReservedItems(txn, t);
    txn.transactionStatus = 'Cancelled';
    await txn.save({ transaction: t });
  });
  await logStatusChange(txn.id, req.user.id, oldStatus, 'Cancelled', 'Cancelled by borrower');
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Step 2 — Review (Property Custodian / Administrative Aide). Distinct from
// Approve: this is staff checking the borrower/requirements are in order
// before it ever reaches a Director. action: 'accept' | 'correction' | 'reject'.
exports.review = async (req, res) => {
  const { action, remarks } = req.body;
  if (!['accept', 'correction', 'reject'].includes(action)) {
    const err = new Error('action must be one of accept, correction, or reject');
    err.statusCode = 400;
    throw err;
  }

  const txn = await loadTransactionOr404(req.params.id);
  assertStatusIn(txn, ['Pending', 'Acknowledged']);
  const oldStatus = txn.transactionStatus;

  const nextStatus = action === 'accept' ? 'For Approval' : action === 'reject' ? 'Rejected' : 'Acknowledged';
  if (action === 'reject') {
    // Rejecting at Review means these items never actually get borrowed —
    // release the Reserved stock this request took at submission time.
    await sequelize.transaction(async (t) => {
      await releaseReservedItems(txn, t);
      txn.transactionStatus = nextStatus;
      txn.reviewedBy = req.user.id;
      txn.reviewDatetime = new Date();
      await txn.save({ transaction: t });
    });
  } else {
    txn.transactionStatus = nextStatus;
    txn.reviewedBy = req.user.id;
    txn.reviewDatetime = new Date();
    await txn.save();
  }
  await logStatusChange(txn.id, req.user.id, oldStatus, nextStatus, remarks || null);

  if (txn.borrower && txn.borrower.user) {
    const message =
      action === 'accept'
        ? `Your borrow request (Transaction #${txn.id}) passed review and is now awaiting Director approval.`
        : action === 'reject'
          ? `Your borrow request (Transaction #${txn.id}) was rejected during review.${remarks ? ' Reason: ' + remarks : ''}`
          : `Your borrow request (Transaction #${txn.id}) needs correction before it can proceed.${remarks ? ' ' + remarks : ''}`;
    await notifyBorrower(txn.borrower.user.id, message, 'Review');
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Step 3 — Approve (Director only, enforced by roleMiddleware on the route).
exports.approve = async (req, res) => {
  const txn = await loadTransactionOr404(req.params.id);
  assertStatus(txn, 'For Approval');
  txn.transactionStatus = 'Approved';
  txn.approvedBy = req.user.id;
  txn.approvalDatetime = new Date();
  await txn.save();
  await logStatusChange(txn.id, req.user.id, 'For Approval', 'Approved');
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(txn.borrower.user.id, `Your borrow request (Transaction #${txn.id}) has been approved by the Director.`, 'Approval');
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Step 4 — the borrower's pre-issuance electronic acknowledgement (spec:
// "Before equipment issuance, the borrower completes an electronic
// acknowledgement confirming receipt of the equipment and acceptance of
// responsibility for its proper use, timely return, and applicable
// liabilities. No handwritten or digital signature is required.").
//
// This is distinct from borrowerAcknowledged/acknowledgementTimestamp above,
// which record the borrower agreeing to the general borrowing guidelines at
// *submission* time (step 1) — a separate, earlier moment. This endpoint is
// the actual step-4 gate: the borrower is physically at the SDPO office
// receiving the item and taps this on their own account (no signature) to
// confirm they've received it and accept responsibility, which release()
// below now requires before staff can scan-to-release. Tracked in
// receivedByBorrowerDatetime, a field that already existed on the model but
// was never written anywhere before this.
exports.acknowledgeReceipt = async (req, res) => {
  const borrower = await Borrower.findOne({ where: { userId: req.user.id } });
  const txn = await loadTransactionOr404(req.params.id);
  if (!borrower || txn.borrowerId !== borrower.id) {
    const err = new Error('You do not have permission to acknowledge this transaction');
    err.statusCode = 403;
    throw err;
  }
  assertStatus(txn, 'Approved');
  if (txn.receivedByBorrowerDatetime) {
    const err = new Error('Receipt has already been acknowledged for this transaction');
    err.statusCode = 409;
    throw err;
  }
  txn.receivedByBorrowerDatetime = new Date();
  await txn.save();
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

exports.reject = async (req, res) => {
  const { remarks } = req.body;
  const txn = await loadTransactionOr404(req.params.id);
  assertStatusIn(txn, ['Pending', 'Acknowledged', 'For Approval']);
  // The route allows Staff/Director/Admin generally (this action also covers
  // the earlier Review-stage reject at Pending/Acknowledged), but per the
  // approved workflow "the SDPO Director approves or rejects" is a single
  // decision point once a request reaches For Approval — only Director/Admin
  // may reject at that stage, mirroring approve()'s directorOnly route gate.
  // The admin UI already hides the Reject button from non-Directors here;
  // this is the server-side enforcement of the same rule.
  if (txn.transactionStatus === 'For Approval' && !['Director', 'Admin'].includes(req.user.userRole)) {
    const err = new Error('Only a Director can reject a request that has reached the approval stage');
    err.statusCode = 403;
    throw err;
  }
  const oldStatus = txn.transactionStatus;
  await sequelize.transaction(async (t) => {
    await releaseReservedItems(txn, t);
    txn.transactionStatus = 'Rejected';
    await txn.save({ transaction: t });
  });
  await logStatusChange(txn.id, req.user.id, oldStatus, 'Rejected', remarks || null);
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(
      txn.borrower.user.id,
      `Your borrow request (Transaction #${txn.id}) was rejected.${remarks ? ' Reason: ' + remarks : ''}`,
      'Rejection'
    );
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

exports.release = async (req, res) => {
  const { itemCodes } = req.body;
  if (!Array.isArray(itemCodes) || itemCodes.length === 0) {
    const err = new Error('itemCodes (the scanned item codes) is required');
    err.statusCode = 400;
    throw err;
  }

  const txn = await loadTransactionOr404(req.params.id);
  assertStatus(txn, 'Approved');

  // Electronic acknowledgement (per the approved borrowing workflow) must
  // happen before issuance: the borrower has to confirm receipt and accept
  // responsibility for proper use, timely return, and applicable liabilities
  // before the admin can release the equipment. This is distinct from the
  // request-submission-time `borrowerAcknowledged` guideline agreement.
  if (!txn.receivedByBorrowerDatetime) {
    const err = new Error(
      'The borrower has not yet completed the electronic acknowledgement of receipt for this request — it must be acknowledged before equipment can be released.'
    );
    err.statusCode = 409;
    throw err;
  }

  const expectedCodes = txn.details.map((d) => d.item.itemCode).sort();
  const scannedCodes = [...itemCodes].sort();
  const matches = expectedCodes.length === scannedCodes.length && expectedCodes.every((c, i) => c === scannedCodes[i]);
  if (!matches) {
    const err = new Error(`Scanned items don't match this transaction. Expected: ${expectedCodes.join(', ')}`);
    err.statusCode = 409;
    throw err;
  }

  // Every item here should already be 'Reserved' (set at request-creation
  // time in create()/createSelfRequest(), never undone since — Approved is
  // downstream of that). Re-check anyway rather than assume: this is the
  // one place that would otherwise silently double-book or double-decrement
  // availableQuantity if an item's state had diverged for any reason (e.g.
  // manually forced back to Available via QR Management).
  const notReserved = txn.details.filter((d) => d.item.availabilityStatus !== 'Reserved');
  if (notReserved.length > 0) {
    const err = new Error(
      `These items are no longer reserved for this transaction and can't be released: ${notReserved.map((d) => d.item.itemCode).join(', ')}`
    );
    err.statusCode = 409;
    throw err;
  }

  await sequelize.transaction(async (t) => {
    for (const detail of txn.details) {
      // availableQuantity was already decremented when this item was
      // reserved at request-creation time — decrementing it again here
      // would double-count it, so this only flips the item's own status.
      await detail.item.update(
        { availabilityStatus: 'Borrowed', currentBorrowerId: txn.borrowerId },
        { transaction: t }
      );
    }
    txn.transactionStatus = 'Released';
    txn.releasedBy = req.user.id;
    txn.releaseDatetime = new Date();
    await txn.save({ transaction: t });
  });

  await logStatusChange(txn.id, req.user.id, 'Approved', 'Released');
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(txn.borrower.user.id, `Equipment for your request (Transaction #${txn.id}) has been released to you.`, 'Release');
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Step 7 — Complete. The all-good return path completes automatically
// inside return.controller.js; this is only reached via the damage/loss
// branch, once damageLoss.controller.js#resolve has moved the transaction
// to Resolved after a verified replacement.
exports.complete = async (req, res) => {
  const txn = await loadTransactionOr404(req.params.id);
  assertStatus(txn, 'Resolved');
  txn.transactionStatus = 'Completed';
  await txn.save();
  await logStatusChange(txn.id, req.user.id, 'Resolved', 'Completed');
  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(txn.borrower.user.id, `Transaction #${txn.id} has been marked Completed.`, 'Completed');
  }
  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};

// Shared with return.controller.js and damageLoss.controller.js so every
// endpoint serializes/validates transactions identically.
exports.INCLUDE = INCLUDE;
exports.serialize = serialize;
exports.loadTransactionOr404 = loadTransactionOr404;
exports.assertStatus = assertStatus;
exports.assertStatusIn = assertStatusIn;
