const db = require('../db');
exports.insert = async (req) => { return await db(req.table).insert([req.culomn]); };
exports.getList = async (req) => { return await db(req.table).select(); };
