/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('users', (table) => {
    table.string('user_id').primary();
    table.string('username').notNullable();
    table.specificType('planets', 'text[]').notNullable().defaultTo('{}');
  });

  await knex.schema.createTable('planets', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.string('user').notNullable().references('user_id').inTable('users').onDelete('CASCADE');
    table.string('galaxy').notNullable();
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('planets');
  await knex.schema.dropTableIfExists('users');
}
