'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class TransactionDetail extends Model {
    static associate(models) {
      TransactionDetail.belongsTo(models.Transaction, { foreignKey: 'transactionId', as: 'transaction' });
      TransactionDetail.belongsTo(models.Item, { foreignKey: 'itemId', as: 'item' });
      TransactionDetail.belongsTo(models.Equipment, { foreignKey: 'equipmentId', as: 'equipment' });
    }
  }

  TransactionDetail.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'detail_id' },
      transactionId: { type: DataTypes.INTEGER, allowNull: false },
      // Null while the request is pending; units are assigned at approval.
      itemId: { type: DataTypes.INTEGER, allowNull: true },
      equipmentId: { type: DataTypes.INTEGER, allowNull: false },
      returnedCondition: { type: DataTypes.ENUM('Good', 'Damaged', 'Lost'), allowNull: true },
      conditionNotes: { type: DataTypes.TEXT, allowNull: true }
    },
    {
      sequelize,
      modelName: 'TransactionDetail',
      tableName: 'transaction_details',
      underscored: true,
      timestamps: false
    }
  );

  return TransactionDetail;
};
