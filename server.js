/**
 * Beteseb Bingo — Server v5
 * Changes:
 *  - 80% winner / 20% house cut
 *  - Disqualification only notifies the cheater (silent to others)
 *  - Admin page (phone 251934255415 → admin)
 *  - Deposit/withdrawal requests with approve/reject
 *  - Full DB integration
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use(express.json());

const ADMIN_PHONE = '251934255415';
function isAdminPhone(phone) {
  if (!phone) return false;
  const normalized = String(phone).replace(/^\+/, '');
  return normalized === ADMIN_PHONE;
}
const HOUSE_CUT   = 0.20; // 20% house, 80% winner

// ─── PAYMENT INFO (admin-editable) ─────────────────────────────
let PAYMENT_INFO = { telebirrNumber: '0967423275', telebirrName: 'Lidetua' };

// ─── DATABASE ─────────────────────────────────────────────────
let db = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    db = {
      q: (sql, p) => pool.query(sql, p).then(r => r.rows),

      async getUser(tid) {
        const r = await this.q('SELECT * FROM users WHERE telegram_id=$1', [String(tid)]);
        return r[0] || null;
      },
      async getUserByPhone(phone) {
        const r = await this.q('SELECT * FROM users WHERE phone=$1', [phone]);
        return r[0] || null;
      },
      async createUser(tid, name, phone) {
        const r = await this.q(
          `INSERT INTO users(telegram_id,name,phone,balance) VALUES($1,$2,$3,0)
           ON CONFLICT(telegram_id) DO UPDATE SET last_seen=NOW() RETURNING *`,
          [String(tid), name, phone]
        );
        return r[0];
      },
      async setBalance(tid, bal) {
        await this.q('UPDATE users SET balance=$1 WHERE telegram_id=$2', [bal, String(tid)]);
      },
      async logTx(tid, type, amount, balAfter, ref) {
        await this.q(
          `INSERT INTO transactions(user_id,type,amount,balance_after,reference)
           SELECT id,$2,$3,$4,$5 FROM users WHERE telegram_id=$1`,
          [String(tid), type, amount, balAfter, ref || '']
        );
      },
      async saveGame(roomId, stakeId, amount, pot) {
        const r = await this.q(
          `INSERT INTO games(room_id,stake_id,stake_amount,pot,status,started_at)
           VALUES($1,$2,$3,$4,'playing',NOW()) RETURNING id`,
          [roomId, stakeId, amount, pot]
        );
        return r[0].id;
      },
      async endGame(gameId, tids, winAmount, isSplit, called) {
        await this.q(
          `UPDATE games SET status='finished',winner_ids=$1,win_amount=$2,is_split=$3,called_numbers=$4,ended_at=NOW() WHERE id=$5`,
          [tids, winAmount, isSplit, called, gameId]
        );
        if (tids.length) {
          await this.q('UPDATE users SET total_wins=total_wins+1,total_winnings=total_winnings+$1 WHERE telegram_id=ANY($2)', [winAmount, tids]);
        }
        await this.q(`UPDATE users SET total_games=total_games+1 WHERE telegram_id=ANY(
          SELECT DISTINCT u.telegram_id FROM game_participants gp JOIN users u ON u.id=gp.user_id WHERE gp.game_id=$1)`, [gameId]);
      },

      // ── Deposits ──
      async createDeposit(tid, amount, txRef) {
        const r = await this.q(
          `INSERT INTO deposit_requests(user_id,amount,tx_ref,status)
           SELECT id,$2,$3,'pending' FROM users WHERE telegram_id=$1 RETURNING id`,
          [String(tid), amount, txRef]
        );
        return r[0]?.id;
      },
      async getDeposits(status) {
        const where = status ? 'WHERE dr.status=$1' : '';
        const params = status ? [status] : [];
        return this.q(
          `SELECT dr.*,u.name,u.phone,u.telegram_id FROM deposit_requests dr
           JOIN users u ON u.id=dr.user_id ${where} ORDER BY dr.created_at DESC LIMIT 50`, params
        );
      },
      async approveDeposit(id) {
        const r = await this.q(
          `UPDATE deposit_requests SET status='approved',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const dep = r[0];
        // Credit balance
        const u = await this.q('SELECT telegram_id,balance FROM users WHERE id=$1', [dep.user_id]);
        if (u[0]) {
          const newBal = parseFloat(u[0].balance) + parseFloat(dep.amount);
          await this.setBalance(u[0].telegram_id, newBal);
          await this.logTx(u[0].telegram_id, 'deposit', dep.amount, newBal, dep.tx_ref);
          return { telegramId: u[0].telegram_id, newBalance: newBal, amount: dep.amount };
        }
        return null;
      },
      async rejectDeposit(id) {
        await this.q(`UPDATE deposit_requests SET status='rejected',handled_at=NOW() WHERE id=$1`, [id]);
      },

      // ── Withdrawals ──
      async createWithdrawal(tid, amount) {
        const u = await this.getUser(tid);
        if (!u || parseFloat(u.balance) < amount) return { error: 'Insufficient balance' };
        const newBal = parseFloat(u.balance) - amount;
        await this.setBalance(tid, newBal);
        await this.logTx(tid, 'withdrawal_pending', -amount, newBal, 'pending');
        const r = await this.q(
          `INSERT INTO withdrawal_requests(user_id,amount,status)
           SELECT id,$2,'pending' FROM users WHERE telegram_id=$1 RETURNING id`,
          [String(tid), amount]
        );
        return { id: r[0]?.id, newBalance: newBal };
      },
      async getWithdrawals(status) {
        const where = status ? 'WHERE wr.status=$1' : '';
        const params = status ? [status] : [];
        return this.q(
          `SELECT wr.*,u.name,u.phone,u.telegram_id FROM withdrawal_requests wr
           JOIN users u ON u.id=wr.user_id ${where} ORDER BY wr.created_at DESC LIMIT 50`, params
        );
      },
      async approveWithdrawal(id) {
        const r = await this.q(
          `UPDATE withdrawal_requests SET status='approved',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
        const u = await this.q('SELECT telegram_id FROM users WHERE id=$1', [wr.user_id]);
        if (u[0]) await this.logTx(u[0].telegram_id, 'withdrawal', -wr.amount, 0, 'approved');
        return { telegramId: u[0]?.telegram_id, amount: wr.amount };
      },
      async rejectWithdrawal(id) {
        // Refund the balance
        const r = await this.q(
          `UPDATE withdrawal_requests SET status='rejected',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
        const u = await this.q('SELECT telegram_id,balance FROM users WHERE id=$1', [wr.user_id]);
        if (u[0]) {
          const newBal = parseFloat(u[0].balance) + parseFloat(wr.amount);
          await this.setBalance(u[0].telegram_id, newBal);
          await this.logTx(u[0].telegram_id, 'withdrawal_refund', wr.amount, newBal, 'rejected');
          return { telegramId: u[0].telegram_id, newBalance: newBal };
        }
        return null;
      },

      // ── Admin user search ──
      async searchByPhone(phone) {
        return this.q(
          `SELECT u.*,
            (SELECT json_agg(t ORDER BY t.created_at DESC) FROM transactions t WHERE t.user_id=u.id) as transactions,
            (SELECT COUNT(*) FROM game_participants gp WHERE gp.user_id=u.id) as games_played
           FROM users u WHERE u.phone LIKE $1 LIMIT 10`,
          ['%' + phone + '%']
        );
      },

      async getLeaderboard() {
        return this.q('SELECT name,total_wins,total_games,total_winnings FROM users ORDER BY total_winnings DESC LIMIT 10');
      },

      // ── Settings (key/value store) ──
      async ensureSettingsTable() {
        await this.q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
      },
      async getSetting(key) {
        const r = await this.q('SELECT value FROM settings WHERE key=$1', [key]);
        return r[0]?.value;
      },
      async setSetting(key, value) {
        await this.q(
          `INSERT INTO settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=$2`,
          [key, value]
        );
      }
    };

    pool.query('SELECT 1').then(async () => {
      console.log('✅ PostgreSQL connected');
      try {
        await db.ensureSettingsTable();
        const num  = await db.getSetting('telebirr_number');
        const name = await db.getSetting('telebirr_name');
        if (num)  PAYMENT_INFO.telebirrNumber = num;
        if (name) PAYMENT_INFO.telebirrName   = name;
      } catch (e) { console.error('⚠️ Settings load:', e.message); }
    }).catch(e => { console.error('❌ DB:', e.message); db = null; });
  } catch(e) { console.log('⚠️ pg error:', e.message); }
} else {
  console.log('ℹ️ No DATABASE_URL — memory mode');
}

// ─── CONFIG ──────────────────────────────────────────────────
const LOBBY_WAIT_MS    = 30000;
const CALL_INTERVAL_MS = 5000;
const CLAIM_WINDOW_MS  = 4800;
const TOTAL_CARDS      = 400;

const STAKES = [
  { id:'st10', amount:10, maxPlayers:50 },{ id:'st20', amount:20, maxPlayers:50 },
  { id:'st30', amount:30, maxPlayers:50 },{ id:'st50', amount:50, maxPlayers:50 },
  { id:'st80', amount:80, maxPlayers:50 },{ id:'st100',amount:100,maxPlayers:50 },
];

// ─── FIXED CARDS ─────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return () => { s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s); t=t+Math.imul(t^t>>>7,61|t)^t; return((t^t>>>14)>>>0)/4294967296; };
}
function generateFixedCard(idx) {
  const rng=seededRandom(idx*7919), ranges=[[1,15],[16,30],[31,45],[46,60],[61,75]], nums=Array(25).fill(0);
  for(let col=0;col<5;col++){
    const[lo,hi]=ranges[col], pool=Array.from({length:hi-lo+1},(_,i)=>lo+i), picked=[];
    for(let i=0;i<5;i++){const j=Math.floor(rng()*pool.length);picked.push(pool.splice(j,1)[0]);}
    picked.sort((a,b)=>a-b);
    for(let row=0;row<5;row++){const ci=row*5+col; nums[ci]=ci===12?0:picked[row];}
  }
  return nums;
}
const CARD_POOL=[];
for(let i=1;i<=TOTAL_CARDS;i++) CARD_POOL.push({id:i,numbers:generateFixedCard(i)});
const getCard=id=>CARD_POOL.find(c=>c.id===id);

// ─── WIN CHECK ───────────────────────────────────────────────
function checkWin(nums, called, marked) {
  const cs=new Set(called), ms=new Set(marked||[]); ms.add(12);
  const hit=i=>i===12||(cs.has(nums[i])&&ms.has(i));
  return [[0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
          [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
          [0,6,12,18,24],[4,8,12,16,20],[0,4,20,24]].some(p=>p.every(i=>hit(i)));
}

// ─── STATE ───────────────────────────────────────────────────
const clients={}, rooms={}, userCache={};

// ─── USER HELPERS ────────────────────────────────────────────
async function loadUser(tid) {
  if(db){try{const u=await db.getUser(tid);if(u){userCache[tid] = { name: u.name, phone: u.phone, balance: parseFloat(u.balance), isAdmin: u.is_admin === true };}}catch(e){}}
  return userCache[tid]||null;
}
async function saveBalance(tid, bal) {
  if(userCache[tid]) userCache[tid].balance=bal;
  if(db&&tid){try{await db.setBalance(tid,bal);}catch(e){}}
}

// ─── ROOM HELPERS ────────────────────────────────────────────
function getOrCreateRoom(sid){
  let r=Object.values(rooms).find(r=>r.stakeId===sid&&(r.status==='waiting'||r.status==='countdown'));
  if(r) return r;
  const s=STAKES.find(s=>s.id===sid), roomId=uuidv4();
  r={roomId,stakeId:sid,stake:s.amount,status:'waiting',players:[],calledNumbers:[],
     availableNumbers:Array.from({length:75},(_,i)=>i+1),callTimer:null,countdownTimer:null,
     countdownLeft:Math.ceil(LOBBY_WAIT_MS/1000),claimWindowOpen:false,claimedThisRound:[],
     takenCardIds:new Set(),pot:0,dbGameId:null};
  rooms[roomId]=r; return r;
}
const send=(ws,msg)=>{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));};
const broadcast=(room,msg)=>{const s=JSON.stringify(msg);room.players.forEach(p=>{if(p.ws&&p.ws.readyState===WebSocket.OPEN)p.ws.send(s);});};
function broadcastLobby(){
  const payload=STAKES.map(s=>{const r=Object.values(rooms).find(r=>r.stakeId===s.id);
    return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,playerCount:r?r.players.length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
  Object.values(clients).forEach(c=>{if(!c.roomId)send(c.ws,{type:'lobbyUpdate',stakes:payload});});
}
function broadcastCardPool(room){
  const base=CARD_POOL.map(c=>({id:c.id,taken:room.takenCardIds.has(c.id)}));
  room.players.forEach(p=>{
    send(p.ws,{type:'cardPoolUpdate',pool:base.map(c=>({
      ...c,
      takenByMe: p.cardIds.includes(c.id),
      mySlot: p.cardIds.indexOf(c.id)+1  // 0=not mine, 1=first card, 2=second card
    }))});
  });
}

// ─── GAME LIFECYCLE ──────────────────────────────────────────
function startCountdown(room){
  room.status='countdown'; room.countdownLeft=Math.ceil(LOBBY_WAIT_MS/1000);
  room.countdownTimer=setInterval(()=>{
    room.countdownLeft--;
    if(room.players.length<2){clearInterval(room.countdownTimer);room.status='waiting';broadcast(room,{type:'waitingForPlayers'});broadcastLobby();return;}
    broadcast(room,{type:'countdown',seconds:room.countdownLeft});
    if(room.countdownLeft<=0){clearInterval(room.countdownTimer);startGame(room);}
  },1000);
}

async function startGame(room){
  for(const p of room.players){
    if(!p.cardIds) p.cardIds=[];
    const activeCards=p.cardIds.filter(Boolean);

    // Spectator — no cards selected
    if(activeCards.length===0) continue;

    // Charge for any unpaid cards
    if(!p.cardsPaid) p.cardsPaid=0;
    for(let i=p.cardsPaid;i<activeCards.length;i++){
      const cl=clients[p.playerId];
      if(cl&&cl.balance>=room.stake){
        cl.balance-=room.stake; p.cardsPaid++;
        await saveBalance(cl.telegramId,cl.balance);
        if(db&&cl.telegramId){try{await db.logTx(cl.telegramId,'stake',-room.stake,cl.balance,room.roomId);}catch(e){}}
        send(p.ws,{type:'balanceUpdate',balance:cl.balance});
      } else {
        // Can't afford — remove this card
        room.takenCardIds.delete(activeCards[i]);
        p.cardIds[p.cardIds.indexOf(activeCards[i])]=null;
      }
    }

    p.hasPaid=p.cardIds.filter(Boolean).length>0;
  }

  room.status='playing';
  // Pot = total cards paid across all players (each card = 1 stake)
  room.pot=room.players.reduce((sum,p)=>{
    if(!p.cardIds) return sum;
    return sum+(p.cardIds.filter(Boolean).length*room.stake);
  },0);
  room.calledNumbers=[]; room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
  room.claimedThisRound=[]; room.claimWindowOpen=false;
  if(db){try{room.dbGameId=await db.saveGame(room.roomId,room.stakeId,room.stake,room.pot);}catch(e){}}

  room.players.forEach(p=>{
    const activeCards=(p.cardIds||[]).filter(Boolean);
    if(activeCards.length>0){
      // Send all cards to the player
      const cardsData=activeCards.map(id=>{const c=getCard(id);return{cardId:id,cardNumbers:c?c.numbers:[]};});
      send(p.ws,{type:'yourCards',cards:cardsData,pot:room.pot,playerCount:room.players.length});
    } else {
      send(p.ws,{type:'spectating',pot:room.pot,playerCount:room.players.filter(p=>p.hasPaid).length,calledNumbers:room.calledNumbers});
    }
  });

  broadcast(room,{type:'gameStart',pot:room.pot,players:room.players.map(p=>({playerId:p.playerId,playerName:p.playerName}))});
  broadcastLobby(); scheduleNextCall(room);
}

function scheduleNextCall(room){room.callTimer=setTimeout(()=>callNumber(room),CALL_INTERVAL_MS);}

function callNumber(room){
  if(room.status!=='playing') return;

  // FIX 1: Evaluate ALL pending claims BEFORE calling next number.
  // This lets multiple simultaneous winners be detected in the same window.
  if(room.claimedThisRound.length>0){evaluateClaims(room);return;}
  room.claimWindowOpen=false; room.claimedThisRound=[];
  if(room.availableNumbers.length===0){endGame(room,[],null,true);return;}
  const idx=Math.floor(Math.random()*room.availableNumbers.length);
  const drawn=room.availableNumbers.splice(idx,1)[0];
  room.calledNumbers.push(drawn);
  broadcast(room,{type:'numberCalled',number:drawn,calledNumbers:room.calledNumbers,callCount:room.calledNumbers.length,claimWindowMs:CLAIM_WINDOW_MS});
  room.claimWindowOpen=true; scheduleNextCall(room);
}

function evaluateClaims(room){
  const winners=[], cheaters=[];
  room.claimedThisRound.forEach(claim=>{
    const p=room.players.find(p=>p.playerId===claim.playerId);
    if(!p||p.disqualified) return;
    const activeCards=(p.cardIds||[]).filter(Boolean);
    if(activeCards.length===0) return; // spectator

    // Check the specific card they claimed on, or all cards if no specific one
    const claimCardId=claim.cardId;
    const cardsToCheck=claimCardId
      ? [claimCardId].filter(id=>activeCards.includes(id))
      : activeCards;

    const won=cardsToCheck.some(id=>{
      const card=getCard(id);
      return card&&checkWin(card.numbers,room.calledNumbers,claim.markedIndices||[]);
    });

    if(won) winners.push(p);
    else cheaters.push(p);
  });

  // Disqualify cheaters silently
  cheaters.forEach(p=>{
    p.disqualified=true;
    send(p.ws,{type:'disqualified',message:'🚫 False BINGO claim — you are disqualified!'});
  });

  room.claimedThisRound=[]; room.claimWindowOpen=false;
  if(winners.length>0) endGame(room,winners,null,false);
  else scheduleNextCall(room);
}

async function endGame(room, winners, customMsg, noWinner){
  if(room.callTimer) clearTimeout(room.callTimer);
  if(room.countdownTimer) clearInterval(room.countdownTimer);
  room.status='finished'; room.claimWindowOpen=false;

  let winAmount=0, winnerNames=[], winnerTids=[];

  if(winners&&winners.length>0){
    const totalPot=room.pot;
    const houseCut=Math.floor(totalPot*HOUSE_CUT);
    const prizePool=totalPot-houseCut;
    // Split prize pool equally among winners
    winAmount=Math.floor(prizePool/winners.length);
    winnerNames=winners.map(w=>w.playerName);
    for(const w of winners){
      const cl=clients[w.playerId];
      if(cl){
        cl.balance+=winAmount;
        winnerTids.push(cl.telegramId||'');
        await saveBalance(cl.telegramId,cl.balance);
        if(db&&cl.telegramId){try{await db.logTx(cl.telegramId,'win',winAmount,cl.balance,room.roomId);}catch(e){}}
        send(w.ws,{type:'balanceUpdate',balance:cl.balance});
      }
    }
  }

  if(db&&room.dbGameId){try{await db.endGame(room.dbGameId,winnerTids,winAmount,winners.length>1,room.calledNumbers);}catch(e){}}

  const isSplit=winners&&winners.length>1;
  const msg=customMsg||(noWinner?'No winner this round':
    isSplit?`🤝 Split! ${winnerNames.join(' & ')} each win ${winAmount} ETB!`
           :`🏆 ${winnerNames[0]} wins ${winAmount} ETB!`);

  broadcast(room,{type:'gameOver',winners:winnerNames,winAmount,isSplit,message:msg,noWinner:!!noWinner});

  setTimeout(()=>{
    if(!rooms[room.roomId]) return;
    room.status='waiting'; room.calledNumbers=[]; room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
    room.pot=0; room.takenCardIds=new Set(); room.claimedThisRound=[]; room.claimWindowOpen=false; room.dbGameId=null;
    room.players.forEach(p=>{p.cardIds=[];p.cardsPaid=0;p.hasPaid=false;p.disqualified=false;});
    room.players.forEach(p=>{const cl=clients[p.playerId];send(p.ws,{type:'backToCardSelection',roomId:room.roomId,stakeId:room.stakeId,balance:cl?cl.balance:0});});
    broadcastCardPool(room); broadcastLobby();
    if(room.players.length>=2) startCountdown(room);
  },6000);
}

function leaveRoom(client){
  if(!client.roomId) return;
  const room=rooms[client.roomId];
  if(!room){client.roomId=null;return;}
  const p=room.players.find(p=>p.playerId===client.playerId);
  if(p){
    // Release all selected cards
    (p.cardIds||[]).filter(Boolean).forEach(id=>room.takenCardIds.delete(id));
    // Refund all paid cards if game not yet started
    if((room.status==='waiting'||room.status==='countdown')&&p.cardsPaid){
      const refund=p.cardsPaid*room.stake;
      client.balance+=refund; saveBalance(client.telegramId,client.balance);
      send(client.ws,{type:'balanceUpdate',balance:client.balance});
    }
  }
  room.players=room.players.filter(p=>p.playerId!==client.playerId);
  client.roomId=null;
  if(room.players.length===0){if(room.callTimer)clearTimeout(room.callTimer);if(room.countdownTimer)clearInterval(room.countdownTimer);delete rooms[room.roomId];}
  else{broadcastCardPool(room);broadcast(room,{type:'playerLeft',playerCount:room.players.length});}
  broadcastLobby();
}

// ─── WEBSOCKET ────────────────────────────────────────────────
wss.on('connection',(ws)=>{
  const playerId=uuidv4();
  const client={playerId,playerName:'',telegramId:null,balance:0,roomId:null,isAdmin:false,ws};
  clients[playerId]=client; ws._pid=playerId;

  const lobbyStakes=STAKES.map(s=>{const r=Object.values(rooms).find(r=>r.stakeId===s.id);
    return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,playerCount:r?r.players.length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
  send(ws,{type:'connected',playerId,balance:0,stakes:lobbyStakes});

  ws.on('message',async raw=>{
    try{
      const msg=JSON.parse(raw);
      const client=clients[ws._pid];
      if(!client) return;

      switch(msg.type){
        case 'telegramAuth':{
          const tid=String(msg.telegramId);
          const user=await loadUser(tid);
          if(user){
            client.telegramId=tid; client.playerName=user.name; client.balance=user.balance; client.isAdmin=user.isAdmin||isAdminPhone(user.phone);
          send(ws,{type:'authSuccess',playerName:user.name,balance:user.balance,isRegistered:true,isAdmin:client.isAdmin,adminToken:client.isAdmin?ADMIN_PHONE:undefined});
          } else {
            client.telegramId=tid;
            send(ws,{type:'authSuccess',playerName:'',balance:0,isRegistered:false,isAdmin:false});
          }
          break;
        }
        case 'setName':{
          if(msg.name&&msg.name.trim()){client.playerName=msg.name.trim().substring(0,20);send(ws,{type:'nameSet',playerName:client.playerName});}
          break;
        }
      case 'reconnect':{
  const room=rooms[msg.roomId];
  if(!room||room.status!=='playing'){
    send(ws,{type:'reconnectFailed'}); break;
  }
  // Try by playerId first, fall back to telegramId for page-reload reconnects
  let ep=room.players.find(p=>p.playerId===client.playerId);
if(!ep&&msg.telegramId){
  const tid=String(msg.telegramId);
  ep=room.players.find(p=>String(p.telegramId)===tid);
    if(ep){
      // Re-link this new ws/client to the existing player slot
      const oldClient=Object.values(clients).find(c=>c.telegramId===tid&&c.playerId!==client.playerId);
      if(oldClient) delete clients[oldClient.playerId];
      ep.playerId=client.playerId;
      client.telegramId=String(msg.telegramId);
    }
  }
  if(ep){
    ep.ws=ws; client.roomId=msg.roomId;
    const activeCards=(ep.cardIds||[]).filter(Boolean);
    const cardsData=activeCards.map(id=>{const c=getCard(id);return{cardId:id,cardNumbers:c?c.numbers:[]};});
    send(ws,{type:'reconnected',roomId:msg.roomId,stakeId:room.stakeId,
      cards:cardsData,calledNumbers:room.calledNumbers,pot:room.pot,playerCount:room.players.length});
  } else {
    send(ws,{type:'reconnectFailed'});
  }
  break;
}
        case 'joinRoom':{
          const sc=STAKES.find(s=>s.id===msg.stakeId);
          if(!sc) return send(ws,{type:'error',message:'Invalid stake.'});
          if(client.balance<sc.amount) return send(ws,{type:'error',message:`Need ${sc.amount} ETB. Please deposit.`});
          if(!client.playerName) return send(ws,{type:'error',message:'Please set your name first.'});
          leaveRoom(client);
          const room=getOrCreateRoom(msg.stakeId);
          if(room.status!=='waiting'&&room.status!=='countdown') return send(ws,{type:'error',message:'Game already running.'});
          room.players.push({playerId:client.playerId,playerName:client.playerName,telegramId:client.telegramId,ws,cardIds:[],hasPaid:false,disqualified:false});
          client.roomId=room.roomId;
          send(ws,{type:'joinedRoom',roomId:room.roomId,stakeId:room.stakeId,balance:client.balance,status:room.status});
          broadcastCardPool(room); broadcastLobby();
          if(room.players.length>=2&&room.status==='waiting') startCountdown(room);
          break;
        }
        case 'selectCard':{
          if(!client.roomId) break;
          const room=rooms[client.roomId];
          if(!room||(room.status!=='waiting'&&room.status!=='countdown')) break;
          const cardId=parseInt(msg.cardId);
          const slot=parseInt(msg.slot)||1; // 1 or 2
          if(cardId<1||cardId>TOTAL_CARDS) break;
          const p=room.players.find(p=>p.playerId===client.playerId);
          if(!p) break;

          // Slot index (0-based)
          const slotIdx=slot-1; // 0 or 1

          // Release the old card in this slot if any
          if(p.cardIds[slotIdx]) room.takenCardIds.delete(p.cardIds[slotIdx]);

          // Check the new card isn't taken by someone else
          if(room.takenCardIds.has(cardId)) return send(ws,{type:'error',message:'Card already taken!'});

          // Charge for this slot if not yet paid for it
          // cardsPaid tracks how many cards have been charged
          if(!p.cardsPaid) p.cardsPaid=0;
          if(p.cardsPaid<=slotIdx){
            // Need to charge for this slot
            if(client.balance<room.stake) return send(ws,{type:'error',message:'Insufficient balance for second card.'});
            client.balance-=room.stake; p.cardsPaid++;
            await saveBalance(client.telegramId,client.balance);
            if(db&&client.telegramId){try{await db.logTx(client.telegramId,'stake',-room.stake,client.balance,room.roomId);}catch(e){}}
            send(ws,{type:'balanceUpdate',balance:client.balance});
          }

          p.cardIds[slotIdx]=cardId;
          room.takenCardIds.add(cardId);
          const card=getCard(cardId);

          // hasPaid = true if at least one card selected
          p.hasPaid=p.cardIds.filter(Boolean).length>0;

          send(ws,{type:'cardSelected',cardId,slot,cardNumbers:card.numbers,cardIds:p.cardIds});
          broadcastCardPool(room); break;
        }
        case 'claimBingo':{
          if(!client.roomId) return;
          const room=rooms[client.roomId];
          if(!room||room.status!=='playing') return;
          const p=room.players.find(p=>p.playerId===client.playerId);
          if(!p||p.disqualified) return;
          const activeCards=(p.cardIds||[]).filter(Boolean);
          if(activeCards.length===0) return; // spectator can't claim
          if(!room.claimWindowOpen) return send(ws,{type:'claimTooLate',message:'Too late!'});
          if(!room.claimedThisRound.find(c=>c.playerId===client.playerId))
            room.claimedThisRound.push({
              playerId:client.playerId,
              cardId:msg.cardId||null,
              markedIndices:msg.markedIndices||[]
            });
          if(room.callTimer) clearTimeout(room.callTimer);
          evaluateClaims(room); break;
        }
        case 'leaveRoom':
          leaveRoom(client); send(ws,{type:'leftRoom',balance:client.balance}); break;

        // ── Deposit request ──
        case 'depositRequest':{
          const{amount,txRef}=msg;
          if(!amount||amount<10) return send(ws,{type:'error',message:'Minimum deposit is 10 ETB.'});
          if(!txRef||!txRef.trim()) return send(ws,{type:'error',message:'Transaction reference required.'});
          if(!client.telegramId) return send(ws,{type:'error',message:'Please register first via the Telegram bot (/start).'});
          if(db){
            try{
              const id=await db.createDeposit(client.telegramId,amount,txRef.trim());
              if(!id) return send(ws,{type:'error',message:'Account not found in database. Please send /start to the bot again.'});
              send(ws,{type:'depositSubmitted',message:'Deposit request submitted! Waiting for admin approval.'});
            }catch(e){console.error('Deposit error:',e.message); send(ws,{type:'error',message:'Deposit failed: '+e.message});}
          } else {
            // Memory mode: auto-approve
            client.balance+=amount;
            send(ws,{type:'balanceUpdate',balance:client.balance});
            send(ws,{type:'depositSubmitted',message:'Deposit approved (demo mode).'});
          }
          break;
        }

        // ── Withdrawal request ──
        case 'withdrawalRequest':{
          const{amount}=msg;
          if(!amount||amount<50) return send(ws,{type:'error',message:'Minimum withdrawal is 50 ETB.'});
          if(client.balance<amount) return send(ws,{type:'error',message:'Insufficient balance.'});
          if(!client.telegramId) return send(ws,{type:'error',message:'Please register first.'});
          if(db){
            try{
              const result=await db.createWithdrawal(client.telegramId,amount);
              if(result.error) return send(ws,{type:'error',message:result.error});
              client.balance=result.newBalance;
              send(ws,{type:'balanceUpdate',balance:client.balance});
              send(ws,{type:'withdrawalSubmitted',message:'Withdrawal request submitted! Admin will process it soon.'});
            }catch(e){send(ws,{type:'error',message:'Failed to submit withdrawal.'});}
          } else {
            client.balance-=amount;
            send(ws,{type:'balanceUpdate',balance:client.balance});
            send(ws,{type:'withdrawalSubmitted',message:'Withdrawal submitted (demo mode).'});
          }
          break;
        }
      }
    }catch(err){console.error('WS:',err);}
  });

  ws.on('close',()=>{
    const c=clients[ws._pid];
    if(!c) return;
    if(c.roomId){const room=rooms[c.roomId];if(room&&room.status==='playing'){const p=room.players.find(p=>p.playerId===c.playerId);if(p)p.ws=null;return;}leaveRoom(c);}
    delete clients[ws._pid]; broadcastLobby();
  });
  ws.on('error',()=>{});
});

// ─── ADMIN REST API ───────────────────────────────────────────
// Admin auth — accepts phone number OR telegram ID of the admin
function adminAuth(req,res,next){
  const tok=String(req.headers['x-admin-token']||req.query.token||'');
  if(isAdminPhone(tok)) return next();
  // Frontend sends telegramId as token — check if that user isAdmin
  const cl=Object.values(clients).find(c=>c.telegramId===tok);
  if(cl&&cl.isAdmin) return next();
  res.status(403).json({error:'Forbidden'});
}

app.get('/api/admin/deposits', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getDeposits(req.query.status||'pending'));
});
app.post('/api/admin/deposits/:id/approve', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.approveDeposit(parseInt(req.params.id));
  if(result){
    // Push balance update to connected user
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl){cl.balance=result.newBalance;send(cl.ws,{type:'balanceUpdate',balance:result.newBalance});send(cl.ws,{type:'notification',message:`✅ Deposit of ${result.amount} ETB approved!`});}
  }
  res.json({ok:true,result});
});
app.post('/api/admin/deposits/:id/reject', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  await db.rejectDeposit(parseInt(req.params.id));
  res.json({ok:true});
});

app.get('/api/admin/withdrawals', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getWithdrawals(req.query.status||'pending'));
});
app.post('/api/admin/withdrawals/:id/approve', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.approveWithdrawal(parseInt(req.params.id));
  if(result){
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl) send(cl.ws,{type:'notification',message:`✅ Withdrawal of ${result.amount} ETB approved!`});
  }
  res.json({ok:true,result});
});
app.post('/api/admin/withdrawals/:id/reject', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.rejectWithdrawal(parseInt(req.params.id));
  if(result){
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl){cl.balance=result.newBalance;send(cl.ws,{type:'balanceUpdate',balance:result.newBalance});send(cl.ws,{type:'notification',message:`❌ Withdrawal rejected. ${result.newBalance} ETB refunded.`});}
  }
  res.json({ok:true,result});
});

app.get('/api/admin/search', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.searchByPhone(req.query.phone||''));
});

// ── Payment info (Telebirr account shown on deposit page) ──
app.get('/api/payment-info', (req,res)=>{
  res.json(PAYMENT_INFO);
});
app.get('/api/admin/payment-settings', adminAuth, (req,res)=>{
  res.json(PAYMENT_INFO);
});
app.post('/api/admin/payment-settings', adminAuth, async(req,res)=>{
  const { telebirrNumber, telebirrName } = req.body || {};
  if(telebirrNumber && String(telebirrNumber).trim()) PAYMENT_INFO.telebirrNumber = String(telebirrNumber).trim();
  if(telebirrName && String(telebirrName).trim())     PAYMENT_INFO.telebirrName   = String(telebirrName).trim();
  if(db){
    try{
      await db.setSetting('telebirr_number', PAYMENT_INFO.telebirrNumber);
      await db.setSetting('telebirr_name',   PAYMENT_INFO.telebirrName);
    }catch(e){ console.error('⚠️ Settings save:', e.message); }
  }
  res.json({ ok:true, ...PAYMENT_INFO });
});

app.get('/api/leaderboard', async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getLeaderboard());
});

app.get('/api/user/:tid', async(req,res)=>{
  const u=await loadUser(req.params.tid);
  if(!u) return res.status(404).json({error:'Not found'});
  res.json(u);
});

// ─── START ────────────────────────────────────────────────────
server.listen(PORT,()=>{
  console.log(`\n🎱 Beteseb Bingo v5 on port ${PORT}\n`);
  startTelegramBot();
});

// ─── BOT ─────────────────────────────────────────────────────
function startTelegramBot(){
  const TOKEN=process.env.BOT_TOKEN, GAME_URL=process.env.GAME_URL||'https://beteseb-bingo.onrender.com';
  if(!TOKEN){console.log('ℹ️ No BOT_TOKEN');return;}
  let Bot; try{Bot=require('node-telegram-bot-api');}catch(e){console.log('ℹ️ Bot lib missing');return;}
  const bot=new Bot(TOKEN,{polling:true}), pending={};

  async function showPlay(chatId,tid){
    const user=await loadUser(String(tid));
    if(user){
      bot.sendMessage(chatId,`👋 Welcome back *${user.name}*!\n💰 Balance: *${user.balance} ETB*`,
        {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🎮 Play Beteseb Bingo',web_app:{url:`${GAME_URL}?tid=${tid}`}}]]}});
    } else {
      pending[tid]={step:'ask_name'};
      bot.sendMessage(chatId,'🎱 Welcome to *Beteseb Bingo!*\n\nWhat should we call you?',{parse_mode:'Markdown'});
    }
  }

  bot.onText(/\/start/,msg=>showPlay(msg.chat.id,msg.from.id));
  bot.onText(/\/play/, msg=>showPlay(msg.chat.id,msg.from.id));
  bot.onText(/\/balance/,async msg=>{
    const u=await loadUser(String(msg.from.id));
    bot.sendMessage(msg.chat.id,u?`💰 Balance: *${u.balance} ETB*`:'Use /start to register.',{parse_mode:'Markdown'});
  });

  bot.on('message',msg=>{
    const tid=msg.from.id, p=pending[tid];
    if(!p||!msg.text||msg.text.startsWith('/')) return;
    if(p.step==='ask_name'){
      p.name=msg.text.trim().substring(0,30); p.step='ask_phone';
      bot.sendMessage(msg.chat.id,`Nice to meet you *${p.name}*! 👋\n\nShare your phone number:`,
        {parse_mode:'Markdown',reply_markup:{keyboard:[[{text:'📱 Share Phone Number',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true}});
    }
  });

  bot.on('contact',async msg=>{
    const tid=msg.from.id, p=pending[tid];
    if(!p) return;
    const phone=(msg.contact.phone_number||'').replace(/^\+/,''), name=p.name||msg.from.first_name||'Player';
    delete pending[tid];
    let balance=0;
    if(db){try{const u=await db.createUser(String(tid),name,phone);balance=parseFloat(u.balance);userCache[String(tid)]={name,phone,balance,isAdmin:isAdminPhone(phone)};}catch(e){console.error('createUser error:',e.message);}}
    else{userCache[String(tid)]={name,phone,balance:0,isAdmin:isAdminPhone(phone)};}
    bot.sendMessage(msg.chat.id,
      `✅ *Registered!*\nName: *${name}*\nPhone: ${phone}\nBalance: *${balance} ETB*\n\nDeposit ETB to start playing!`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🎮 Play Beteseb Bingo',web_app:{url:`${GAME_URL}?tid=${tid}`}}]],remove_keyboard:true}});
  });

  console.log('🤖 Telegram bot started!');
}
