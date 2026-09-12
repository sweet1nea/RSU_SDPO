'use strict';

// Nodemailer transport factory for the RSU SDPO notification engine.
//
// One delivery path, both environments: Gmail SMTP via GMAIL_SMTP_USER /
// GMAIL_SMTP_PASS (a Gmail App Password, not the account's regular login
// password — see .env.example). This project originally split Development
// (Gmail SMTP) from Production (Brevo's transactional email API), but Brevo
// was dropped in favor of Gmail SMTP everywhere: Brevo required account
// verification/payment friction this capstone's budget doesn't call for,
// and a plain Gmail account's 500-emails/day quota comfortably covers the
// SDPO's real usage (a handful of staff plus borrowers, not a public
// mailing list).
//
// Credentials are read from process.env only at call time (inside
// getTransport()), never captured at module-load time — so requiring this
// file never throws even when no .env is present, and each call reflects
// whatever environment is current.

const nodemailer = require('nodemailer');

// Short, explicit timeouts (nodemailer's SMTP defaults run into minutes) so
// that an unreachable/misconfigured SMTP server fails emailService.js's
// sendMail() quickly instead of stalling the borrow/return/damage-loss
// request that triggered the notification.
const SMTP_TIMEOUT_MS = 10000;

function buildGmailTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_SMTP_USER,
      pass: process.env.GMAIL_SMTP_PASS
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS
  });
}

// Returns the nodemailer transport to use. Always Gmail SMTP now — kept as
// its own function (rather than inlining buildGmailTransport's body here)
// so emailService.js's mock-the-transport-factory test setup keeps working
// unchanged, and so a future delivery path swap only touches this one spot.
function getTransport() {
  return buildGmailTransport();
}

module.exports = { getTransport };
