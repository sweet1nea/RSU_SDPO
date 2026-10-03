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

  // Regression coverage for a real bug found 2026-10-03: borrower document
  // uploads (Valid ID / Authorization Document) go straight from the
  // browser to Supabase Storage via a signed URL (see
  // client/js/shared/api.js#uploadBorrowerDocument), bypassing this
  // server's own 4.5MB Vercel body limit. Helmet's default connect-src is
  // 'self' only, so the browser silently blocked that cross-origin fetch()
  // as a CSP violation — no server-side request, no parsed API error, just
  // a bare "Failed to fetch" shown to the borrower with nothing to debug.
  describe('connect-src (Supabase Storage direct upload)', () => {
    const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
    afterEach(() => {
      process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL;
    });

    test('allows the configured SUPABASE_URL in addition to same-origin', () => {
      process.env.SUPABASE_URL = 'https://elazuiszetwadorgperc.supabase.co';
      jest.resetModules();
      const { buildContentSecurityPolicyDirectives: rebuild } = require('../../config/csp');
      const rebuilt = rebuild();
      expect(rebuilt['connect-src']).toEqual(expect.arrayContaining(["'self'", 'https://elazuiszetwadorgperc.supabase.co']));
    });

    test('still scopes to self even if SUPABASE_URL is unset (no crash, no accidental wildcard)', () => {
      delete process.env.SUPABASE_URL;
      jest.resetModules();
      const { buildContentSecurityPolicyDirectives: rebuild } = require('../../config/csp');
      const rebuilt = rebuild();
      expect(rebuilt['connect-src']).toEqual(["'self'"]);
    });
  });
});
