// Dry-run by default. Never deletes records or changes trade outcomes.
require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    try {
        await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
        const collection = mongoose.connection.db.collection('predictions');
        const query = { user: null, deleteAfter: { $type: 'date' } };
        const count = await collection.countDocuments(query);
        console.log(`System signals scheduled for TTL deletion: ${count}`);
        if (process.argv.includes('--apply')) {
            const result = await collection.updateMany(query, { $unset: { deleteAfter: '' } });
            console.log(`Removed deletion timers from ${result.modifiedCount} system signals. Outcomes unchanged.`);
        } else console.log('Dry run only. Review the count and rerun with --apply to preserve these records.');
    } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
