/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('channels', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable().unique();
    table.string('galaxy').notNullable().unique();
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('channels');
}
