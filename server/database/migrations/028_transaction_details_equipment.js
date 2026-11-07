'use strict';

// Stock is now reserved when a request is APPROVED, not when it is
// submitted. A pending request therefore names the equipment (and one row
// per requested unit) without yet pointing at a physical unit, so
// transaction_details gets its own equipment_id and item_id becomes
// nullable until approval assigns the units. Existing rows are backfilled
// from their item so nothing changes for requests already in progress.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transaction_details', 'equipment_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'equipment', key: 'equipment_id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT'
    });
    await queryInterface.sequelize.query(`
      UPDATE transaction_details d
         SET equipment_id = i.equipment_id
        FROM item i
       WHERE i.item_id = d.item_id
    `);
    await queryInterface.changeColumn('transaction_details', 'equipment_id', { type: Sequelize.INTEGER, allowNull: false });
    await queryInterface.changeColumn('transaction_details', 'item_id', { type: Sequelize.INTEGER, allowNull: true });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('DELETE FROM transaction_details WHERE item_id IS NULL');
    await queryInterface.changeColumn('transaction_details', 'item_id', { type: Sequelize.INTEGER, allowNull: false });
    await queryInterface.removeColumn('transaction_details', 'equipment_id');
  }
};
