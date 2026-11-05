'use strict';

// Email delivery for the notification engine. Wraps config/mailer.js and
// never throws: any failure (missing/invalid credentials, network error,
// provider rejection) is caught, logged, and reported back as
// { success: false, error } so the caller (helpers/notify.js) can record
// deliveryStatus: 'Failed' on the Notification row instead of the whole
// borrow/return/damage-loss request blowing up because an email didn't go
// out.

const { getTransport } = require('../../config/mailer');
const { buildEmailHtml } = require('./emailTemplate');

const DEFAULT_FROM = process.env.GMAIL_SMTP_USER || 'no-reply@rsu-sdpo.local';

// sendEmail(to, subject, message, { heading, recipientName }?) -> Promise<{ success, messageId? , error? }>
async function sendEmail(to, subject, message, opts = {}) {
  if (!to) {
    return { success: false, error: 'No recipient email address provided' };
  }

  try {
    const transport = getTransport();
    const info = await transport.sendMail({
      from: DEFAULT_FROM,
      to,
      subject,
      text: message,
      html: buildEmailHtml({ heading: opts.heading, recipientName: opts.recipientName, message })
    });

    return { success: true, messageId: info && info.messageId };
  } catch (err) {
    console.error(`[emailService] Failed to send email to ${to}:`, err.message || 'Unknown error');
    return { success: false, error: err.message || String(err) };
  }
}

module.exports = { sendEmail };
