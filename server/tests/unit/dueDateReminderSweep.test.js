'use strict';

// Verifies server/jobs/dueDateReminderSweep.js against mocked Sequelize
// models and a mocked notify helper, following the same pattern as
// tests/unit/notify.test.js.

jest.mock('../../models', () => require('../fixtures/mockModels')());
jest.mock('../../helpers/notify');

const { Op } = require('sequelize');
const { Transaction } = require('../../models');
const { notifyBorrower } = require('../../helpers/notify');
const { runDueDateReminderSweep } = require('../../jobs/dueDateReminderSweep');

function makeTxn(overrides = {}) {
  return {
    id: 1,
    transactionStatus: 'Released',
    expectedReturnDatetime: new Date(),
    dueReminderSentDatetime: null,
    borrower: { user: { id: 5 } },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('jobs/dueDateReminderSweep.js', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    notifyBorrower.mockResolvedValue({ id: 100 });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('notifies the borrower and stamps dueReminderSentDatetime for a qualifying transaction', async () => {
    const txn = makeTxn({ id: 42 });
    Transaction.findAll.mockResolvedValue([txn]);

    await runDueDateReminderSweep();

    expect(notifyBorrower).toHaveBeenCalledWith(5, expect.stringContaining('Transaction TN42-2026'), 'Due Date Reminder', 'txn-42-due-reminder');
    expect(txn.dueReminderSentDatetime).toBeInstanceOf(Date);
    expect(txn.save).toHaveBeenCalledTimes(1);
    expect(txn.transactionStatus).toBe('Released');
  });

  test('queries only Released transactions due within the next 24 hours that have not already been reminded', async () => {
    Transaction.findAll.mockResolvedValue([]);

    await runDueDateReminderSweep();

    const callArgs = Transaction.findAll.mock.calls[0][0];
    expect(callArgs.where.transactionStatus).toBe('Released');
    expect(callArgs.where.dueReminderSentDatetime).toBeNull();
    expect(callArgs.where.expectedReturnDatetime[Op.between]).toHaveLength(2);
  });

  test('does nothing when no transactions qualify (already overdue or already reminded are excluded by the query itself)', async () => {
    Transaction.findAll.mockResolvedValue([]);

    await runDueDateReminderSweep();

    expect(notifyBorrower).not.toHaveBeenCalled();
  });

  test('a failure processing one transaction does not stop the others (per-row try/catch)', async () => {
    const failing = makeTxn({ id: 1, save: jest.fn().mockRejectedValue(new Error('DB write failed')) });
    const ok = makeTxn({ id: 2 });
    Transaction.findAll.mockResolvedValue([failing, ok]);

    await runDueDateReminderSweep();

    expect(notifyBorrower).toHaveBeenCalledTimes(2);
    expect(ok.save).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('skips notifying when the transaction has no linked borrower/user, but still marks it processed', async () => {
    const txn = makeTxn({ borrower: null });
    Transaction.findAll.mockResolvedValue([txn]);

    await runDueDateReminderSweep();

    expect(notifyBorrower).not.toHaveBeenCalled();
    expect(txn.dueReminderSentDatetime).toBeInstanceOf(Date);
    expect(txn.save).toHaveBeenCalledTimes(1);
  });
});
