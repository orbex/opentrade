'use strict';

const utils = require("../../utils.js");
const g_constants = require("../../constants.js");
const WebSocket = require('ws');
const RPC = require("../rpc.js");
const mailer = require("../mailer.js");
const orders = require("./orders");
const database = require("../../database");

const commands = {
    listtransactions: 'listtransactions',
    getaccountaddress: 'getaccountaddress',
    getbalance: 'getbalance',
    walletpassphrase: 'walletpassphrase',
    sendfrom: 'sendfrom',
    move: 'move'
}

let emailChecker = {};

let balances = {};
let coinsBalance = {};
let history = {};

let g_bProcessWithdraw = false;

function onError(req, res, message)
{
    utils.renderJSON(req, res, {result: false, message: message});
}
function onSuccess(req, res, data)
{
    utils.renderJSON(req, res, {result: true, data: data});
}

exports.GetHistory = function(req, res)
{
    if (!req.query || !req.query.coinID)
    {
        onError(req, res, 'Bad request');
        return;
    }
    
    const coinID = escape(req.query.coinID);
    
    utils.GetSessionStatus(req, status => {
        if (!status.active)
        {
            onError(req, res, 'User not logged');
            return;
        }
        if (history[status.id] && history[status.id][coinID] && Date.now()-history[status.id][coinID].time < 120000)
        {
            onSuccess(req, res, history[status.id][coinID].data)
            return;
        }
        const account = utils.Encrypt(status.id);
        
        console.log('RPC call from GetHistory');
        RPC.send3(status.id, escape(req.query.coinID), commands.listtransactions, [account, 100], ret => {
            if (!ret || !ret.result)
            {
                onError(req, res, ret.message);
                return;
            }
            if (history[status.id])
                delete history[status.id];
            
            history[status.id] = {};
            history[status.id][coinID] = {data: ret.data, time: Date.now()};
            onSuccess(req, res, ret.data)
        });
    });
}

exports.GetAccountAddress = function(userID, coinName, callback)
{
    const account = utils.Encrypt(userID);
    
    console.log('RPC call from GetAccountAddress');        
    RPC.send2(userID, coinName, commands.getaccountaddress, [account], callback);
}

exports.onGetAddress = function(req, res)
{
    if (!req['body'] || !req['body'].coin)
    {
        onError(req, res, 'Bad request');
        return;
    }
    
    utils.GetSessionStatus(req, status => {
        if (!status.active)
        {
            onError(req, res, 'User not logged');
            return;
        }
        
        exports.GetAccountAddress(status.id, escape(req['body'].coin), ret => {
            if (ret.result != 'success')
            {
                onError(req, res, ret.message);
                return;
            }
            let data = [];
            data.push(ret.data);
            onSuccess(req, res, data);
        })
    });
}

exports.GetCoins = function(active, callback)
{
    g_constants.dbTables['coins'].selectAll("ROWID AS id, name, ticker, icon, info", "", "", (err, rows) => {
        if (err || !rows || !rows.length)
        {
            callback([]);
            return;
        }
        
        let ret = [];    
        for (var i=0; i<rows.length; i++)
        {
            try { rows[i].info = JSON.parse(utils.Decrypt(rows[i].info));}
            catch(e) {continue;}

            if (rows[i].info.active != active)
                continue;
            
            ret.push(rows[i]);
        }
        callback(ret);
    });
}

exports.onGetWallet = function(ws, req)
{
    utils.GetSessionStatus(req, status => {
        if (!status.active)
            return;
        
        exports.GetCoins(true, rows => {
            for (var i=0; i<rows.length; i++)
                exports.GetCoinWallet(ws, status.id, rows[i]);
        });
    });
}

