'use strict';

const helmet = require('helmet');

// Extracted from server/app.js so the directive set can be asserted on
// directly in a unit test, without requiring app.js itself — that file
// calls app.listen(...) and attempts a real DB connection as an
// unconditional top-level side effect (see its own comments), so importing
// it in Jest would open a live port/DB handle rather than exercise plain
// config. No behavior change from what app.js previously inlined here.
function buildContentSecurityPolicyDirectives() {
  return {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    // client/ pages use inline <script> blocks and inline onclick/onchange
    // handlers throughout (not external .js files), so helmet's default CSP
    // — which blocks inline scripts even under 'self' — silently breaks
    // every click on the site. Relaxing script-src/script-src-attr here to
    // match style-src's existing 'unsafe-inline'. Before any public
    // deployment, migrate inline scripts to external files + nonces and
    // drop this back to the strict default.
    'script-src': ["'self'", "'unsafe-inline'"],
    'script-src-attr': ["'unsafe-inline'"],
    // The transaction-management document viewer (Valid ID / Authorization
    // Document review) fetches the file as a blob and displays it via
    // `URL.createObjectURL()`, producing a blob: URL used as an <img src>
    // (JPG/PNG/WEBP) or an <iframe src> (PDF). Helmet's default img-src is
    // 'self' data: (no blob:), and there's no default frame-src at all, so
    // it fell back to default-src 'self' — neither allows blob:. The
    // browser silently blocked both as a CSP violation (visible only in the
    // console, never surfaced to the user), rendering as a generic
    // broken-image placeholder for images and a blank frame for PDFs, with
    // no error message — indistinguishable from a missing/corrupt file.
    // Explicitly allowing blob: on both directives fixes the viewer;
    // nothing else in the client creates a blob: <img>/<iframe> (the only
    // other createObjectURL call, in reports-analytics.html, drives an
    // <a download> click, which isn't governed by these directives).
    'img-src': ["'self'", 'data:', 'blob:'],
    'frame-src': ["'self'", 'blob:'],
    // This server is plain HTTP only (no TLS listener) in development.
    // Helmet's defaults assume HTTPS: it sends Strict-Transport-Security and
    // a CSP with upgrade-insecure-requests, which tell the browser to force
    // this origin to https on every future visit. Since localhost:3000
    // never speaks TLS, that self-inflicts ERR_INVALID_HTTP_RESPONSE /
    // ERR_SSL_PROTOCOL_ERROR once the browser caches the policy. Disabled
    // here (hsts is disabled separately, in app.js); re-enable both once
    // this is actually served over HTTPS in production.
    'upgrade-insecure-requests': null
  };
}

module.exports = { buildContentSecurityPolicyDirectives };
