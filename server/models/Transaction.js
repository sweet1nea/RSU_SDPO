'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Transaction extends Model {
    static associate(models) {
      Transaction.belongsTo(models.Borrower, { foreignKey: 'borrowerId', as: 'borrower' });
      Transaction.belongsTo(models.User, { foreignKey: 'reviewedBy', as: 'reviewer' });
      Transaction.belongsTo(models.User, { foreignKey: 'approvedBy', as: 'approver' });
      Transaction.belongsTo(models.User, { foreignKey: 'documentsVerifiedBy', as: 'documentsVerifier' });
      Transaction.belongsTo(models.User, { foreignKey: 'releasedBy', as: 'releaser' });
      Transaction.belongsTo(models.User, { foreignKey: 'returnedBy', as: 'returner' });
      Transaction.belongsTo(models.User, { foreignKey: 'receivedByStaff', as: 'receivingStaff' });
      Transaction.hasMany(models.TransactionDetail, { foreignKey: 'transactionId', as: 'details' });
      Transaction.hasMany(models.TransactionLog, { foreignKey: 'transactionId', as: 'logs' });
      Transaction.hasMany(models.DamageLossRecord, { foreignKey: 'transactionId', as: 'damageLossRecords' });
    }
  }

  Transaction.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'transaction_id' },
      borrowerId: { type: DataTypes.INTEGER, allowNull: false },
      purpose: { type: DataTypes.TEXT, allowNull: true },
      expectedReturnDatetime: { type: DataTypes.DATE, allowNull: true },
      requestDatetime: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
      reviewedBy: { type: DataTypes.INTEGER, allowNull: true },
      reviewDatetime: { type: DataTypes.DATE, allowNull: true },
      // Set when Admin/Staff accept the borrower's submitted documents —
      // the gate a request must pass before it can reach the Director.
      documentsVerifiedBy: { type: DataTypes.INTEGER, allowNull: true },
      documentsVerifiedDatetime: { type: DataTypes.DATE, allowNull: true },
      // Client-generated idempotency key for self-service submissions, unique
      // per borrower (migration 023), so a double-click/retry can never
      // create the same request twice.
      requestKey: { type: DataTypes.STRING(64), allowNull: true },
      // The documents submitted WITH this request (snapshotted from the
      // borrower's files at submission; migration 027) so a later upload for
      // another request never changes what this one shows.
      validIdPath: { type: DataTypes.STRING(255), allowNull: true },
      authorizationDocumentPath: { type: DataTypes.STRING(255), allowNull: true },
      approvalDatetime: { type: DataTypes.DATE, allowNull: true },
      approvedBy: { type: DataTypes.INTEGER, allowNull: true },
      releaseDatetime: { type: DataTypes.DATE, allowNull: true },
      releasedBy: { type: DataTypes.INTEGER, allowNull: true },
      receivedByBorrowerDatetime: { type: DataTypes.DATE, allowNull: true },
      returnDatetime: { type: DataTypes.DATE, allowNull: true },
      returnedBy: { type: DataTypes.INTEGER, allowNull: true },
      receivedByStaff: { type: DataTypes.INTEGER, allowNull: true },
      receivedByStaffDatetime: { type: DataTypes.DATE, allowNull: true },
      transactionStatus: {
        type: DataTypes.ENUM(
          'Pending',
          'Acknowledged',
          'For Review',
          'For Approval',
          'Approved',
          'Rejected',
          'Cancelled',
          'Released',
          'Returned',
          'Overdue',
          'For Resolution',
          'Replacement',
          'Resolved',
          'Completed'
        ),
        allowNull: true,
        defaultValue: 'Pending'
      },
      borrowerAcknowledged: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
      acknowledgementTimestamp: { type: DataTypes.DATE, allowNull: true },
      dueReminderSentDatetime: { type: DataTypes.DATE, allowNull: true },
      incompleteReqReminderSentDatetime: { type: DataTypes.DATE, allowNull: true }
    },
    {
      sequelize,
      modelName: 'Transaction',
      tableName: 'transaction',
      underscored: true,
      timestamps: true,
      indexes: [{ unique: true, fields: ['borrower_id', 'request_key'] }]
    }
  );

  return Transaction;
};
