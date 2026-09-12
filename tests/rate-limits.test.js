const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const rateLimit = require('express-rate-limit');

test('admin and prediction limits stop requests before database middleware', async () => {
    for (const [file, name, max] of [['app.js', 'adminLimiter', 20], ['routes/predictionsRoutes.js', 'predictionReadLimiter', 100]]) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        const declaration = source.match(new RegExp(`const ${name} = rateLimit\\(\\{[\\s\\S]*?\\}\\);`));
        assert.ok(declaration);
        const limiter = vm.runInNewContext(`${declaration[0]}\n${name}`, { rateLimit });
        if (name === 'adminLimiter') {
            const adminRoutes = source.match(/app\.(?:get|post)\([^\n]*requireAdmin[^\n]*/g);
            assert.equal(adminRoutes.length, 9);
            for (const route of adminRoutes) assert.match(route, /adminLimiter, auth, requireAdmin/);
        } else {
            assert.ok(source.indexOf('router.use(predictionReadLimiter)') < source.indexOf("router.use(['/recent'"));
            assert.ok(source.indexOf('router.use(predictionReadLimiter)') < source.indexOf('router.get('));
        }
        const app = express();
        let databaseCalls = 0;
        app.use(limiter);
        app.get('/', (req, res) => { databaseCalls++; res.sendStatus(200); });
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        try {
            const url = `http://127.0.0.1:${server.address().port}/`;
            for (let i = 0; i < max; i++) {
                const response = await fetch(url);
                assert.equal(response.status, 200);
                await response.text();
            }
            const blocked = await fetch(url);
            assert.equal(blocked.status, 429);
            await blocked.text();
            assert.equal(databaseCalls, max);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    }
});
