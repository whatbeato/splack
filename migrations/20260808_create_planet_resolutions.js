/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable('planet_resolutions', (table) => {
    table.string('message_ts').primary();
    table.string('channel').notNullable();
    table.string('status').notNullable();
    table.string('resolved_by').notNullable();
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('planet_resolutions');
}
