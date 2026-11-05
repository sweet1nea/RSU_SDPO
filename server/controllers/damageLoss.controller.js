'use strict';

const { Op } = require('sequelize');
const { DamageLossRecord, Transaction, Borrower, User, Item, Equipment, Category, sequelize } = require('../models');
const { notifyBorrower } = require('../helpers/notify');
const { logStatusChange } = require('../helpers/transactionLog');

const { formatDate: fmtDate } = require('../helpers/dateHelper');
const { txnCode } = require('./borrow.controller');
const { txnCodeById } = require('../helpers/txnCode');

const INCLUDE = [
  { model: Transaction, as: 'transaction' },
  { model: Borrower, as: 'borrower', include: [{ model: User, as: 'user' }] },
  { model: Item, as: 'item', include: [{ model: Equipment, as: 'equipment', include: [{ model: Category, as: 'category' }] }] },
  { model: User, as: 'recordedByUser' },
  { model: User, as: 'verifiedByUser' }
];

function serialize(record) {
  const txn = record.transaction;
  const borrower = record.borrower;
  return {
    id: record.id,
    transactionId: txn ? txn.id : record.transactionId,
    transactionCode: txn ? txnCode(txn) : '—',
    borrowerName: borrower ? `${borrower.firstName} ${borrower.lastName}` : 'Unknown Borrower',
    borrowerMeta: borrower ? `${borrower.borrowerCategory} • ${borrower.collegeOrUnit}` : '—',
    equipmentName: record.item && record.item.equipment ? record.item.equipment.equipmentName : '—',
    categoryName: record.item && record.item.equipment && record.item.equipment.category ? record.item.equipment.category.categoryName : '—',
    itemCode: record.item ? record.item.itemCode : '—',
    incidentType: record.incidentType,
    dateReported: fmtDate(record.dateReported),
    conditionDetails: record.conditionDetails || (record.incidentType === 'Lost' ? 'N/A' : '—'),
    recordedBy: record.recordedByUser ? record.recordedByUser.username : '—',
    flagged: !!borrower && !!borrower.user && borrower.user.accountStatus === 'Restricted',
    replacementEquipment: record.replacementEquipment,
    replacementDate: record.replacementDate,
    replacementVerifiedBy: record.verifiedByUser ? record.verifiedByUser.username : null,
    resolutionStatus: record.resolutionStatus,
    resolutionDate: record.resolutionDate
  };
}

exports.list = async (req, res) => {
  const rows = await DamageLossRecord.findAll({ include: INCLUDE, order: [['id', 'DESC']] });
  res.json({ success: true, data: rows.map(serialize) });
};

async function loadRecordOr404(id) {
  const record = await DamageLossRecord.findByPk(id, { include: INCLUDE });
  if (!record) {
    const err = new Error('Damage/loss record not found');
    err.statusCode = 404;
    throw err;
  }
  return record;
}

// --- Replacement resolution workflow (the primary, required path) ---

exports.submitReplacement = async (req, res) => {
  const { replacementEquipment, replacementDate } = req.body;
  if (!replacementEquipment || !replacementDate) {
    const err = new Error('replacementEquipment and replacementDate are required');
    err.statusCode = 400;
    throw err;
  }
  const record = await loadRecordOr404(req.params.id);
  if (record.resolutionStatus === 'Resolved') {
    const err = new Error('This record is already resolved');
    err.statusCode = 409;
    throw err;
  }

  record.replacementEquipment = replacementEquipment;
  record.replacementDate = replacementDate;
  record.resolutionStatus = 'Replacement Submitted';
  await record.save();

  const txn = record.transaction;
  if (txn && txn.transactionStatus === 'For Resolution') {
    const [moved] = await Transaction.update(
      { transactionStatus: 'Replacement' },
      { where: { id: txn.id, transactionStatus: 'For Resolution' } }
    );
    if (moved) {
      await logStatusChange(txn.id, req.user.id, 'For Resolution', 'Replacement', `Replacement submitted for item #${record.itemId}`);
    }
  }

  res.json({ success: true, data: serialize(await loadRecordOr404(record.id)) });
};

exports.verifyReplacement = async (req, res) => {
  const record = await loadRecordOr404(req.params.id);
  if (record.resolutionStatus !== 'Replacement Submitted') {
    const err = new Error('A replacement must be submitted before it can be verified');
    err.statusCode = 409;
    throw err;
  }

  record.replacementVerifiedBy = req.user.id;
  record.resolutionStatus = 'Replacement Verified';
  await record.save();

  res.json({ success: true, data: serialize(await loadRecordOr404(record.id)) });
};

