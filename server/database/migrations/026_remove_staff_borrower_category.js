'use strict';

// The "Staff" borrower type is retired: Borrower Type is now Faculty,
// Employee, Student or External. "Staff" only ever described non-teaching
// university staff, who borrow under the same document requirement as an
// Employee (Approved Proposal / Request Letter), so any existing borrower
// with that type is recoded to Employee before the value is removed from
// the enum. (This is the borrower's *type*, not a login role — the four
// user roles Admin / Director / Staff / Borrower are unchanged.)
//
// Postgres has no ALTER TYPE ... DROP VALUE, so the type is rebuilt, same
// approach as migration 022.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE borrower SET borrower_category = 'Employee' WHERE borrower_category = 'Staff';
      ALTER TYPE enum_borrower_borrower_category RENAME TO enum_borrower_borrower_category_old;
      CREATE TYPE enum_borrower_borrower_category AS ENUM ('Faculty', 'Employee', 'Student', 'External');
      ALTER TABLE borrower ALTER COLUMN borrower_category TYPE enum_borrower_borrower_category
        USING borrower_category::text::enum_borrower_borrower_category;
      DROP TYPE enum_borrower_borrower_category_old;
    `);
  },

  async down(queryInterface) {
    // Restores the enum value only; borrowers recoded to Employee stay Employee.
    await queryInterface.sequelize.query(
      "ALTER TYPE enum_borrower_borrower_category ADD VALUE IF NOT EXISTS 'Staff'"
    );
  }
};
