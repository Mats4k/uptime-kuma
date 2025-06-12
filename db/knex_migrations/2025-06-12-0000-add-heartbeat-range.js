exports.up = function (knex) {
    return knex.schema
        .alterTable("status_page", function (table) {
            table.integer("heartbeat_range_days").notNullable().defaultTo(0);
        });
};

exports.down = function (knex) {
    return knex.schema.alterTable("status_page", function (table) {
        table.dropColumn("heartbeat_range_days");
    });
}; 