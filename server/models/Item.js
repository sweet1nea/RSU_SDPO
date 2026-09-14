'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Item extends Model {
    static associate(models) {
      Item.belongsTo(models.Equipment, { foreignKey: 'equipmentId', as: 'equipment' });
      Item.belongsTo(models.Borrower, { foreignKey: 'currentBorrowerId', as: 'currentBorrower' });
      Item.hasMany(models.TransactionDetail, { foreignKey: 'itemId', as: 'transactionDetails' });
    }
  }

  Item.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'item_id' },
      equipmentId: { type: DataTypes.INTEGER, allowNull: false },
      itemCode: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      qrCodePath: { type: DataTypes.STRING(255), allowNull: true },
      itemCondition: {
        type: DataTypes.ENUM('Good', 'Damaged', 'Under Repair', 'Lost'),
        allowNull: true,
        defaultValue: 'Good'
      },
      availabilityStatus: {
        // Maintenance/Decommissioned removed 2026-09-14 per the SDPO's own
        // revised requirements — see migration
        // 022_remove_item_maintenance_status, which also rebuilds the real
        // Postgres enum to match (a Sequelize DataTypes.ENUM here only
        // controls what Sequelize itself will validate/send; it doesn't
        // touch the already-created database type on its own).
        type: DataTypes.ENUM('Available', 'Borrowed', 'Reserved'),
        allowNull: true,
        defaultValue: 'Available'
      },
      engravingStatus: {
        type: DataTypes.ENUM('Not Engraved', 'Engraved', 'Tagged'),
        allowNull: true,
        defaultValue: 'Not Engraved'
      },
      currentBorrowerId: { type: DataTypes.INTEGER, allowNull: true }
    },
    {
      sequelize,
      modelName: 'Item',
      tableName: 'item',
      underscored: true,
      timestamps: true,
      updatedAt: false
    }
  );

  return Item;
};
