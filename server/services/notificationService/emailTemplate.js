'use strict';

// HTML layout shared by every outgoing email (notifications, verification
// codes, password reset codes). Structure: grey header band, white body with
// a centred heading, "Dear <name>," greeting, the message, closing, a
// "system generated" notice, and a grey footer band. Inline styles only —
// email clients ignore <style> blocks and external CSS.

const SYSTEM_NAME = 'RSU-SDPO';
const OFFICE = 'SPORTS DEVELOPMENT PROGRAM OFFICE';
const UNIVERSITY = 'ROMBLON STATE UNIVERSITY';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function buildEmailHtml({ heading, recipientName, message }) {
  const name = esc(recipientName || 'User');
  const body = esc(message).replace(/\n/g, '<br>');
  const year = new Date().getFullYear();
  const font = "font-family:Arial,Helvetica,sans-serif";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;${font}">
<tr><td align="center" style="background:#eaf0f6;padding:34px 20px;font-size:22px;font-weight:bold;color:#374151;${font}">${SYSTEM_NAME}</td></tr>
<tr><td style="padding:34px 36px 10px;${font}">
<h2 style="margin:0 0 26px;text-align:center;font-size:18px;line-height:1.4;color:#5b6b7f;text-transform:uppercase">${esc(heading || 'Notification')}</h2>
<p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#6b7280">Dear <b>${name}</b>,</p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#6b7280">${body}</p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#6b7280">Thank you.</p>
<p style="margin:0 0 22px;font-size:14px;line-height:1.7;color:#6b7280">${OFFICE}<br>${UNIVERSITY}</p>
<p style="margin:0 0 20px;text-align:center;font-size:13px;line-height:1.6;color:#6b7280">*** This is a system generated message. <b>DO NOT REPLY TO THIS EMAIL.</b> ***</p>
</td></tr>
<tr><td align="center" style="background:#eaf0f6;padding:34px 20px;font-size:12px;color:#9ca3af;${font}">&copy; ${year} ${SYSTEM_NAME}. All rights reserved.</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { buildEmailHtml };
