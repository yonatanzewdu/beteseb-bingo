/**
 * telegram-bot.js — Beteseb Bingo Telegram Bot
 * 
 * Install: npm install node-telegram-bot-api
 * Set env:  BOT_TOKEN=your_telegram_bot_token
 *           GAME_URL=https://your-render-app.onrender.com
 */

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAME_URL  = process.env.GAME_URL || 'https://your-app.onrender.com';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// State machine: pending registrations waiting for phone
const pendingPhone = {}; // telegramId -> { name, step }

// ─── /start command ──────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const telegramId = msg.from.id;
  const firstName  = msg.from.first_name || 'Player';

  // Check if already registered
  const existing = await db.getUserByTelegramId(telegramId);
  if (existing) {
    return bot.sendMessage(msg.chat.id,
      `Welcome back, *${existing.name}!* 🎱\nYour balance: *${existing.balance} ETB*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{
            text: '🎮 Play Beteseb Bingo',
            web_app: { url: `${GAME_URL}?tid=${telegramId}` }
          }]]
        }
      }
    );
  }

  // New user — start registration
  pendingPhone[telegramId] = { name: firstName, step: 'ask_name' };

  bot.sendMessage(msg.chat.id,
    `👋 Welcome to *Beteseb Bingo!*\n\nLet's get you registered.\nWhat should we call you?`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Handle text messages (registration flow) ─────────────────
bot.on('message', async (msg) => {
  const telegramId = msg.from.id;
  const text = msg.text;
  const pending = pendingPhone[telegramId];

  if (!pending) return;

  if (pending.step === 'ask_name' && text && !text.startsWith('/')) {
    pending.name = text.trim().substring(0, 30);
    pending.step = 'ask_phone';

    bot.sendMessage(msg.chat.id,
      `Nice to meet you, *${pending.name}!*\n\nPlease share your phone number so we can verify your account:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [[{
            text: '📱 Share My Phone Number',
            request_contact: true
          }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  }
});

// ─── Handle contact (phone number sharing) ───────────────────
bot.on('contact', async (msg) => {
  const telegramId = msg.from.id;
  const pending = pendingPhone[telegramId];

  if (!pending || pending.step !== 'ask_phone') return;

  const phone = msg.contact.phone_number;
  const name  = pending.name;

  try {
    const user = await db.registerUser(telegramId, name, phone);
    delete pendingPhone[telegramId];

    bot.sendMessage(msg.chat.id,
      `✅ *Registered successfully!*\n\nName: *${user.name}*\nPhone: ${phone}\nStarting balance: *${user.balance} ETB*\n\nYou're all set — tap below to play! 🎱`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{
            text: '🎮 Play Beteseb Bingo',
            web_app: { url: `${GAME_URL}?tid=${telegramId}` }
          }]],
          keyboard: [['🎮 Play', '💰 Balance', '📊 Leaderboard']],
          resize_keyboard: true
        }
      }
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id, '❌ Registration failed. Please try /start again.');
    console.error('Registration error:', err);
  }
});

// ─── /balance command ─────────────────────────────────────────
bot.onText(/\/balance|💰 Balance/, async (msg) => {
  const user = await db.getUserByTelegramId(msg.from.id);
  if (!user) return bot.sendMessage(msg.chat.id, 'Please /start to register first.');
  bot.sendMessage(msg.chat.id, `💰 Your balance: *${user.balance} ETB*`, { parse_mode:'Markdown' });
});

// ─── /leaderboard command ─────────────────────────────────────
bot.onText(/\/leaderboard|📊 Leaderboard/, async (msg) => {
  const rows = await db.getLeaderboard(10);
  const medals = ['🥇','🥈','🥉'];
  const text = rows.map((r,i) =>
    `${medals[i]||`${i+1}.`} *${r.name}* — ${r.total_winnings} ETB (${r.total_wins} wins)`
  ).join('\n');
  bot.sendMessage(msg.chat.id, `🏆 *Leaderboard*\n\n${text||'No games yet!'}`, { parse_mode:'Markdown' });
});

// ─── /play command ────────────────────────────────────────────
bot.onText(/\/play|🎮 Play/, async (msg) => {
  const user = await db.getUserByTelegramId(msg.from.id);
  if (!user) return bot.sendMessage(msg.chat.id, 'Please /start to register first.');

  bot.sendMessage(msg.chat.id,
    `Ready to play, *${user.name}*? 🎱\nBalance: *${user.balance} ETB*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{
          text: '🎮 Open Beteseb Bingo',
          web_app: { url: `${GAME_URL}?tid=${msg.from.id}` }
        }]]
      }
    }
  );
});

console.log('🤖 Beteseb Bingo Telegram Bot running...');
