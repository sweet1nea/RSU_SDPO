'use strict';

// Each request keeps its own copy of the documents submitted with it.
// Before this, documents lived only on the borrower record, so uploading a
// new file for a later request replaced what every earlier request showed.
// Existing transactions are backfilled from the borrower's current files so
// nothing that is viewable today becomes unviewable.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transaction', 'valid_id_path', { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.addColumn('transaction', 'authorization_document_path', { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.sequelize.query(`
      UPDATE transaction t
         SET valid_id_path = b.valid_id_path,
             authorization_document_path = b.authorization_document_path
        FROM borrower b
       WHERE b.borrower_id = t.borrower_id
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('transaction', 'authorization_document_path');
    await queryInterface.removeColumn('transaction', 'valid_id_path');
  }
};
