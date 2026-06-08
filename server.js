/**
 * Beteseb Bingo — Multiplayer Server v3
 * Features:
 *  - 400 fixed, permanent cards (seeded by card ID — never change)
 *  - Split prize when multiple players win simultaneously
 *  - Disqualification on false BINGO claim
 *  - Must claim BINGO before next number is called (window locks)
 *  - After game ends → back to card selection (not lobby)
 *  - Reconnection support (resume in-progress game)
 *  - PostgreSQL database integration ready
 */

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────
const LOBBY_WAIT_MS   = 15000;
const CALL_INTERVAL_MS = 5000;
const CLAIM_WINDOW_MS  = 4800; // Must claim BEFORE next number (slightly under interval)
const TOTAL_CARDS      = 400;

const STAKES = [
  { id: 'st10',  amount: 10,  maxPlayers: 50 },
  { id: 'st20',  amount: 20,  maxPlayers: 50 },
  { id: 'st30',  amount: 30,  maxPlayers: 50 },
  { id: 'st50',  amount: 50,  maxPlayers: 50 },
  { id: 'st80',  amount: 80,  maxPlayers: 50 },
  { id: 'st100', amount: 100, maxPlayers: 50 },
];

// ─── FIXED CARD POOL (seeded, permanent) ─────────────────────
// Each card is generated once at startup using a deterministic seed
// so card #5 always has the same numbers regardless of game session.
function seededRandom(seed) {
  // Mulberry32 PRNG — fast deterministic random from integer seed
  let s = seed;
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateFixedCard(cardIndex) {
  const rng = seededRandom(cardIndex * 7919); // prime multiplier for spread
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

// Build all 400 cards at startup — permanently fixed
const CARD_POOL = [];
for (let i = 1; i <= TOTAL_CARDS; i++) {
  CARD_POOL.push({ id: i, numbers: generateFixedCard(i) });
}

function getCardById(id) {
  return CARD_POOL.find(c => c.id === id);
}

// ─── WIN VERIFICATION ─────────────────────────────────────────
function checkWin(cardNumbers, calledNumbers, markedIndices) {
  const calledSet  = new Set(calledNumbers);
  const markedSet  = new Set(markedIndices || []);
  markedSet.add(12); // FREE cell always marked

  // A cell is valid only if: FREE space OR (server called it AND player manually marked it)
  const hit = i => i === 12 || (calledSet.has(cardNumbers[i]) && markedSet.has(i));

  const PATTERNS = [
    [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24], // rows
    [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],     // cols
    [0,6,12,18,24],[4,8,12,16,20],                                                  // diagonals
    [0,4,20,24]                                                                      // 4 corners
  ];
  return PATTERNS.some(p => p.every(idx => hit(idx)));
}

// ─── STATE ───────────────────────────────────────────────────
const clients = {}; // playerId -> client
const rooms   = {}; // roomId   -> room

// For reconnection: telegramId -> { playerId, name, balance }
const registeredUsers = {};

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
    players: [],        // { playerId, playerName, ws, cardId, hasPaid, disqualified }
    calledNumbers: [],
    availableNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    callTimer: null,
    countdownTimer: null,
    countdownLeft: Math.ceil(LOBBY_WAIT_MS / 1000),
    claimWindowOpen: false,   // true between number call and next call
    claimWindowTimer: null,
    claimedThisRound: [],     // players who claimed during this window
    takenCardIds: new Set(),
    pot: 0,
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
    takenByMe: false // overridden per-player below
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

function startGame(room) {
  // Assign free card to anyone who didn't pick
  room.players.forEach(p => {
    if (!p.cardId) {
      const free = CARD_POOL.find(c => !room.takenCardIds.has(c.id));
      if (free) {
        p.cardId = free.id;
        room.takenCardIds.add(free.id);
        if (!p.hasPaid) {
          const cl = clients[p.playerId];
          if (cl && cl.balance >= room.stake) {
            cl.balance -= room.stake;
            p.hasPaid = true;
            send(p.ws, { type: 'balanceUpdate', balance: cl.balance });
          }
        }
      }
    }
  });

  room.status = 'playing';
  room.pot = room.players.filter(p => p.hasPaid).length * room.stake;
  room.calledNumbers = [];
  room.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  room.claimedThisRound = [];
  room.claimWindowOpen = false;

  const playersData = room.players.map(p => {
    const card = getCardById(p.cardId);
    return {
      playerId: p.playerId,
      playerName: p.playerName,
      cardId: p.cardId,
      cardNumbers: card ? card.numbers : [],
    };
  });

  broadcast(room, {
    type: 'gameStart',
    pot: room.pot,
    players: playersData,
    myCardId: null // overridden per-player below
  });

  // Send each player their own card info
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

  // Close claim window from previous round — evaluate pending claims
  if (room.claimedThisRound.length > 0) {
    evaluateClaims(room);
    return; // evaluateClaims will end game or continue
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

  broadcast(room, {
    type: 'numberCalled',
    number: drawn,
    calledNumbers: room.calledNumbers,
    callCount: room.calledNumbers.length,
    claimWindowMs: CLAIM_WINDOW_MS
  });

  // Open the claim window
  room.claimWindowOpen = true;

  // Schedule next call
  scheduleNextCall(room);
}

function evaluateClaims(room) {
  // Verify all claims received this round
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

  // Disqualify cheaters
  cheaters.forEach(p => {
    p.disqualified = true;
    send(p.ws, {
      type: 'disqualified',
      message: '🚫 You were disqualified for a false BINGO claim!'
    });
    broadcast(room, {
      type: 'playerDisqualified',
      playerName: p.playerName
    });
  });

  room.claimedThisRound = [];
  room.claimWindowOpen = false;

  if (validWinners.length > 0) {
    endGame(room, validWinners, null);
  } else {
    // No valid winners — continue game
    scheduleNextCall(room);
  }
}

function endGame(room, winners, customMessage) {
  if (room.callTimer) clearTimeout(room.callTimer);
  if (room.countdownTimer) clearInterval(room.countdownTimer);
  if (room.claimWindowTimer) clearTimeout(room.claimWindowTimer);

  room.status = 'finished';
  room.claimWindowOpen = false;

  let winAmount = 0;
  let winnerNames = [];

  if (winners && winners.length > 0) {
    // Split prize equally among all simultaneous winners
    winAmount = Math.floor(room.pot / winners.length);
    winnerNames = winners.map(w => w.playerName);

    winners.forEach(w => {
      const cl = clients[w.playerId];
      if (cl) {
        cl.balance += winAmount;
        w.balance = cl.balance;
        send(w.ws, { type: 'balanceUpdate', balance: cl.balance });
      }
    });
  }

  const isSplit = winners && winners.length > 1;
  const message = customMessage ||
    (isSplit
      ? `🎉 Split win! ${winnerNames.join(' & ')} each win ${winAmount} ETB!`
      : `🏆 ${winnerNames[0]} wins ${winAmount} ETB!`);

  broadcast(room, {
    type: 'gameOver',
    winners: winnerNames,
    winAmount,
    isSplit,
    message,
    calledNumbers: room.calledNumbers
  });

  // After 6 seconds: reset room and send players back to CARD SELECTION (not lobby)
  setTimeout(() => {
    if (!rooms[room.roomId]) return;

    room.status = 'waiting';
    room.calledNumbers = [];
    room.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    room.pot = 0;
    room.takenCardIds = new Set();
    room.claimedThisRound = [];
    room.claimWindowOpen = false;

    room.players.forEach(p => {
      p.cardId = null;
      p.hasPaid = false;
      p.disqualified = false;
    });

    // Send players back to card selection screen with fresh pool
    room.players.forEach(p => {
      send(p.ws, {
        type: 'backToCardSelection',
        roomId: room.roomId,
        stakeId: room.stakeId,
        balance: clients[p.playerId] ? clients[p.playerId].balance : p.balance
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
    // Release card
    if (player.cardId) room.takenCardIds.delete(player.cardId);
    // Refund if game hasn't started
    if (player.hasPaid && (room.status === 'waiting' || room.status === 'countdown')) {
      client.balance += room.stake;
      send(client.ws, { type: 'balanceUpdate', balance: client.balance });
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
    playerName: `Player_${Math.floor(1000 + Math.random() * 9000)}`,
    telegramId: null,
    balance: 500,
    roomId: null,
    ws
  };
  clients[playerId] = client;

  const lobbyState = STAKES.map(s => {
    const r = Object.values(rooms).find(r => r.stakeId === s.id);
    return {
      stakeId: s.id, amount: s.amount, maxPlayers: s.maxPlayers,
      playerCount: r ? r.players.length : 0,
      status: r ? r.status : 'waiting',
      countdown: r && r.status === 'countdown' ? r.countdownLeft : 0
    };
  });

  send(ws, { type: 'connected', playerId, balance: client.balance, stakes: lobbyState });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {

        // ── Telegram registration ──
        case 'telegramRegister': {
          const { telegramId, name, phone } = msg;
          if (!telegramId) break;

          // Check if previously registered user
          const existing = registeredUsers[telegramId];
          if (existing) {
            client.playerName = existing.name;
            client.balance    = existing.balance;
            client.telegramId = telegramId;
            send(ws, { type: 'registered', playerName: existing.name, balance: existing.balance, isReturning: true });
          } else {
            client.playerName = name || `Player_${telegramId}`;
            client.telegramId = telegramId;
            registeredUsers[telegramId] = { name: client.playerName, balance: client.balance, phone };
            send(ws, { type: 'registered', playerName: client.playerName, balance: client.balance, isReturning: false });
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
            existingPlayer.ws = ws; // refresh WebSocket reference
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

        case 'setName': {
          if (msg.name && msg.name.trim()) {
            client.playerName = msg.name.trim().substring(0, 20);
            send(ws, { type: 'nameSet', playerName: client.playerName });
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
            playerName: client.playerName,
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

          if (room.players.length >= 2 && room.status === 'waiting') {
            startCountdown(room);
          }
          break;
        }

        case 'selectCard': {
          if (!client.roomId) break;
          const room = rooms[client.roomId];
          if (!room || (room.status !== 'waiting' && room.status !== 'countdown')) break;

          const cardId = parseInt(msg.cardId);
          if (cardId < 1 || cardId > TOTAL_CARDS) break;

          if (room.takenCardIds.has(cardId)) {
            return send(ws, { type: 'error', message: 'Card already taken!' });
          }

          const player = room.players.find(p => p.playerId === client.playerId);
          if (!player) break;

          // Release previous card if any
          if (player.cardId) room.takenCardIds.delete(player.cardId);

          // Deduct balance on first selection
          if (!player.hasPaid) {
            if (client.balance < room.stake) {
              return send(ws, { type: 'error', message: 'Insufficient balance.' });
            }
            client.balance -= room.stake;
            player.hasPaid = true;
            send(ws, { type: 'balanceUpdate', balance: client.balance });
          }

          player.cardId = cardId;
          room.takenCardIds.add(cardId);

          const card = getCardById(cardId);
          send(ws, {
            type: 'cardSelected',
            cardId,
            cardNumbers: card.numbers
          });

          broadcastCardPool(room);
          break;
        }

        case 'claimBingo': {
          if (!client.roomId) return;
          const room = rooms[client.roomId];
          if (!room || room.status !== 'playing') return;

          const player = room.players.find(p => p.playerId === client.playerId);
          if (!player || player.disqualified) return;

          // Must be within claim window
          if (!room.claimWindowOpen) {
            return send(ws, { type: 'claimTooLate', message: 'Too late! Next number already called.' });
          }

          // Record claim for this window — evaluated when window closes
          const alreadyClaimed = room.claimedThisRound.find(c => c.playerId === client.playerId);
          if (!alreadyClaimed) {
            room.claimedThisRound.push({
              playerId: client.playerId,
              markedIndices: msg.markedIndices || []
            });
          }

          // If server hasn't scheduled next call yet, evaluate immediately
          // (The claim window closes when next call fires, but we evaluate now)
          if (room.callTimer) clearTimeout(room.callTimer);
          evaluateClaims(room);
          break;
        }

        case 'leaveRoom':
          leaveRoom(client);
          send(ws, { type: 'leftRoom', balance: client.balance });
          break;

        case 'deposit':
          if (msg.amount && msg.amount >= 10) {
            client.balance += parseInt(msg.amount);
            send(ws, { type: 'balanceUpdate', balance: client.balance });
          }
          break;
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });

  ws.on('close', () => {
    // Don't immediately remove from room — allow reconnect window
    const c = clients[ws._playerId] || client;
    if (c && c.roomId) {
      const room = rooms[c.roomId];
      if (room && room.status === 'playing') {
        // Mark as disconnected but keep in game for reconnection
        const player = room.players.find(p => p.playerId === c.playerId);
        if (player) player.ws = null;
        return; // Don't delete client yet
      }
      leaveRoom(c);
    }
    delete clients[c.playerId];
    broadcastLobby();
  });

  ws.on('error', () => {});
});

// ─── REST API (for Telegram bot integration) ─────────────────
app.post('/api/register', (req, res) => {
  const { telegramId, name, phone } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
  if (registeredUsers[telegramId]) {
    return res.json({ existing: true, user: registeredUsers[telegramId] });
  }
  registeredUsers[telegramId] = { name, phone, balance: 500, createdAt: new Date() };
  res.json({ created: true, user: registeredUsers[telegramId] });
});

app.get('/api/user/:telegramId', (req, res) => {
  const user = registeredUsers[req.params.telegramId];
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

server.listen(PORT, () => {
  console.log(`\n🎱 Beteseb Bingo Server v3 running on http://localhost:${PORT}\n`);
  startTelegramBot();
});

// ─── TELEGRAM BOT (runs inside same process) ──────────────────
function startTelegramBot() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const GAME_URL  = process.env.GAME_URL || `https://beteseb-bingo.onrender.com`;

  if (!BOT_TOKEN) {
    console.log('ℹ️  No BOT_TOKEN set — Telegram bot not started.');
    return;
  }

  let TelegramBot;
  try {
    TelegramBot = require('node-telegram-bot-api');
  } catch (e) {
    console.log('ℹ️  node-telegram-bot-api not installed — bot skipped.');
    return;
  }

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  const pendingReg = {}; // telegramId -> { step, name }

  // /start
  bot.onText(/\/start/, async (msg) => {
    const tid  = msg.from.id;
    const name = msg.from.first_name || 'Player';
    const existing = registeredUsers[tid];

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

    pendingReg[tid] = { step: 'ask_name' };
    bot.sendMessage(msg.chat.id,
      `🎱 Welcome to *Beteseb Bingo!*\n\nWhat should we call you?`,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle text — name entry
  bot.on('message', (msg) => {
    const tid = msg.from.id;
    const pending = pendingReg[tid];
    if (!pending || !msg.text || msg.text.startsWith('/')) return;

    if (pending.step === 'ask_name') {
      pending.name = msg.text.trim().substring(0, 30);
      pending.step = 'ask_phone';
      bot.sendMessage(msg.chat.id,
        `Nice to meet you, *${pending.name}!* 👋\n\nPlease share your phone number:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [[{ text: '📱 Share Phone Number', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
    }
  });

  // Handle contact — phone shared
  bot.on('contact', (msg) => {
    const tid = msg.from.id;
    const pending = pendingReg[tid];
    if (!pending) return;

    const phone = msg.contact.phone_number;
    const name  = pending.name || msg.from.first_name || 'Player';

    registeredUsers[tid] = { name, phone, balance: 500, createdAt: new Date() };
    delete pendingReg[tid];

    bot.sendMessage(msg.chat.id,
      `✅ *Registered!*\n\nName: *${name}*\nPhone: ${phone}\nBalance: *500 ETB*\n\nTap below to play! 🎱`,
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
  });

  // /balance
  bot.onText(/\/balance/, (msg) => {
    const user = registeredUsers[msg.from.id];
    if (!user) return bot.sendMessage(msg.chat.id, 'Please /start to register first.');
    bot.sendMessage(msg.chat.id, `💰 Balance: *${user.balance} ETB*`, { parse_mode: 'Markdown' });
  });

  // /play
  bot.onText(/\/play/, (msg) => {
    const user = registeredUsers[msg.from.id];
    if (!user) return bot.sendMessage(msg.chat.id, 'Please /start to register first.');
    bot.sendMessage(msg.chat.id, `Ready to play? 🎱`, {
      reply_markup: { inline_keyboard: [[{
        text: '🎮 Open Game',
        web_app: { url: `${GAME_URL}?tid=${msg.from.id}` }
      }]]}
    });
  });

  console.log('🤖 Telegram bot started successfully!');
}
