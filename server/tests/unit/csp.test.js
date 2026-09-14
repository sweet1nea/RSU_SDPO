'use strict';

// Verifies server/config/csp.js#buildContentSecurityPolicyDirectives.
//
// Regression coverage for a real bug found 2026-09-14: the transaction
// management "View Document" modal (Valid ID / Authorization Document
// review) fetches the file as a blob and displays it via
// URL.createObjectURL(), producing a blob: URL used as an <img src>
// (JPG/PNG/WEBP) or an <iframe src> (PDF). Helmet's default CSP allows
// img-src 'self' data: (no blob:) and has no default frame-src at all
// (falls back to default-src 'self', also no blob:), so the browser
// silently blocked every document preview — a broken-image icon for
// images, a blank frame for PDFs — with no error surfaced to the user.

const { buildContentSecurityPolicyDirectives } = require('../../config/csp');

describe('buildContentSecurityPolicyDirectives', () => {
  const directives = buildContentSecurityPolicyDirectives();

  test('img-src allows blob: (document viewer image preview)', () => {
    expect(directives['img-src']).toEqual(expect.arrayContaining(['blob:']));
  });

  test('frame-src allows blob: (document viewer PDF preview)', () => {
    expect(directives['frame-src']).toEqual(expect.arrayContaining(['blob:']));
  });

  test('img-src and frame-src still scope to same-origin, not a blanket allow', () => {
    expect(directives['img-src']).toEqual(expect.arrayContaining(["'self'"]));
    expect(directives['frame-src']).toEqual(expect.arrayContaining(["'self'"]));
  });

  test('script-src allows unsafe-inline (client pages use inline <script>/onclick)', () => {
    expect(directives['script-src']).toEqual(expect.arrayContaining(["'unsafe-inline'"]));
    expect(directives['script-src-attr']).toEqual(expect.arrayContaining(["'unsafe-inline'"]));
  });

  test('upgrade-insecure-requests is disabled (plain-HTTP dev server)', () => {
    expect(directives['upgrade-insecure-requests']).toBeNull();
  });

  test('object-src stays at helmet\'s strict default (\'none\') — this fix does not widen it', () => {
    expect(directives['object-src']).toEqual(["'none'"]);
  });
});
