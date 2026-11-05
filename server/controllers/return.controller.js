'use strict';

const { Equipment, User, DamageLossRecord, sequelize } = require('../models');
const { txnCode } = require('../helpers/txnCode');
const { serialize, loadTransactionOr404, assertStatusIn, transition, codeMatchesItem } = require('./borrow.controller');
const { STATUS, OUT_WITH_BORROWER } = require('../constants/transactionStatus');
const { notifyBorrower } = require('../helpers/notify');
const { logStatusChange } = require('../helpers/transactionLog');

// Step 5 — Return. Each item is assigned its own condition (Good / Damaged /
// Lost) rather than one condition for the whole transaction, so a mixed
// return (e.g. one ball Good, one net Damaged) produces an accurate
// Damage/Loss Record for only the affected item(s).
exports.returnTransaction = async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items (itemCode + condition for each returned item) is required');
    err.statusCode = 400;
    throw err;
  }
  for (const line of items) {
    if (!line.itemCode || !['Good', 'Damaged', 'Lost'].includes(line.condition)) {
      const err = new Error('Each item needs an itemCode and a condition of Good, Damaged, or Lost');
      err.statusCode = 400;
      throw err;
    }
  }

  const txn = await loadTransactionOr404(req.params.id);
  // Overdue transactions previously could never be returned — assertStatus
  // only accepted 'Released', which is a real bug: a late transaction is
  // still Released equipment sitting with the borrower.
  assertStatusIn(txn, OUT_WITH_BORROWER);
  const oldStatus = txn.transactionStatus;

  // A line may name a unit by its canonical code or a pre-standardization
  // label code (see helpers/equipmentCode.js) — both resolve to the same unit.
  const lineFor = (item) => items.find((line) => codeMatchesItem(String(line.itemCode).trim(), item));
  const missing = txn.details.filter((d) => !lineFor(d.item));
  if (missing.length) {
    const err = new Error(`Missing condition for: ${missing.map((d) => d.item.itemCode).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const anyBad = txn.details.some((d) => lineFor(d.item).condition !== 'Good');
  const nextStatus = anyBad ? STATUS.FOR_RESOLUTION : STATUS.COMPLETED;
  const createdRecords = [];
  await sequelize.transaction(async (t) => {
    // Status first: the conditional update makes a duplicate return
    // submission fail with 409 before any unit or stock is touched twice.
    const now = new Date();
    await transition(
      txn,
      OUT_WITH_BORROWER,
      nextStatus,
      { returnedBy: req.user.id, returnDatetime: now, receivedByStaff: req.user.id, receivedByStaffDatetime: now },
      t
    );

    for (const detail of txn.details) {
      const line = lineFor(detail.item);
      await detail.update({ returnedCondition: line.condition, conditionNotes: line.notes || null }, { transaction: t });

      if (line.condition === 'Good') {
        await detail.item.update(
          { availabilityStatus: 'Available', itemCondition: 'Good', currentBorrowerId: null },
          { transaction: t }
        );
        await Equipment.increment('availableQuantity', { by: 1, where: { id: detail.item.equipmentId }, transaction: t });
      } else {
        // Damaged/Lost units stay out of the lending pool until their
        // replacement is verified (damageLoss.controller.js#resolve).
        await detail.item.update({ itemCondition: line.condition }, { transaction: t });
        const record = await DamageLossRecord.create(
          {
            transactionId: txn.id,
            borrowerId: txn.borrowerId,
            itemId: detail.item.id,
            incidentType: line.condition,
            dateReported: now,
            conditionDetails: line.notes || null,
            recordedBy: req.user.id
          },
          { transaction: t }
        );
        createdRecords.push(record);
      }
    }

    if (anyBad && txn.borrower && txn.borrower.user) {
      // The borrower is flagged the moment any unit comes back bad: they can
      // still sign in and see their records, but cannot submit new requests
      // until every replacement is resolved (borrow.controller.js).
      const user = await User.findByPk(txn.borrower.user.id, { transaction: t });
      if (user) {
        user.accountStatus = 'Restricted';
        await user.save({ transaction: t });
      }
    }
  });

  const worst = createdRecords.some((r) => r.incidentType === 'Lost') ? 'Lost/Damaged' : 'Damaged';
  await logStatusChange(
    txn.id,
    req.user.id,
    oldStatus,
    nextStatus,
    anyBad ? `Returned with ${createdRecords.length} item(s) reported ${worst} — replacement required` : 'Returned in good condition'
  );

  if (txn.borrower && txn.borrower.user) {
    await notifyBorrower(
      txn.borrower.user.id,
      anyBad
        ? `Your returned equipment for Transaction ${txnCode(txn)} included ${createdRecords.length} item(s) reported Damaged or Lost. Your account is flagged and a replacement is required before you can borrow again — please visit the SDPO office.`
        : `Your returned equipment for Transaction ${txnCode(txn)} has been received in good condition and the transaction is complete. Thank you!`,
      'Return',
      `txn-${txn.id}-returned`
    );
  }

  res.json({ success: true, data: serialize(await loadTransactionOr404(txn.id)) });
};
