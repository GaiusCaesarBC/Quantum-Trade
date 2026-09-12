const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const express = require('express');
const bcrypt = require('bcryptjs');
const { verifyAccessToken, verifyChallengeToken } = require('../utils/authTokens');

test('both login URLs require a challenge and the real 2FA route completes it', async () => {
    process.env.JWT_SECRET = 'isolated-route-test-key';
    let sentCode;
    const user = { id: 'user-123', username: 'tester', email: 'tester@example.com',
        password: await bcrypt.hash('test-password',4),
        twoFactor: { enabled: true, method: 'email', codesSentCount: 0, backupCodes: [] },
        async save() {}, async checkLoginStreak() { return { isNewDay:false, streak:1 }; } };
    const users = { findOne:async()=>user, findById:async()=>user };
    const pass = (req,res,next)=>next();
    function load(file, extra={}) {
        const filename=path.resolve(__dirname,'../routes',file);
        const native=createRequire(filename);
        const doubles={ '../models/User':users, '../config/cloudinaryConfig':{upload:{single:()=>pass},cloudinary:{}},
            '../middleware/botProtection':{strictBotProtection:pass}, '../services/notificationService':{},
            '../services/emailService':{send2FACode:async(email,code)=>{sentCode=code;}},
            '../services/smsService':{}, ...extra };
        const context={module:{exports:{}},require:n=>n in doubles?doubles[n]:native(n),process,
            console:{log(){},warn(){},error(){}},Buffer,setTimeout,clearTimeout};
        vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
        return context.module.exports;
    }
    const authRoutes=load('authRoutes.js');
    const app=express(); app.use(express.json());
    app.use('/api/auth',authRoutes);
    app.use('/api/users',load('userRoutes.js',{'./authRoutes':authRoutes}));
    app.use('/api/2fa',load('twoFactorRoutes.js'));
    const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
    const url=`http://127.0.0.1:${server.address().port}`;
    const post=async(route,body)=>{const response=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return {status:response.status,body:await response.json()};};
    try {
        for(const route of ['/api/auth/login','/api/users/login']) {
            const login=await post(route,{email:user.email,password:'test-password'});
            assert.equal(login.status,200); assert.equal(login.body.requires2FA,true);
            assert.equal(login.body.token,undefined);
            assert.equal(verifyChallengeToken(login.body.tempToken).user.id,user.id);
            assert.throws(()=>verifyAccessToken(login.body.tempToken));
            const sent=await post('/api/2fa/send-login-code',{tempToken:login.body.tempToken});
            assert.equal(sent.status,200,JSON.stringify(sent.body)); assert.ok(sentCode);
            const verified=await post('/api/2fa/verify-login',{tempToken:login.body.tempToken,code:sentCode});
            assert.equal(verified.status,200,JSON.stringify(verified.body));
            assert.equal(verifyAccessToken(verified.body.token).user.id,user.id);
        }
    } finally { await new Promise(resolve=>server.close(resolve)); }
});
