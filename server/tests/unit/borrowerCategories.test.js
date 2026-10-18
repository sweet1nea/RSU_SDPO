'use strict';

const { BORROWER_CATEGORIES, DOCUMENT_REQUIREMENTS, requirementsFor } = require('../../constants/borrowerCategories');

describe('Borrower Types', () => {
  test('are exactly Faculty, Employee, Student and External — "Staff" is not a borrower type', () => {
    expect(BORROWER_CATEGORIES).toEqual(['Faculty', 'Employee', 'Student', 'External']);
    expect(Object.keys(DOCUMENT_REQUIREMENTS)).toEqual(BORROWER_CATEGORIES);
  });

  test('every borrower type has its own document requirement (no fallback needed)', () => {
    BORROWER_CATEGORIES.forEach((c) => expect(requirementsFor(c)).toBe(DOCUMENT_REQUIREMENTS[c]));
  });
});