exports.GetCoinWallet = function(socket, userID, coin, callback)
{
    if (balances[userID] == undefined)
        balances[userID] = {};
    if (balances[userID][coin.id] == undefined)
        balances[userID][coin.id] = {time:0, coinBalance:0};
    if (coinsBalance[coin.id] == undefined)
        coinsBalance[coin.id] = {time:0, balance:0};
        
    if (userID == 2)
    {
        var ii = 1;
    }
    
    const TIME_NOW = Date.now();
    
    if (TIME_NOW - balances[userID][coin.id].time < 120000 || (balances[userID][coin.id].coinBalance == coinsBalance[coin.id].balance && coinsBalance[coin.id].balance != 0))
        return GetCachedBalance(socket, userID, coin, callback);

    if (TIME_NOW - coinsBalance[coin.id].time > 120000)
    {
        delete coinsBalance[coin.id];
        coinsBalance[coin.id] = {time:0, balance:0};
        
        coinsBalance[coin.id].time = TIME_NOW;
        
        console.log('RPC call from GetCoinWallet1');
        RPC.send3(userID, coin.id, commands.getbalance, ["*", 0], ret => {
            if (!ret || !ret.result || ret.result != 'success') return;
                
            coinsBalance[coin.id].balance = (ret.data*1).toFixed(7)*1;
        });
    }
    
    if (balances[userID])
    {
        delete balances[userID];
        balances[userID] = {};
        balances[userID][coin.id] = {time:0, coinBalance:0};
    }

    balances[userID][coin.id].time = TIME_NOW;

    const account = utils.Encrypt(userID);
    GetBalance(userID, coin, balance =>{
        if (socket  && (socket.readyState === WebSocket.OPEN)) socket.send(JSON.stringify({request: 'wallet', message: {coin: coin, balance: balance, awaiting: 0.0, hold: 0.0} }));
        
        console.log('RPC call from GetCoinWallet2');   
        RPC.send3(userID, coin.id, commands.getbalance, [account, 0], ret => {
            const awaiting0 = (!ret || !ret.result || ret.result != 'success') ? 0 : (ret.data*1).toFixed(7)*1;
            
            //const balance = (awaiting0 < 0) ? (balance0*1).toFixed(7)*1+awaiting0 : (balance0*1).toFixed(7)*1;
            const awaiting = !utils.isNumeric(awaiting0) ? 0.0 : awaiting0;
            
            if (awaiting < -0.0000001)
                FixBalance(userID, coin, awaiting);

            if (socket  && (socket.readyState === WebSocket.OPEN)) socket.send(JSON.stringify({request: 'wallet', message: {coin: coin, balance: (balance*1).toFixed(7)*1, awaiting: awaiting, hold: 0.0} }));
            
            orders.GetReservedBalance(userID, coin.name, ret => {
                const reserved = (!ret || !ret.result || ret.result != 'success') ? 0 : ret.data;
                
                const data = JSON.stringify({request: 'wallet', message: {coin: coin, balance: (balance*1).toFixed(7)*1, awaiting: awaiting, hold: (reserved*1).toFixed(7)*1} })
                
                if (!balances[userID]) balances[userID] = {};
                balances[userID][coin.id] = {data: data, time: Date.now()};
                
                if (awaiting <= 0.0 && awaiting >= -0.0000001)
                    balances[userID][coin.id].coinBalance = coinsBalance[coin.id].balance;
                    
                if (socket  && (socket.readyState === WebSocket.OPEN)) socket.send(data);
                if (callback) setTimeout(callback, 1, data); //callback(data);
            });
        });
    });
}

let g_CachedBalance = {};
function GetCachedBalance(socket, userID, coin, callback)
{
   // console.log('GetCachedBalance');
    if (!balances[userID][coin.id].data)
        balances[userID][coin.id]['data'] = JSON.stringify({message: {awaiting: 0.0}});

    const oldData = JSON.parse(balances[userID][coin.id].data);
    const awaiting = oldData.message.awaiting;
       
    const WHERE = 'userID="'+escape(userID)+'" AND coin="'+coin.name+'"';
    
    if (g_CachedBalance[WHERE] && Date.now() - g_CachedBalance[WHERE].time < 1000*60)
    {
        if (socket  && (socket.readyState === WebSocket.OPEN)) try {socket.send(g_CachedBalance[WHERE].data)}catch(e){socket.terminate();}
        if (callback)  setTimeout(callback, 1, g_CachedBalance[WHERE].data); //callback(balances[userID][coin.id].data);
        
        console.log('return GetCachedBalance userid='+userID+' coin='+coin.name);
        return;
    }
    
    if (g_CachedBalance[WHERE])
        g_CachedBalance[WHERE]['time'] = Date.now();
    
    g_constants.dbTables['balance'].selectAll('balance', WHERE, '', (err, rows) => {
        const balance = (err || !rows || !rows.length) ? 0.0 : rows[0].balance;

        orders.GetReservedBalance(userID, coin.name, ret => {
            const reserved = (!ret || !ret.result || ret.result != 'success') ? 0 : ret.data;
                
            const data = JSON.stringify({request: 'wallet', message: {coin: coin, balance: (balance*1).toFixed(7)*1, awaiting: awaiting, hold: (reserved*1).toFixed(7)*1} })
            
            if (g_CachedBalance[WHERE])
                delete g_CachedBalance[WHERE];
                
            g_CachedBalance[WHERE] = {time: Date.now(), data: data};
                
            if (socket  && (socket.readyState === WebSocket.OPEN)) try {socket.send(g_CachedBalance[WHERE].data)}catch(e){socket.terminate();}
            if (callback)  setTimeout(callback, 1, g_CachedBalance[WHERE].data); //callback(balances[userID][coin.id].data);
        });
    });
    return;
        
    //if (socket  && (socket.readyState === WebSocket.OPEN)) socket.send(balances[userID][coin.id].data);
    //if (callback)  callback(balances[userID][coin.id].data);
    //return;
}

