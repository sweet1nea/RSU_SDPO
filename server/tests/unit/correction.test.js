'use strict';

// Return-for-Correction round trip: SDPO returns a request (logged
// Acknowledged -> Acknowledged), the borrower re-uploads, staff are told, and
// the request stops showing "Needs Correction" until SDPO returns it again.

jest.mock('../../models', () => ({
  Transaction: { findAll: jest.fn() },
  TransactionLog: {}
}));
jest.mock('../../helpers/notify', () => ({ notifyStaff: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../helpers/transactionLog', () => ({ logStatusChange: jest.fn().mockResolvedValue({ id: 99 }) }));

const { Transaction } = require('../../models');
const { notifyStaff } = require('../../helpers/notify');
const { logStatusChange } = require('../../helpers/transactionLog');
const { REUPLOAD_REMARK, lastCorrectionLog, recordResubmission } = require('../../helpers/correction');

const ACK = 'Acknowledged';
const log = (id, minute, remarks) => ({
  id,
  oldStatus: ACK,
  newStatus: ACK,
  changeDatetime: new Date(2026, 9, 20, 10, minute),
  remarks
});
const txn = (logs, status = ACK) => ({ id: 18, transactionStatus: status, logs });

beforeEach(() => jest.clearAllMocks());

describe('lastCorrectionLog', () => {
  test('only the creation log -> no correction', () => {
    expect(lastCorrectionLog(txn([log(1, 0, 'Request submitted by borrower')]))).toBeNull();
  });
  test('a later Acknowledged->Acknowledged log is a correction', () => {
    const c = log(2, 5, 'Incorrect Document.');
    expect(lastCorrectionLog(txn([log(1, 0, 'submitted'), c]))).toBe(c);
  });
  test('a borrower re-upload after the correction clears it', () => {
    expect(lastCorrectionLog(txn([log(1, 0, 'submitted'), log(2, 5, 'Incorrect'), log(3, 9, REUPLOAD_REMARK)]))).toBeNull();
  });
  test('a second correction after the re-upload is a correction again', () => {
    const c2 = log(4, 15, 'Still blurry');
    expect(lastCorrectionLog(txn([log(1, 0, 's'), log(2, 5, 'x'), log(3, 9, REUPLOAD_REMARK), c2]))).toBe(c2);
  });
  test('not waiting for review -> never a correction', () => {
    expect(lastCorrectionLog(txn([log(1, 0, 's'), log(2, 5, 'x')], 'Approved'))).toBeNull();
  });
});

describe('recordResubmission', () => {
  const borrower = { id: 7, userId: 70, firstName: 'Laurence', lastName: 'Dioco' };

  test('logs the re-upload and notifies staff for a request waiting on correction', async () => {
    Transaction.findAll.mockResolvedValue([txn([log(1, 0, 's'), log(2, 5, 'Incorrect Document.')])]);
    await recordResubmission(borrower);
    expect(logStatusChange).toHaveBeenCalledWith(18, 70, ACK, ACK, REUPLOAD_REMARK);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(notifyStaff.mock.calls[0][0]).toMatch(/Laurence Dioco re-uploaded documents for Transaction #18/);
    expect(notifyStaff.mock.calls[0][2]).toBe('txn-18-reupload-2');
  });
  test('does nothing for a request that was never returned', async () => {
    Transaction.findAll.mockResolvedValue([txn([log(1, 0, 's')])]);
    await recordResubmission(borrower);
    expect(logStatusChange).not.toHaveBeenCalled();
    expect(notifyStaff).not.toHaveBeenCalled();
  });
  test('does nothing again once the borrower has already responded', async () => {
    Transaction.findAll.mockResolvedValue([txn([log(1, 0, 's'), log(2, 5, 'x'), log(3, 9, REUPLOAD_REMARK)])]);
    await recordResubmission(borrower);
    expect(logStatusChange).not.toHaveBeenCalled();
  });
  test('never throws, so a failure cannot fail the upload', async () => {
    Transaction.findAll.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordResubmission(borrower)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