// The key rule: a record cannot become Resolved until its replacement has
// been submitted AND verified — this is the only path that clears it.
exports.resolve = async (req, res) => {
  const record = await loadRecordOr404(req.params.id);
  if (record.resolutionStatus !== 'Replacement Verified') {
    const err = new Error('This record cannot be resolved until its replacement has been submitted and verified');
    err.statusCode = 409;
    throw err;
  }

  // Restores the unit to the lending pool. The conditional update makes a
  // repeated click a no-op 409 instead of crediting the stock twice.
  await sequelize.transaction(async (t) => {
    const [count] = await DamageLossRecord.update(
      { resolutionStatus: 'Resolved', resolutionDate: new Date() },
      { where: { id: record.id, resolutionStatus: 'Replacement Verified' }, transaction: t }
    );
    if (!count) {
      const err = new Error('This record was already resolved');
      err.statusCode = 409;
      throw err;
    }

    const item = await Item.findByPk(record.itemId, { transaction: t });
    if (item) {
      await item.update(
        { itemCondition: 'Good', availabilityStatus: 'Available', currentBorrowerId: null },
        { transaction: t }
      );
      await Equipment.increment('availableQuantity', { by: 1, where: { id: item.equipmentId }, transaction: t });
    }
  });

  // The parent transaction only moves to Resolved once every one of its
  // Damage/Loss Records is Resolved — a transaction can have more than one
  // affected item.
  const outstandingForTxn = await DamageLossRecord.count({
    where: { transactionId: record.transactionId, resolutionStatus: { [Op.ne]: 'Resolved' } }
  });
  const txn = await Transaction.findByPk(record.transactionId);
  if (outstandingForTxn === 0 && txn && ['For Resolution', 'Replacement'].includes(txn.transactionStatus)) {
    const oldStatus = txn.transactionStatus;
    const [moved] = await Transaction.update(
      { transactionStatus: 'Resolved' },
      { where: { id: txn.id, transactionStatus: ['For Resolution', 'Replacement'] } }
    );
    if (moved) await logStatusChange(txn.id, req.user.id, oldStatus, 'Resolved', 'All damage/loss records resolved');
  }

  // Likewise only lift the account restriction once the borrower has no
  // other unresolved records outstanding across any transaction.
  const outstandingForBorrower = await DamageLossRecord.count({
    where: { borrowerId: record.borrowerId, resolutionStatus: { [Op.ne]: 'Resolved' } }
  });
  if (outstandingForBorrower === 0) {
    const borrower = await Borrower.findByPk(record.borrowerId, { include: [{ model: User, as: 'user' }] });
    if (borrower && borrower.user) {
      borrower.user.accountStatus = 'Active';
      await borrower.user.save();
      await notifyBorrower(
        borrower.user.id,
        `Your replacement for Transaction ${await txnCodeById(record.transactionId)} has been verified and the incident is resolved. Your account restriction has been lifted.`,
        'Account Restored',
        `borrower-${borrower.id}-restored-record-${record.id}`
      );
    }
  }

  res.json({ success: true, data: serialize(await loadRecordOr404(record.id)) });
};

// --- Manual override (independent of the replacement workflow above) ---

exports.flag = async (req, res) => {
  const record = await loadRecordOr404(req.params.id);
  if (!record.borrower || !record.borrower.user) {
    const err = new Error('Borrower account not found for this record');
    err.statusCode = 404;
    throw err;
  }
  const user = record.borrower.user;
  user.accountStatus = 'Restricted';
  await user.save();

  await notifyBorrower(
    user.id,
    `Your account has been flagged due to a ${record.incidentType.toLowerCase()} item report on Transaction ${await txnCodeById(record.transactionId)}. You can still sign in, but new borrowing requests are blocked until the SDPO lifts the flag. Please visit the SDPO office to resolve this.`,
    'Account Restricted'
  );

  res.json({ success: true, data: serialize(await loadRecordOr404(record.id)) });
};

exports.unflag = async (req, res) => {
  const record = await loadRecordOr404(req.params.id);
  if (!record.borrower || !record.borrower.user) {
    const err = new Error('Borrower account not found for this record');
    err.statusCode = 404;
    throw err;
  }
  const user = record.borrower.user;
  user.accountStatus = 'Active';
  await user.save();

  await notifyBorrower(
    user.id,
    `Your account restriction related to Transaction ${await txnCodeById(record.transactionId)} has been lifted. You may borrow equipment again.`,
    'Account Restored'
  );

  res.json({ success: true, data: serialize(await loadRecordOr404(record.id)) });
};