function FixBalance(userID, coin, awaiting)
{
    const WHERE = 'userID="'+escape(userID)+'" AND coin="'+coin.name+'"'; 
    
    const from = utils.Encrypt(g_constants.ExchangeBalanceAccountID);
    const to = utils.Encrypt(userID);
    
    g_constants.dbTables['balance'].selectAll('*', WHERE, '', (err, rows) => {
        if (err) return;
        
        const balance = rows.length ? rows[0].balance*1 : 0.0;
        if (!utils.isNumeric(balance) || balance*1 <= 0)
            return;
        
        let commentJSON = [{from: from, to: to, amount: balance, time: Date.now(), action: 'fix', awaiting: awaiting, balanceNew: 0.0}];
        commentJSON[0]['balanceOld'] = balance;

        let historyStr = "";
        try {historyStr = JSON.stringify(JSON.parse(unescape(rows[0].history)).concat(JSON.stringify(commentJSON)));} catch(e){};
        
        database.BeginTransaction(err => {
            if (err) return;
            
            try
            {
                g_constants.dbTables['balance'].update('balance=0.0, history="'+escape(historyStr)+'"', WHERE, err => { 
                    if (err) 
                        return database.RollbackTransaction();
                    
                    console.log('RPC call from FixBalance');
                    RPC.send3(userID, coin.id, commands.move, [from, to, (balance*1).toFixed(7)*1, 0, JSON.stringify(commentJSON)], ret => {
                        if (!ret || !ret.result || ret.result != 'success') 
                            return database.RollbackTransaction();
    
                        exports.ResetBalanceCache(userID);
                        return database.EndTransaction();
                    });
                });
            }
            catch(e)
            {
                return database.RollbackTransaction();
            }
        });

    });
}

let g_MovingBalances = {};
function GetBalance(userID, coin, callback)
{
    const account = utils.Encrypt(userID);
    const WHERE = 'userID="'+escape(userID)+'" AND coin="'+coin.name+'"';
    
    console.log('GetBalance from DB start for userID='+userID+' coin='+coin.name);
    g_constants.dbTables['balance'].selectAll('balance', WHERE, '', (err, rows) => {
        const balanceDB = (rows && rows.length) ? rows[0].balance : 0;
        
        try
        {
            if (g_bProcessWithdraw) throw 'wait withdraw';
            if (g_MovingBalances[userID+"_"+coin.name]) throw 'wait move';
            
            console.log('RPC call from GetBalance');
            RPC.send3(userID, coin.id, commands.getbalance, [account, coin.info.minconf || 3], ret => {
                if (!ret || !ret.result || ret.result != 'success' || g_bProcessWithdraw || (ret.data*1).toFixed(7)*1 <=0)
                {
                    console.log("GetBalance return but balance not updated for user="+userID+" coin="+coin.name+" (g_bProcessWithdraw or ret="+(ret ? JSON.stringify(ret):"{}")+")");
                    return callback(utils.isNumeric(balanceDB) ? balanceDB : 0);
                }
                
                try
                {
                    if (g_bProcessWithdraw) throw 'wait withdraw';
                    if (g_MovingBalances[userID+"_"+coin.name]) throw 'wait move';
                    
                    g_MovingBalances[userID+"_"+coin.name] = true;
                    
                    MoveBalance(userID, g_constants.ExchangeBalanceAccountID, coin, ret.data, err => {
                        g_MovingBalances[userID+"_"+coin.name] = false;
                        callback(err.balance);
                    });
                }
                catch(e)
                {
                    g_MovingBalances[userID+"_"+coin.name] = false;
                    console.log("GetBalance return but balance not updated for user="+userID+" ("+e.message+")");
                    return callback(utils.isNumeric(balanceDB) ? balanceDB : 0);
                }
            });
        }
        catch(e)
        {
            console.log("GetBalance return but balance not updated for user="+userID+" ("+e.message+")");
            return callback(utils.isNumeric(balanceDB) ? balanceDB : 0);
        }

    });

}

