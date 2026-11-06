'use strict';

// Verifies server/jobs/incompleteRequirementsSweep.js against mocked
// Sequelize models and a mocked notify helper, following the same pattern
// as tests/unit/notify.test.js.

jest.mock('../../models', () => require('../fixtures/mockModels')());
jest.mock('../../helpers/notify');

const { Op } = require('sequelize');
const { Transaction } = require('../../models');
const { notifyBorrower } = require('../../helpers/notify');
const { runIncompleteRequirementsSweep } = require('../../jobs/incompleteRequirementsSweep');

function makeTxn(overrides = {}) {
  // Documents are checked on the request itself (migration 027), so the
  // snapshot mirrors the borrower's files unless a test overrides it.
  const b = overrides.borrower || { validIdPath: null, authorizationDocumentPath: null };
  return {
    validIdPath: b.validIdPath,
    authorizationDocumentPath: b.authorizationDocumentPath,
    id: 1,
    transactionStatus: 'For Review',
    incompleteReqReminderSentDatetime: null,
    borrower: {
      validIdPath: null,
      authorizationDocumentPath: null,
      user: { id: 5 }
    },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('jobs/incompleteRequirementsSweep.js', () => {
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

  test('queries active (Acknowledged/For Review/For Approval) transactions not yet reminded', async () => {
    Transaction.findAll.mockResolvedValue([]);

    await runIncompleteRequirementsSweep();

    const callArgs = Transaction.findAll.mock.calls[0][0];
    expect(callArgs.where.incompleteReqReminderSentDatetime).toBeNull();
    expect(callArgs.where.transactionStatus[Op.in]).toEqual(['Acknowledged', 'For Review', 'For Approval']);
  });

  test('notifies and names the missing Valid ID when only validIdPath is missing', async () => {
    const txn = makeTxn({
      id: 7,
      borrower: { validIdPath: null, authorizationDocumentPath: '/docs/auth.pdf', user: { id: 5 } }
    });
    Transaction.findAll.mockResolvedValue([txn]);

    await runIncompleteRequirementsSweep();

    expect(notifyBorrower).toHaveBeenCalledWith(
      5,
      expect.stringContaining('Valid ID'),
      'Incomplete Requirements',
      'txn-7-incomplete-requirements'
    );
    expect(notifyBorrower.mock.calls[0][1]).not.toContain('Authorization');
    expect(txn.incompleteReqReminderSentDatetime).toBeInstanceOf(Date);
    expect(txn.save).toHaveBeenCalledTimes(1);
  });

  test('notifies and names the missing Authorization Document when only that is missing', async () => {
    const txn = makeTxn({
      id: 8,
      borrower: { validIdPath: '/docs/id.png', authorizationDocumentPath: null, user: { id: 5 } }
    });
    Transaction.findAll.mockResolvedValue([txn]);

    await runIncompleteRequirementsSweep();

    expect(notifyBorrower).toHaveBeenCalledWith(
      5,
      expect.stringContaining('Authorization'),
      'Incomplete Requirements',
      'txn-8-incomplete-requirements'
    );
  });

  test('names both documents when both are missing', async () => {
    const txn = makeTxn({ id: 9 });
    Transaction.findAll.mockResolvedValue([txn]);

    await runIncompleteRequirementsSweep();

    const message = notifyBorrower.mock.calls[0][1];
    expect(message).toContain('Valid ID');
    expect(message).toContain('Authorization');
  });

  test('uses the borrower type\'s own rules: a Student needs only the authorization letter', async () => {
    const txn = makeTxn({
      id: 11,
      borrower: { borrowerCategory: 'Student', validIdPath: null, authorizationDocumentPath: '/docs/letter.pdf', user: { id: 5 } }
    });
    Transaction.findAll.mockResolvedValue([txn]);

    await runIncompleteRequirementsSweep();

    expect(notifyBorrower).not.toHaveBeenCalled();
  });

  test('a borrower with both documents present is marked sent but does NOT get notified', async () => {
    const txn = makeTxn({
      id: 10,
      borrower: { validIdPath: '/docs/id.png', authorizationDocumentPath: '/docs/auth.pdf', user: { id: 5 } }
    });
    Transaction.findAll.mockResolvedValue([txn]);

    await runIncompleteRequirementsSweep();

    expect(notifyBorrower).not.toHaveBeenCalled();
    expect(txn.incompleteReqReminderSentDatetime).toBeInstanceOf(Date);
    expect(txn.save).toHaveBeenCalledTimes(1);
  });

  test('a failure processing one transaction does not stop the others (per-row try/catch)', async () => {
    const failing = makeTxn({ id: 1, save: jest.fn().mockRejectedValue(new Error('DB write failed')) });
    const ok = makeTxn({ id: 2 });
    Transaction.findAll.mockResolvedValue([failing, ok]);

    await runIncompleteRequirementsSweep();

    expect(notifyBorrower).toHaveBeenCalledTimes(2);
    expect(ok.save).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
