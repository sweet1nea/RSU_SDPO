'use strict';

// Verifies server/services/notificationService/emailService.js's contract:
// sendEmail(to, subject, message) must NEVER throw/reject, and must always
// resolve to { success: true, messageId } on success or
// { success: false, error } on failure. The underlying transport
// (config/mailer.js's getTransport()) is mocked so no real network call to
// Gmail/Brevo ever happens.

jest.mock('../../config/mailer');

const { getTransport } = require('../../config/mailer');
const { sendEmail } = require('../../services/notificationService/emailService');

describe('emailService.sendEmail', () => {
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    // Silence expected console.error output from the caught-failure paths
    // so test output stays clean; still allows assertions elsewhere.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('resolves { success: true, messageId } when the transport succeeds', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'abc-123' });
    getTransport.mockReturnValue({ sendMail });

    const result = await sendEmail('borrower@example.com', 'Subject', 'Body text');

    expect(result).toEqual({ success: true, messageId: 'abc-123' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'borrower@example.com',
        subject: 'Subject',
        text: 'Body text'
      })
    );
  });

  test('resolves { success: false, error } instead of throwing when the transport rejects', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('SMTP connection timed out'));
    getTransport.mockReturnValue({ sendMail });

    await expect(sendEmail('borrower@example.com', 'Subject', 'Body')).resolves.toEqual({
      success: false,
      error: 'SMTP connection timed out'
    });
  });

  test('resolves { success: false, error } instead of throwing when getTransport() itself throws synchronously', async () => {
    getTransport.mockImplementation(() => {
      throw new Error('BREVO_API_KEY is not set');
    });

    await expect(sendEmail('borrower@example.com', 'Subject', 'Body')).resolves.toEqual({
      success: false,
      error: 'BREVO_API_KEY is not set'
    });
  });

  test('resolves { success: false, error } instead of throwing when the transport rejects with a non-Error value', async () => {
    const sendMail = jest.fn().mockRejectedValue('raw string rejection');
    getTransport.mockReturnValue({ sendMail });

    await expect(sendEmail('borrower@example.com', 'Subject', 'Body')).resolves.toEqual({
      success: false,
      error: 'raw string rejection'
    });
  });

  test('resolves { success: false } without calling the transport when no recipient is given', async () => {
    const sendMail = jest.fn();
    getTransport.mockReturnValue({ sendMail });

    const result = await sendEmail(undefined, 'Subject', 'Body');

    expect(result.success).toBe(false);
    expect(result.error).toEqual(expect.any(String));
    expect(sendMail).not.toHaveBeenCalled();
  });

  // Security note (see verification report step 5): emailService now logs
  // `err.message || 'Unknown error'`, so a rejection with an empty/falsy
  // `.message` never causes the raw error object to be logged. This matters
  // because for a Brevo axios error, that object carries
  // `.config.headers['api-key']`, which Node's console.error would otherwise
  // print as an own enumerable property of the Error. This test confirms the
  // API key never reaches the log output even when `.message` is falsy.
  test('logs a safe fallback string (never the raw error object) when err.message is falsy, so credentials are never logged', async () => {
    const credentialBearingError = new Error('');
    credentialBearingError.config = { headers: { 'api-key': 'SECRET_BREVO_KEY' } };
    const sendMail = jest.fn().mockRejectedValue(credentialBearingError);
    getTransport.mockReturnValue({ sendMail });

    await sendEmail('to@example.com', 'Subject', 'Body');

    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), 'Unknown error');
    expect(errorSpy).not.toHaveBeenCalledWith(expect.any(String), credentialBearingError);
  });
});

describe('email HTML layout', () => {
  test('sendEmail sends an HTML body with greeting, message, notice and footer alongside the plain text', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'x' });
    getTransport.mockReturnValue({ sendMail });

    await sendEmail('a@b.com', 'S', 'Your request <was> submitted.', { heading: 'Request Submitted', recipientName: 'Juan Dela Cruz' });

    const arg = sendMail.mock.calls[0][0];
    expect(arg.text).toBe('Your request <was> submitted.');
    expect(arg.html).toContain('Request Submitted');
    expect(arg.html).toContain('Dear <b>Juan Dela Cruz</b>,');
    expect(arg.html).toContain('Your request &lt;was&gt; submitted.');
    expect(arg.html).toContain('DO NOT REPLY TO THIS EMAIL.');
    expect(arg.html).toContain('All rights reserved.');
  });
});
