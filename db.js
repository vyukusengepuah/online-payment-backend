const knex = require('knex');
const dotenv = require('dotenv');
dotenv.config();


const db = knex({
    client: 'mysql2',
    connection: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    }
});


const dbUat = knex({
    client: 'mysql2',
    connection: {
        host: '192.168.53.53',
        user: 'root',
        password: 'password',
        database: 'merchant_payment_uat'
    }
});

module.exports = { db, dbUat };