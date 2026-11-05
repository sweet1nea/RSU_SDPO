'use strict';

// Verifies server/jobs/overdueSweep.js against mocked Sequelize models and
// mocked notify/transactionLog helpers, following the same pattern as
// tests/unit/dueDateReminderSweep.test.js.
//
// Medium #5 from the 2026-09-08 system audit: the per-transaction body had
// no try/catch, so one failing row (a bad save(), a notify() throw) aborted
// the whole loop and silently skipped every remaining overdue transaction
// in that hourly run — unrelated borrowers' items just wouldn't get
// flagged, logged, or notified about until the next run picked them up.

jest.mock('../../models', () => require('../fixtures/mockModels')());
jest.mock('../../helpers/notify');

const { Op } = require('sequelize');
const { Transaction, TransactionLog } = require('../../models');
const { notifyBorrower, notifyStaff } = require('../../helpers/notify');
const { runOverdueSweep } = require('../../jobs/overdueSweep');

function makeTxn(overrides = {}) {
  return {
    id: 1,
    transactionStatus: 'Released',
    expectedReturnDatetime: new Date(Date.now() - 24 * 60 * 60 * 1000),
    borrower: { user: { id: 5 } },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('jobs/overdueSweep.js', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    notifyBorrower.mockResolvedValue({ id: 100 });
    notifyStaff.mockResolvedValue(undefined);
    TransactionLog.create.mockResolvedValue({ id: 1 });
    // The status flip is a conditional UPDATE (only while still Released).
    Transaction.update = jest.fn().mockResolvedValue([1]);
  });

  const flippedIds = () => Transaction.update.mock.calls.map((c) => c[1].where.id);

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('flips a qualifying Released transaction to Overdue, logs it, and notifies borrower + staff', async () => {
    const txn = makeTxn({ id: 42 });
    Transaction.findAll.mockResolvedValue([txn]);

    await runOverdueSweep();

    expect(Transaction.update).toHaveBeenCalledWith({ transactionStatus: 'Overdue' }, { where: { id: 42, transactionStatus: 'Released' } });
    expect(TransactionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 42, oldStatus: 'Released', newStatus: 'Overdue' })
    );
    expect(notifyBorrower).toHaveBeenCalledWith(5, expect.stringContaining('Transaction TN42-2026'), 'Overdue', 'txn-42-overdue');
    expect(notifyStaff).toHaveBeenCalledWith(expect.stringContaining('Transaction TN42-2026'), 'Overdue', 'txn-42-overdue');
  });

  test('queries only Released transactions whose expected return date has already passed', async () => {
    Transaction.findAll.mockResolvedValue([]);

    await runOverdueSweep();

    const callArgs = Transaction.findAll.mock.calls[0][0];
    expect(callArgs.where.transactionStatus).toBe('Released');
    expect(callArgs.where.expectedReturnDatetime[Op.lt]).toBeInstanceOf(Date);
  });

  test('a failure processing one transaction does not stop the others from being flagged (per-row try/catch)', async () => {
    const failing = makeTxn({ id: 1 });
    Transaction.update.mockRejectedValueOnce(new Error('DB write failed'));
    const ok = makeTxn({ id: 2 });
    Transaction.findAll.mockResolvedValue([failing, ok]);

    await runOverdueSweep();

    expect(errorSpy).toHaveBeenCalled();
    // The failing row's update rejected, so nothing after it in its own
    // try block ran (no log entry, no notifications) — but the loop moved
    // on to the next transaction instead of throwing out entirely.
    expect(TransactionLog.create).not.toHaveBeenCalledWith(expect.objectContaining({ transactionId: 1 }));
    // The good row right after it still went through, instead of the whole
    // batch being abandoned.
    expect(flippedIds()).toContain(2);
    expect(notifyBorrower).toHaveBeenCalledWith(5, expect.stringContaining('Transaction TN2-2026'), 'Overdue', 'txn-2-overdue');
    expect(notifyBorrower).not.toHaveBeenCalledWith(5, expect.stringContaining('Transaction TN1-2026'), 'Overdue', expect.anything());
  });

  test('a notifyStaff failure for one transaction does not stop the next transaction from being processed', async () => {
    const first = makeTxn({ id: 1 });
    const second = makeTxn({ id: 2 });
    Transaction.findAll.mockResolvedValue([first, second]);
    notifyStaff.mockRejectedValueOnce(new Error('SMS gateway down'));

    await runOverdueSweep();

    expect(errorSpy).toHaveBeenCalled();
    expect(flippedIds()).toEqual([1, 2]);
  });

  test('skips notifying a borrower with no linked user, but still flags the transaction', async () => {
    const txn = makeTxn({ id: 7, borrower: null });
    Transaction.findAll.mockResolvedValue([txn]);

    await runOverdueSweep();

    expect(notifyBorrower).not.toHaveBeenCalled();
    expect(flippedIds()).toEqual([7]);
    expect(notifyStaff).toHaveBeenCalledWith(expect.stringContaining('Transaction TN7-2026'), 'Overdue', 'txn-7-overdue');
  });

  test('a transaction returned between the query and the update is skipped (no duplicate overdue notice)', async () => {
    Transaction.findAll.mockResolvedValue([makeTxn({ id: 3 })]);
    Transaction.update.mockResolvedValueOnce([0]);

    await runOverdueSweep();

    expect(TransactionLog.create).not.toHaveBeenCalled();
    expect(notifyBorrower).not.toHaveBeenCalled();
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  test('does nothing when no transactions qualify', async () => {
    Transaction.findAll.mockResolvedValue([]);

    await runOverdueSweep();

    expect(notifyBorrower).not.toHaveBeenCalled();
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
