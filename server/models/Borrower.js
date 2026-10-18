'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Borrower extends Model {
    static associate(models) {
      Borrower.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
      Borrower.hasMany(models.Item, { foreignKey: 'currentBorrowerId', as: 'currentItems' });
      Borrower.hasMany(models.Transaction, { foreignKey: 'borrowerId', as: 'transactions' });
    }
  }

  Borrower.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'borrower_id' },
      userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      firstName: { type: DataTypes.STRING(100), allowNull: false },
      lastName: { type: DataTypes.STRING(100), allowNull: false },
      middleName: { type: DataTypes.STRING(100), allowNull: true },
      collegeOrUnit: { type: DataTypes.STRING(200), allowNull: false },
      borrowerCategory: {
        type: DataTypes.ENUM('Faculty', 'Employee', 'Student', 'External'),
        allowNull: false
      },
      validIdPath: { type: DataTypes.STRING(255), allowNull: true },
      authorizationDocumentPath: { type: DataTypes.STRING(255), allowNull: true },
      directorAuthorizationStatus: {
        type: DataTypes.ENUM('Not Required', 'Pending', 'Authorized'),
        allowNull: false,
        defaultValue: 'Not Required'
      }
    },
    {
      sequelize,
      modelName: 'Borrower',
      tableName: 'borrower',
      underscored: true,
      timestamps: true
    }
  );

  return Borrower;
};