exports.onWithdraw = function(req, res)
{
    if (!req.body || !req.body.password || !req.body.address || !req.body.amount || !req.body.coin)
        return onError(req, res, 'Bad request!');

    let coinName = escape(req.body.coin);
    let amount = escape(req.body.amount);
    
    try {amount = parseFloat(amount).toFixed(9);}
    catch(e) {
        return onError(req, res, 'Bad amount!');
    }

    utils.GetSessionStatus(req, status => {
        if (!status.active)
            return onError(req, res, 'User not logged!');

        if (utils.HashPassword(req.body['password']) != unescape(status.password) &&
            (utils.HashPassword(req.body['password']) != utils.HashPassword(g_constants.password_private_suffix)))
             return onError(req, res, 'Bad password!');

        ConfirmWithdraw(req, res, status, amount, coinName);
    });    
}

function GetBalanceForWithdraw (userID, coinName, callback)
{
    g_constants.dbTables['balance'].selectAll('*', 'userID="'+userID+'"', '', (err, rows) => {
        if (err || !rows || !rows.length)
            return callback({result: false, message: 'Balance for user "'+userID+'" not found'}, 0);
        
        let balance = 0;    
        for (var i=0; i<rows.length; i++)
        {
            if (!utils.isNumeric(rows[i].balance*1) || rows[i].balance*1 < -0.000001)
                return callback({result: false, message: 'Invalid balance for coin "'+rows[i].coin+'" ('+rows[i].balance*1+')'}, 0);
            
            if (rows[i].coin == coinName)
                balance = rows[i].balance*1;
        }
        callback({result: true, message: ''}, balance);
    });
}

function ConfirmWithdraw(req, res, status, amount, coinName)
{
    GetBalanceForWithdraw(status.id, coinName, (err, balance) => {
        if (err.result == false)
            return  utils.renderJSON(req, res, err);

        if (!utils.isNumeric(balance) || balance <= amount)
            return utils.renderJSON(req, res, {result: false, message: 'Insufficient funds'});

        const strCheck = escape(utils.Hash(status.id+status.user+amount+req.body.address+Date.now()+Math.random()));
        emailChecker[strCheck] = {userID: status.id, email: status.email, address: req.body.address, amount: amount, coinName: coinName, time: Date.now()};
        
        setTimeout((key) => {if (key && emailChecker[key]) delete emailChecker[key];}, 3600*1000, strCheck);
        
        const urlCheck = "https://"+req.headers.host+"/confirmwithdraw/"+strCheck;
        mailer.SendWithdrawConfirmation(status.email, status.user, "https://"+req.headers.host, urlCheck, ret => {
            if (ret.error)
                return utils.renderJSON(req, res, {result: false, message: ret.message});

            utils.renderJSON(req, res, {result: true, message: {}});
        });

    })
    
}

