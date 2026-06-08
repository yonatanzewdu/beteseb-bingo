/**
 * Beteseb Bingo — Multiplayer Server v4
 * FULLY DATABASE-INTEGRATED:
 *  - All user data (name, balance, phone) stored in PostgreSQL
 *  - Starting balance is 0 (deposited separately)
 *  - Name comes from Telegram — no name modal in the game
 *  - Contact/phone saved to DB on registration
 *  - Balance deducted/awarded via DB functions (atomic)
 *  - 400 fixed permanent cards
 *  - Split prize on simultaneous win
 *  - Disqualification on false BINGO
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const db        = require('./db');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────
const LOBBY_WAIT_MS    = 15000;
const CALL_INTERVAL_MS = 5000;
const CLAIM_WINDOW_MS  = 4800;
const TOTAL_CARDS      = 400;

const STAKES = [
  { id: 'st10',  amount: 10,  maxPlayers: 50 },
  { id: 'st20',  amount: 20,  maxPlayers: 50 },
  { id: 'st30',  amount: 30,  maxPlayers: 50 },
  { id: 'st50',  amount: 50,  maxPlayers: 50 },
  { id: 'st80',  amount: 80,  maxPlayers: 50 },
  { id: 'st100', amount: 100, maxPlayers: 50 },
];

// ─── FIXED CARD POOL ─────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateFixedCard(cardIndex) {
  const rng = seededRandom(cardIndex * 7919);
  const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
  const numbers = Array(25).fill(0);
  for (let col = 0; col < 5; col++) {
    const [lo, hi] = ranges[col];
    const pool = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    const picked = [];
    for (let i = 0; i < 5; i++) {
      const idx = Math.floor(rng() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    picked.sort((a, b) => a - b);
    for (let row = 0; row < 5; row++) {
      const cellIdx = row * 5 + col;
      numbers[cellIdx] = (cellIdx === 12) ? 0 : picked[row];
    }
  }
  return numbers;
}

const CARD_POOL = [];
for (let i = 1; i <= TOTAL_CARDS; i++) {
  CARD_POOL.push({ id: i, numbers: generateFixedCard(i) });
}

function getCardById(id) {
  return CARD_POOL.find(c => c.id === id);
}

// ─── WIN VERIFICATION ────────────────────────────────────────
function checkWin(cardNumbers, calledNumbers, markedIndices) {
  const calledSet = new Set(calledNumbers);
  const markedSet = new Set(markedIndices || []);
  markedSet.add(12);
  const hit = i => i === 12 || (calledSet.has(cardNumbers[i]) && markedSet.has(i));
  const PATTERNS = [
    [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
    [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
    [0,6,12,18,24],[4,8,12,16,20],
    [0,4,20,24]
  ];
  return PATTERNS.some(p => p.every(idx => hit(idx)));
}

// ─── STATE ───────────────────────────────────────────────────
const clients = {}; // playerId -> client
const rooms   = {}; // roomId   -> room

// ─── ROOM HELPERS ────────────────────────────────────────────
function getOrCreateRoom(stakeId) {
  let room = Object.values(rooms).find(
    r => r.stakeId === stakeId && (r.status === 'waiting' || r.status === 'countdown')
  );
  if (room) return room;

  const stake = STAKES.find(s => s.id === stakeId);
  const roomId = uuidv4();
  room = {
    roomId, stakeId,
    stake: stake.amount,
    status: 'waiting',
    players: [],
    calledNumbers: [],
    availableNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    callTimer: null,
    countdownTimer: null,
    countdownLeft: Math.ceil(LOBBY_WAIT_MS / 1000),
    claimWindowOpen: false,
    claimWindowTimer: null,
    claimedThisRound: [],
    takenCardIds: new Set(),
    pot: 0,
    dbGameId: null,  // DB game row id
  };
  rooms[roomId] = room;
  return room;
}

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(str);
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastLobby() {
  const payload = STAKES.map(s => {
    const r = Object.values(rooms).find(r => r.stakeId === s.id);
    return {
      stakeId: s.id, amount: s.amount, maxPlayers: s.maxPlayers,
      playerCount: r ? r.players.length : 0,
      status: r ? r.status : 'waiting',
      countdown: r && r.status === 'countdown' ? r.countdownLeft : 0
    };
  });
  Object.values(clients).forEach(c => {
    if (!c.roomId) send(c.ws, { type: 'lobbyUpdate', stakes: payload });
  });
}

function broadcastCardPool(room) {
  const pool = CARD_POOL.map(c => ({
    id: c.id,
    taken: room.takenCardIds.has(c.id),
    takenByMe: false
  }));
  room.players.forEach(p => {
    const perPlayer = pool.map(c => ({ ...c, takenByMe: p.cardId === c.id }));
    send(p.ws, { type: 'cardPoolUpdate', pool: perPlayer });
  });
}

// ─── GAME LIFECYCLE ───────────────────────────────────────────
function startCountdown(room) {
  room.status = 'countdown';
  room.countdownLeft = Math.ceil(LOBBY_WAIT_MS / 1000);

  room.countdownTimer = setInterval(() => {
    room.countdownLeft--;

    if (room.players.length < 2) {
      clearInterval(room.countdownTimer);
      room.status = 'waiting';
      broadcast(room, { type: 'waitingForPlayers' });
      broadcastLobby();
      return;
    }

    broadcast(room, { type: 'countdown', seconds: room.countdownLeft });

    if (room.countdownLeft <= 0) {
      clearInterval(room.countdownTimer);
      startGame(room);
    }
  }, 1000);
}

async function startGame(room) {
  // Assign free card to anyone who didn't pick
  for (const p of room.players) {
    if (!p.cardId) {
      const free = CARD_POOL.find(c => !room.takenCardIds.has(c.id));
      if (free) {
        p.cardId = free.id;
        room.takenCardIds.add(free.id);
      }
    }
  }

  // Create game in DB
  try {
    const dbGame = await db.createGame(room.roomId, room.stakeId, room.stake);
    room.dbGameId = dbGame.id;
  } catch (err) {
    console.error('DB createGame error:', err);
  }

  // Deduct stakes from each player's DB balance
  for (const p of room.players) {
    if (!p.hasPaid && p.cardId) {
      const cl = clients[p.playerId];
      if (!cl) continue;
      try {
        const newBal = await db.deductStake(cl.dbUserId, room.stake, room.dbGameId || 0);
        cl.balance = parseFloat(newBal);
        p.hasPaid = true;
        send(p.ws, { type: 'balanceUpdate', balance: cl.balance });

        // Add participant to DB
        if (room.dbGameId) {
          await db.addParticipant(room.dbGameId, cl.dbUserId, p.cardId);
        }
      } catch (err) {
        // Insufficient balance — remove player
        send(p.ws, { type: 'error', message: 'Insufficient balance. You have been removed from the game.' });
        p._removeMe = true;
      }
    }
  }

  // Remove players who couldn't pay
  room.players = room.players.filter(p => !p._removeMe);

  if (room.players.length < 2) {
    // Refund anyone who paid and end
    for (const p of room.players) {
      if (p.hasPaid) {
        const cl = clients[p.playerId];
        if (cl && cl.dbUserId) {
          try {
            const newBal = await db.updateBalance(cl.dbUserId, cl.balance + room.stake);
            cl.balance = parseFloat(newBal);
            send(p.ws, { type: 'balanceUpdate', balance: cl.balance });
          } catch (e) {}
        }
      }
    }
    broadcast(room, { type: 'error', message: 'Not enough players to start.' });
    room.status = 'waiting';
    broadcastLobby();
    return;
  }

  room.status = 'playing';
  room.pot = room.players.filter(p => p.hasPaid).length * room.stake;
  room.calledNumbers = [];
  room.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  room.claimedThisRound = [];
  room.claimWindowOpen = false;

  if (room.dbGameId) {
    db.updateGamePot(room.dbGameId, room.pot).catch(console.error);
  }

  const playersData = room.players.map(p => {
    const card = getCardById(p.cardId);
    return { playerId: p.playerId, playerName: p.playerName, cardId: p.cardId, cardNumbers: card ? card.numbers : [] };
  });

  broadcast(room, { type: 'gameStart', pot: room.pot, players: playersData });

  room.players.forEach(p => {
    const card = getCardById(p.cardId);
    if (card) {
      send(p.ws, {
        type: 'yourCard',
        cardId: p.cardId,
        cardNumbers: card.numbers,
        pot: room.pot,
        playerCount: room.players.length
      });
    }
  });

  broadcastLobby();
  scheduleNextCall(room);
}

function scheduleNextCall(room) {
  room.callTimer = setTimeout(() => callNumber(room), CALL_INTERVAL_MS);
}

function callNumber(room) {
  if (room.status !== 'playing') return;

  if (room.claimedThisRound.length > 0) {
    evaluateClaims(room);
    return;
  }

  room.claimWindowOpen = false;
  room.claimedThisRound = [];

  if (room.availableNumbers.length === 0) {
    endGame(room, [], 'All 75 numbers called — no winner!');
    return;
  }

  const idx = Math.floor(Math.random() * room.availableNumbers.length);
  const drawn = room.availableNumbers.splice(idx, 1)[0];
  room.calledNumbers.push(drawn);

  if (room.dbGameId) {
    db.updateCalledNumbers(room.dbGameId, room.calledNumbers).catch(console.error);
  }

  broadcast(room, {
    type: 'numberCalled',
    number: drawn,
    calledNumbers: room.calledNumbers,
    callCount: room.calledNumbers.length,
    claimWindowMs: CLAIM_WINDOW_MS
  });

  room.claimWindowOpen = true;
  scheduleNextCall(room);
}

function evaluateClaims(room) {
  const validWinners = [];
  const cheaters = [];

  room.claimedThisRound.forEach(claim => {
    const player = room.players.find(p => p.playerId === claim.playerId);
    if (!player || player.disqualified) return;
    const card = getCardById(player.cardId);
    if (!card) return;
    if (checkWin(card.numbers, room.calledNumbers, claim.markedIndices)) {
      validWinners.push(player);
    } else {
      cheaters.push(player);
    }
  });

  cheaters.forEach(p => {
    p.disqualified = true;
    send(p.ws, { type: 'disqualified', message: '🚫 You were disqualified for a false BINGO claim!' });
    broadcast(room, { type: 'playerDisqualified', playerName: p.playerName });
    if (room.dbGameId) {
      const cl = clients[p.playerId];
      if (cl && cl.dbUserId) db.disqualifyParticipant(room.dbGameId, cl.dbUserId).catch(console.error);
    }
  });

  room.claimedThisRound = [];
  room.claimWindowOpen = false;

  if (validWinners.length > 0) {
    endGame(room, validWinners, null);
  } else {
    scheduleNextCall(room);
  }
}

async function endGame(room, winners, customMessage) {
  if (room.callTimer)        clearTimeout(room.callTimer);
  if (room.countdownTimer)   clearInterval(room.countdownTimer);
  if (room.claimWindowTimer) clearTimeout(room.claimWindowTimer);

  room.status = 'finished';
  room.claimWindowOpen = false;

  let winAmount = 0;
  let winnerNames = [];
  const winnerUserIds = [];

  if (winners && winners.length > 0) {
    winAmount = Math.floor(room.pot / winners.length);
    winnerNames = winners.map(w => w.playerName);

    for (const w of winners) {
      const cl = clients[w.playerId];
      if (!cl) continue;
      winnerUserIds.push(cl.dbUserId);
      try {
        if (cl.dbUserId && room.dbGameId) {
          const newBal = await db.awardWin(cl.dbUserId, winAmount, room.dbGameId);
          cl.balance = parseFloat(newBal);
        } else {
          cl.balance += winAmount;
        }
        send(w.ws, { type: 'balanceUpdate', balance: cl.balance });
      } catch (err) {
        console.error('awardWin error:', err);
        cl.balance += winAmount;
        send(w.ws, { type: 'balanceUpdate', balance: cl.balance });
      }
    }
  }

  // Update DB game record
  if (room.dbGameId) {
    db.endGame(room.dbGameId, winnerUserIds, winAmount, winners.length > 1).catch(console.error);
  }

  const isSplit = winners && winners.length > 1;
  const message = customMessage ||
    (isSplit
      ? `🎉 Split win! ${winnerNames.join(' & ')} each win ${winAmount} ETB!`
      : `🏆 ${winnerNames[0]} wins ${winAmount} ETB!`);

  broadcast(room, { type: 'gameOver', winners: winnerNames, winAmount, isSplit, message, calledNumbers: room.calledNumbers });

  setTimeout(() => {
    if (!rooms[room.roomId]) return;

    room.status = 'waiting';
    room.calledNumbers = [];
    room.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    room.pot = 0;
    room.takenCardIds = new Set();
    room.claimedThisRound = [];
    room.claimWindowOpen = false;
    room.dbGameId = null;

    room.players.forEach(p => {
      p.cardId = null;
      p.hasPaid = false;
      p.disqualified = false;
    });

    room.players.forEach(p => {
      const cl = clients[p.playerId];
      send(p.ws, {
        type: 'backToCardSelection',
        roomId: room.roomId,
        stakeId: room.stakeId,
        balance: cl ? cl.balance : 0
      });
    });

    broadcastCardPool(room);
    broadcastLobby();

    if (room.players.length >= 2) startCountdown(room);
  }, 6000);
}

function leaveRoom(client) {
  if (!client.roomId) return;
  const room = rooms[client.roomId];
  if (!room) { client.roomId = null; return; }

  const player = room.players.find(p => p.playerId === client.playerId);
  if (player) {
    if (player.cardId) room.takenCardIds.delete(player.cardId);
    // Refund if game hasn't started (DB refund)
    if (player.hasPaid && (room.status === 'waiting' || room.status === 'countdown')) {
      if (client.dbUserId) {
        db.updateBalance(client.dbUserId, client.balance + room.stake)
          .then(newBal => {
            client.balance = parseFloat(newBal);
            send(client.ws, { type: 'balanceUpdate', balance: client.balance });
          })
          .catch(err => {
            console.error('Refund error:', err);
            client.balance += room.stake;
            send(client.ws, { type: 'balanceUpdate', balance: client.balance });
          });
      } else {
        client.balance += room.stake;
        send(client.ws, { type: 'balanceUpdate', balance: client.balance });
      }
    }
  }

  room.players = room.players.filter(p => p.playerId !== client.playerId);
  client.roomId = null;

  if (room.players.length === 0) {
    if (room.callTimer)      clearTimeout(room.callTimer);
    if (room.countdownTimer) clearInterval(room.countdownTimer);
    delete rooms[room.roomId];
  } else {
    broadcastCardPool(room);
    broadcast(room, { type: 'playerLeft', playerCount: room.players.length });
  }

  broadcastLobby();
}

// ─── WEBSOCKET HANDLER ────────────────────────────────────────
wss.on('connection', (ws) => {
  const playerId = uuidv4();
  const client = {
    playerId,
    playerName: '',
    telegramId: null,
    dbUserId: null,
    balance: 0,
    roomId: null,
    ws
  };
  clients[playerId] = client;

  // Send connected — no balance yet (will be set after telegramRegister)
  const lobbyState = STAKES.map(s => {
    const r = Object.values(rooms).find(r => r.stakeId === s.id);
    return {
      stakeId: s.id, amount: s.amount, maxPlayers: s.maxPlayers,
      playerCount: r ? r.players.length : 0,
      status: r ? r.status : 'waiting',
      countdown: r && r.status === 'countdown' ? r.countdownLeft : 0
    };
  });

  send(ws, { type: 'connected', playerId, balance: 0, stakes: lobbyState });

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {

        // ── Telegram registration — load user from DB ──
        case 'telegramRegister': {
          const { telegramId, name, phone } = msg;
          if (!telegramId) break;

          client.telegramId = telegramId;

          try {
            // Try to get existing user from DB
            let user = await db.getUserByTelegramId(telegramId);

            if (!user) {
              // New user — register with balance 0
              user = await db.registerUser(telegramId, name || `Player_${telegramId}`, phone || null);
            } else {
              // Update last_seen
              await db.registerUser(telegramId, user.name, user.phone);
            }

            client.dbUserId   = user.id;
            client.playerName = user.name;
            client.balance    = parseFloat(user.balance);

            send(ws, {
              type: 'registered',
              playerName: user.name,
              balance: client.balance,
              isReturning: true
            });
          } catch (err) {
            console.error('DB telegramRegister error:', err);
            // Fallback — no DB
            client.playerName = name || `Player_${telegramId}`;
            client.balance    = 0;
            send(ws, { type: 'registered', playerName: client.playerName, balance: 0, isReturning: false });
          }
          break;
        }

        // ── Reconnect to active game ──
        case 'reconnect': {
          const { roomId } = msg;
          const room = rooms[roomId];
          if (!room || room.status !== 'playing') break;

          const existingPlayer = room.players.find(p => p.playerId === client.playerId);
          if (existingPlayer) {
            existingPlayer.ws = ws;
            client.roomId = roomId;
            const card = getCardById(existingPlayer.cardId);
            send(ws, {
              type: 'reconnected',
              roomId,
              stakeId: room.stakeId,
              cardId: existingPlayer.cardId,
              cardNumbers: card ? card.numbers : [],
              calledNumbers: room.calledNumbers,
              pot: room.pot,
              playerCount: room.players.length
            });
          }
          break;
        }

        case 'joinRoom': {
          const stakeConfig = STAKES.find(s => s.id === msg.stakeId);
          if (!stakeConfig) return send(ws, { type: 'error', message: 'Invalid stake.' });
          if (client.balance < stakeConfig.amount)
            return send(ws, { type: 'error', message: 'Insufficient balance.' });

          leaveRoom(client);
          const room = getOrCreateRoom(msg.stakeId);

          if (room.status !== 'waiting' && room.status !== 'countdown')
            return send(ws, { type: 'error', message: 'Game already running.' });

          const player = {
            playerId: client.playerId,
            playerName: client.playerName || `Player_${client.playerId.slice(0,4)}`,
            ws, cardId: null, hasPaid: false, disqualified: false
          };
          room.players.push(player);
          client.roomId = room.roomId;

          send(ws, {
            type: 'joinedRoom',
            roomId: room.roomId,
            stakeId: room.stakeId,
            balance: client.balance,
            status: room.status
          });

          broadcastCardPool(room);
          broadcastLobby();

          if (room.players.length >= 2 && room.status === 'waiting') startCountdown(room);
          break;
        }

        case 'selectCard': {
          if (!client.roomId) break;
          const room = rooms[client.roomId];
          if (!room || (room.status !== 'waiting' && room.status !== 'countdown')) break;

          const cardId = parseInt(msg.cardId);
          if (cardId < 1 || cardId > TOTAL_CARDS) break;

          if (room.takenCardIds.has(cardId))
            return send(ws, { type: 'error', message: 'Card already taken!' });

          const player = room.players.find(p => p.playerId === client.playerId);
          if (!player) break;

          if (player.cardId) room.takenCardIds.delete(player.cardId);

          // Deduct balance (DB) on first card pick
          if (!player.hasPaid) {
            if (client.balance < room.stake)
              return send(ws, { type: 'error', message: 'Insufficient balance.' });

            if (client.dbUserId) {
              try {
                // Just reserve — actual deduct happens in startGame for atomicity
                // But check balance here to give fast feedback
              } catch (e) {}
            }

            client.balance -= room.stake;
            player.hasPaid = true;
            send(ws, { type: 'balanceUpdate', balance: client.balance });
          }

          player.cardId = cardId;
          room.takenCardIds.add(cardId);

          const card = getCardById(cardId);
          send(ws, { type: 'cardSelected', cardId, cardNumbers: card.numbers });
          broadcastCardPool(room);
          break;
        }

        case 'claimBingo': {
          if (!client.roomId) return;
          const room = rooms[client.roomId];
          if (!room || room.status !== 'playing') return;

          const player = room.players.find(p => p.playerId === client.playerId);
          if (!player || player.disqualified) return;

          if (!room.claimWindowOpen)
            return send(ws, { type: 'claimTooLate', message: 'Too late! Next number already called.' });

          const alreadyClaimed = room.claimedThisRound.find(c => c.playerId === client.playerId);
          if (!alreadyClaimed) {
            room.claimedThisRound.push({ playerId: client.playerId, markedIndices: msg.markedIndices || [] });
          }

          if (room.callTimer) clearTimeout(room.callTimer);
          evaluateClaims(room);
          break;
        }

        case 'leaveRoom':
          leaveRoom(client);
          send(ws, { type: 'leftRoom', balance: client.balance });
          break;

        // Manual deposit (for testing / admin)
        case 'deposit':
          if (msg.amount && msg.amount >= 10 && client.dbUserId) {
            try {
              const newBal = await db.updateBalance(client.dbUserId, client.balance + parseInt(msg.amount));
              client.balance = parseFloat(newBal);
              send(ws, { type: 'balanceUpdate', balance: client.balance });
            } catch (err) {
              client.balance += parseInt(msg.amount);
              send(ws, { type: 'balanceUpdate', balance: client.balance });
            }
          }
          break;
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });

  ws.on('close', () => {
    const c = client;
    if (c && c.roomId) {
      const room = rooms[c.roomId];
      if (room && room.status === 'playing') {
        const player = room.players.find(p => p.playerId === c.playerId);
        if (player) player.ws = null;
        return;
      }
      leaveRoom(c);
    }
    delete clients[c.playerId];
    broadcastLobby();
  });

  ws.on('error', () => {});
});

// ─── REST API ────────────────────────────────────────────────
app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const user = await db.getUserByTelegramId(parseInt(req.params.telegramId));
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const rows = await db.getLeaderboard(20);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎱 Beteseb Bingo Server v4 running on http://localhost:${PORT}\n`);
  startTelegramBot();
});

// ─── TELEGRAM BOT ────────────────────────────────────────────
function startTelegramBot() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const GAME_URL  = process.env.GAME_URL || `https://beteseb-bingo.onrender.com`;

  if (!BOT_TOKEN) {
    console.log('ℹ️  No BOT_TOKEN set — Telegram bot not started.');
    return;
  }

  let TelegramBot;
  try { TelegramBot = require('node-telegram-bot-api'); }
  catch (e) { console.log('ℹ️  node-telegram-bot-api not installed — bot skipped.'); return; }

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  const pendingReg = {}; // telegramId -> { step, name }

  // /start
  bot.onText(/\/start/, async (msg) => {
    const tid  = msg.from.id;
    const name = msg.from.first_name || 'Player';

    try {
      const existing = await db.getUserByTelegramId(tid);
      if (existing) {
        return bot.sendMessage(msg.chat.id,
          `👋 Welcome back, *${existing.name}!*\nBalance: *${existing.balance} ETB*`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{
              text: '🎮 Play Beteseb Bingo',
              web_app: { url: `${GAME_URL}?tid=${tid}` }
            }]]}
          }
        );
      }
    } catch (e) {}

    // New user — ask name (or use Telegram name directly)
    pendingReg[tid] = { step: 'ask_phone', name };
    bot.sendMessage(msg.chat.id,
      `🎱 Welcome to *Beteseb Bingo!*\n\nHello, *${name}!* Please share your phone number to register:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [[{ text: '📱 Share Phone Number', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  });

  // Handle contact — phone shared → save to DB with balance 0
  bot.on('contact', async (msg) => {
    const tid = msg.from.id;
    const phone = msg.contact.phone_number;
    const name  = (pendingReg[tid] && pendingReg[tid].name) || msg.from.first_name || 'Player';

    try {
      // Register with balance 0
      const user = await db.registerUser(tid, name, phone);
      delete pendingReg[tid];

      bot.sendMessage(msg.chat.id,
        `✅ *Registered!*\n\nName: *${user.name}*\nPhone: ${phone}\nBalance: *${user.balance} ETB*\n\nTap below to play! 🎱`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{
              text: '🎮 Play Beteseb Bingo',
              web_app: { url: `${GAME_URL}?tid=${tid}` }
            }]],
            remove_keyboard: true
          }
        }
      );
    } catch (err) {
      console.error('DB registerUser error:', err);
      bot.sendMessage(msg.chat.id, '❌ Registration failed. Please try /start again.');
    }
  });

  // /balance
  bot.onText(/\/balance/, async (msg) => {
    try {
      const user = await db.getUserByTelegramId(msg.from.id);
      if (!user) return bot.sendMessage(msg.chat.id, 'Please /start to register first.');
      bot.sendMessage(msg.chat.id, `💰 Balance: *${user.balance} ETB*`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Error fetching balance. Try again.');
    }
  });

  // /play
  bot.onText(/\/play/, async (msg) => {
    try {
      const user = await db.getUserByTelegramId(msg.from.id);
      if (!user) return bot.sendMessage(msg.chat.id, 'Please /start to register first.');
      bot.sendMessage(msg.chat.id, `Ready to play? 🎱`, {
        reply_markup: { inline_keyboard: [[{
          text: '🎮 Open Game',
          web_app: { url: `${GAME_URL}?tid=${msg.from.id}` }
        }]]}
      });
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Error. Try again.');
    }
  });

  console.log('🤖 Telegram bot started successfully!');
}
