'use strict';

// Factory for the jest.mock('../../models', ...) replacement used by the
// report tests. Every model report.controller.js (and, transitively,
// borrow.controller.js / helpers/notify.js / helpers/transactionLog.js)
// destructures off `../models` needs a stub here, even ones the report
// endpoints never call, so requiring the mocked module never throws.
module.exports = function buildMockModels() {
  return {
    Transaction: { findAll: jest.fn() },
    TransactionDetail: { findAll: jest.fn() },
    Equipment: { findAll: jest.fn() },
    Category: { findAll: jest.fn() },
    Item: { findAll: jest.fn() },
    Borrower: { findAll: jest.fn() },
    User: { findAll: jest.fn(), count: jest.fn(), findByPk: jest.fn() },
    Notification: { create: jest.fn(), bulkCreate: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), destroy: jest.fn() },
    TransactionLog: { create: jest.fn() },
    MaintenanceFee: { findAll: jest.fn() },
    DamageLossRecord: { findAll: jest.fn() },
    sequelize: {}
  };
};