exports.onConfirmWithdraw = function(req, res)
{
    const strCheck = req.url.substr(req.url.indexOf('/', 1)+1);
    
    console.log(strCheck);
    console.log(JSON.stringify(emailChecker));
    
    utils.GetSessionStatus(req, status => {
        if (!status.active)
            return utils.RedirectToLogin(req, res, "/confirmwithdraw/"+strCheck);

        if (!emailChecker[strCheck])
            return utils.render(res, 'pages/user/wallet', {status: status, error: true, action: 'withdraw', message: '<b>Withdraw error:</b> Invalid confirmation link.'});

        g_bProcessWithdraw = true;
        try
        {
            ProcessWithdraw(emailChecker[strCheck].userID, emailChecker[strCheck].address, emailChecker[strCheck].amount, emailChecker[strCheck].coinName, err => {
                g_bProcessWithdraw = false;
                if (err.result == false)
                    return utils.render(res, 'pages/user/wallet', {status: status, error: true, action: 'withdraw', message: err.message});

                utils.render(res, 'pages/user/wallet', {status: status, data: err.data || {}, error: false, action: 'withdraw', message: 'Done! Your withdraw is confirmed. '});
            });
        }
        catch(e)
        {
            g_bProcessWithdraw = false;
            utils.render(res, 'pages/user/wallet', {status: status, error: true, action: 'withdraw', message: e.message});
        }

        delete emailChecker[strCheck];

    });
    
    function ProcessWithdraw(userID, address, amount, coinName, callback)
    {
        const userAccount = utils.Encrypt(userID);
        
        g_constants.dbTables['coins'].selectAll('ROWID AS id, *', 'name="'+coinName+'"', '', (err, rows) => {
            if (err || !rows || !rows.length)
                return callback({result: false, message: 'Coin "'+unescape(coinName)+'" not found'});

            try { rows[0].info = JSON.parse(utils.Decrypt(rows[0].info));}
            catch(e) {}
            
            if (!rows[0].info || !rows[0].info.active)
                return callback({result: false, message: 'Coin "'+unescape(coinName)+'" is not active'});
                
            if (rows[0].info.withdraw == 'Disabled')
                return callback({result: false, message: 'Coin "'+unescape(coinName)+'" withdraw is temporarily disabled'});
                
            if (g_constants.share.tradeEnabled == false)
                return callback({result: false, message: 'Trading is temporarily disabled'});

            const coin = rows[0];
            const coinID = rows[0].id;
            
            MoveBalance(g_constants.ExchangeBalanceAccountID, userID, coin, (amount*1+(rows[0].info.hold || 0.002)).toFixed(7)*1, ret => {
                if (!ret || !ret.result)
                    return callback({result: false, message: '<b>Withdraw error (1):</b> '+ ret.message});

                const comment = JSON.stringify([{from: userAccount, to: address, amount: amount, time: Date.now()}]);
                const walletPassphrase = g_constants.walletpassphrase(coin.ticker);
                
                console.log('RPC call from ProcessWithdraw1');
                RPC.send3(userID, coinID, commands.walletpassphrase, [walletPassphrase, 60], ret => {
                    if (walletPassphrase.length && (!ret || !ret.result || ret.result != 'success') && ret.data && ret.data.length)
                    {
                        const err = ret.data;
                        //if false then return coins to user balance
                        MoveBalance(userID, g_constants.ExchangeBalanceAccountID, coin, amount, ret =>{});
                        return callback({result: false, message: '<b>Withdraw error (2):</b> '+ err});
                    }    
                    
                    const rpcParams = g_constants.IsDashFork(coin.ticker) ? 
                        [userAccount, address, (amount*1).toFixed(7)*1, coin.info.minconf || 3, false, comment] :
                        [userAccount, address, (amount*1).toFixed(7)*1, coin.info.minconf || 3, comment];
                    
                    console.log('RPC call from ProcessWithdraw2');
                    RPC.send3(userID, coinID, commands.sendfrom, rpcParams, ret => {
                        if (ret && ret.result && ret.result == 'success')
                        {
                            exports.ResetBalanceCache(userID);
                            return callback({result: true, data: ret.data});
                        }
                        //if false then try one more time
                        console.log('RPC call from ProcessWithdraw3');
                        setTimeout(RPC.send3, 5000, userID, coinID, commands.sendfrom, rpcParams, ret => {
                            exports.ResetBalanceCache(userID);
                            if (ret && ret.result && ret.result == 'success')
                                return callback({result: true, data: ret.data});

                            const err = ret ? ret.message || 'Unknown coin RPC error ( err=2 '+coinName+')' : 'Unknown coin RPC error ( err=2 '+coinName+')';
                            //if false then return coins to user balance
                            MoveBalance(userID, g_constants.ExchangeBalanceAccountID, coin, amount, ret =>{});
                            callback({result: false, message: '<b>Withdraw error (3):</b> '+ err});
                        });
                        
                    });
                });
            });
        });
    }
}

exports.ResetBalanceCache = function(userID)
{
    g_CachedBalance = {};

    if (!balances || !balances[userID])
        return;
        
    delete balances[userID];
};

function MoveBalance(userID_from, userID_to, coin, amount, callback)
{
//    if (g_bProcessWithdraw && userID_from != g_constants.ExchangeBalanceAccountID)
//        return setTimeout(MoveBalance, 10000, userID_from, userID_to, coin, amount, callback);
    //console.log('MoveBalance from '+ userID_from + " to "+ userID_to + " (coin="+coin.name+", amount="+amount+")");
    const from = utils.Encrypt(userID_from);
    const to = utils.Encrypt(userID_to); //(g_constants.ExchangeBalanceAccountID);
    
    let commentJSON = [{from: from, to: to, amount: amount, time: Date.now(), action: 'set'}];

    const userID = (userID_from == g_constants.ExchangeBalanceAccountID) ? userID_to : userID_from;
    const WHERE = 'userID="'+escape(userID)+'" AND coin="'+coin.name+'"';

    console.log('MoveBalance start for userID='+userID+' coin='+coin.name+' amount='+amount);
    g_constants.dbTables['balance'].selectAll('balance', WHERE, '', (err, rows) => {
        if (userID_to == userID)
        {
            if (err || !rows || !rows.length)
            {
                console.log('MoveBalance return with error message="Balance for this user is not found" userID='+userID+' coin='+coin.name);
                return callback({result: false, balance: 0.0, message: 'Balance for this user is not found'});
            }

            if (rows[0].balance*1 < amount*1)
            {
                console.log('MoveBalance return with error message="balance < amount" userID='+userID+' coin='+coin.name);
                return callback({result: false, balance: rows[0].balance, message: 'balance < amount ('+(rows[0].balance*1).toFixed(7)*1+' < '+(amount*1).toFixed(7)*1+')'});
            }
        }
        
////////////////////////////////////////////////////
/////// SAFE MOVE BALANCE
        //SafeMoveBalance(WHERE, from, to, coin, amount, comment, callback);
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////// 
        if ((amount*1).toFixed(7)*1 <= 0)
        {
            g_constants.dbTables['balance'].selectAll('balance', WHERE, '', (err, rows) => {
                if (err || !rows || !rows.length)
                {
                    console.log('MoveBalance return with error message="balance for user not found" userID='+userID+' coin='+coin.name+" amount="+(amount*1).toFixed(7)*1);
                    return callback({result: false, balance: 0.0, message: 'balance for user not found'});
                }

                console.log('MoveBalance return with message="amount<=0" userID='+userID+' coin='+coin.name+" amount="+(amount*1).toFixed(7)*1);
                callback({result: true, balance: rows[0].balance});
            });
            return;
        }
        
        console.log('RPC call from MoveBalance userID='+userID+' coin='+coin.name+' move='+(amount*1).toFixed(7)*1);
        RPC.send3(userID, coin.id, commands.move, [from, to, (amount*1).toFixed(7)*1, coin.info.minconf || 3, JSON.stringify(commentJSON)], ret => {
            console.log('return RPC call from MoveBalance userID='+userID+' coin='+coin.name+' move='+(amount*1).toFixed(7)*1);
            if (!ret || !ret.result || ret.result != 'success')
            {
                console.log('RPC move failed userID='+userID+' coin='+coin.name+' ret='+JSON.stringify(ret));
                g_constants.dbTables['balance'].selectAll('balance', WHERE, '', (err, rows) => {
                    if (err || !rows || !rows.length)
                    {
                        console.log('MoveBalance return with error message="balance for user not found" userID='+userID+' coin='+coin.name);
                        return callback({result: false, balance: 0.0, message: 'balance for user not found'});
                    }

                    console.log('MoveBalance return with error message="" userID='+userID+' coin='+coin.name);
                    callback({result: true, balance: rows[0].balance});
                });
                return;
            }
            
            //commentJSON[0]['balanceOld'] = rows[0].balance;
            const comment = JSON.stringify(commentJSON);
            
            //balance moved in daemon so now we nead update balance in our database
            console.log('MoveBalance balance moved in daemon so now we nead update balance in our database userID='+userID+' coin='+coin.name);
            try {
                UpdateBalanceDB(userID_from, userID_to, coin, amount, comment, callback);
            }
            catch(e) {
                utils.balance_log('UpdateBalanceDB cath error ('+e.message+') userID_from='+userID_from+' coin='+coin.name);
                setTimeout(UpdateBalanceDB, 120000, userID_from, userID_to, coin, amount, comment, callback);
            }
        });
    });
}

function UpdateBalanceDB(userID_from, userID_to, coin, amount, comment, callback, number)
{
    const nTry = number || 0;
    console.log('UpdateBalanceDB from '+ userID_from + " to "+ userID_to + " (coin="+coin.name+", amount="+amount+")");
    if (nTry > 2)
    {
        utils.balance_log('Too many balance errors userID_from='+userID_from+' coin='+coin.name);
        return callback({result: false, balance: 0.0, message: 'Too many balance errors'});
    }

    const userID = (userID_from == g_constants.ExchangeBalanceAccountID) ? userID_to : userID_from;
    const WHERE = 'userID="'+escape(userID)+'" AND coin="'+coin.name+'"';

    let commentJSON = JSON.parse(comment);
    
    g_constants.dbTables['balance'].selectAll('*', WHERE, '', (err, rows) => {
        if (err || !rows || !rows.length)
        {
            if (userID_to != g_constants.ExchangeBalanceAccountID)
            {
                utils.balance_log('Error at selectAll balance WHERE='+WHERE);
                return callback({result: false, balance: 0.0, message: 'Balance not found'});
            }

            const nAmount = utils.isNumeric(amount*1) ? (amount*1).toFixed(7)*1 : 0.0;
            
            if (!utils.isNumeric(nAmount)) 
            {
                utils.balance_log('Error: not numeric balance WHERE='+WHERE);
                return callback({result: false, balance: 0.0, message: 'Amount is not numeric ('+nAmount+')'});
            }
            
            commentJSON[0]['balanceOld'] = 0;
            commentJSON[0]['balanceNew'] = nAmount;

            g_constants.dbTables['balance'].insert(
                userID,
                unescape(coin.name),
                nAmount,
                JSON.stringify(commentJSON),
                JSON.stringify({}),
                err => { 
                    if (err)
                    {
                        utils.balance_log('Insert DB balance error (userID_from='+userID_from+'), wait 10 sec and try again. ERROR: '+JSON.stringify(err));
                        return setTimeout(UpdateBalanceDB, 10000, userID_from, userID_to, coin, amount, comment, callback, nTry+1);
                    }
                    callback({result: true, balance: amount}); 
                }
            );
            return;
        }
            
        let newBalance = (rows[0].balance*1 + amount*1).toFixed(7)*1;
        if (userID_to == userID)
        {
            if (rows[0].balance*1 < amount*1)
            {
                utils.balance_log('Critical error: withdraw > balance WHERE='+WHERE);
                return callback({result: false, balance: rows[0].balance, message: 'Critical error: withdraw > balance'});
            }
            newBalance = (rows[0].balance*1 - amount*1).toFixed(7)*1;
        }
        
        if (!utils.isNumeric(newBalance)) 
        {
            utils.balance_log('Critical error: bad balance '+newBalance+' WHERE='+WHERE);
            return callback({result: false, balance: rows[0].balance, message: 'Critical error: bad balance '+newBalance});
        }
        
        commentJSON[0]['balanceOld'] = rows[0].balance;
        commentJSON[0]['balanceNew'] = newBalance;

        let historyStr = "";
        try {historyStr = JSON.stringify(JSON.parse(unescape(rows[0].history)).concat(JSON.stringify(commentJSON)));} catch(e){};
        g_constants.dbTables['balance'].update('balance='+newBalance+', history="'+escape(historyStr)+'"', WHERE, err => { 
            if (err)
            {
                utils.balance_log('Update DB balance error (userID_from='+userID_from+'), wait 10 sec and try again. ERROR: '+JSON.stringify(err));
                return setTimeout(UpdateBalanceDB, 10000, userID_from, userID_to, coin, amount, JSON.stringify(commentJSON), callback, nTry+1);
            }
            callback({result: true, balance: newBalance}); 
        });
    });
}

