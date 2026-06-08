# Beteseb Bingo — Multiplayer Server

Real-time multiplayer Bingo game with WebSocket server.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
open http://localhost:3000
```

For development with auto-restart:
```bash
npm run dev
```

## How Multiplayer Works

- Players open `http://localhost:3000` in their browser
- Each player enters a name and joins a stake room
- The server waits 15 seconds for players, then starts the game
- A number is called every 5 seconds (server-side, same for all players)
- First player to hit BINGO and click the button wins 90% of the pot
- The server verifies all BINGO claims — no cheating possible

## Architecture

```
server.js          — Express + WebSocket game server
public/index.html  — Frontend (served statically)
```

### WebSocket Messages (Client → Server)
| Type         | Payload                        | Description              |
|-------------|-------------------------------|--------------------------|
| setName     | { name }                      | Set player display name  |
| joinRoom    | { stakeId, cardCount }        | Join a stake room        |
| claimBingo  | { cardId }                    | Claim a BINGO win        |
| leaveRoom   | –                             | Leave current room       |
| deposit     | { amount }                    | Add virtual balance      |

### WebSocket Messages (Server → Client)
| Type             | Description                             |
|-----------------|-----------------------------------------|
| connected        | Initial connection + balance + lobby    |
| lobbyUpdate      | Live stake room status for all clients  |
| joinedRoom       | Room joined, cards assigned             |
| countdown        | Seconds remaining before game starts    |
| gameStart        | Game is beginning                       |
| numberCalled     | New number + full called list           |
| gameOver         | Winner + prize amount                   |
| balanceUpdate    | Updated balance                         |
| error            | Error message                           |

## Deploying to Production

### Railway (recommended, free tier)
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway new
railway up
```

### Render
1. Push to GitHub
2. Create a new Web Service on render.com
3. Build command: `npm install`
4. Start command: `npm start`

### VPS / Ubuntu
```bash
npm install -g pm2
pm2 start server.js --name beteseb-bingo
pm2 save
pm2 startup
```

## Telegram Mini App Integration

To run inside Telegram, wrap the frontend URL in a Telegram Bot:

```javascript
// In your Telegram bot
bot.command('play', (ctx) => {
  ctx.reply('Play Beteseb Bingo!', {
    reply_markup: {
      inline_keyboard: [[{
        text: '🎱 Play Now',
        web_app: { url: 'https://your-server.com' }
      }]]
    }
  });
});
```

## Game Config (server.js)

```javascript
const CALL_INTERVAL_MS = 5000;  // ms between number calls
const LOBBY_WAIT_MS    = 15000; // wait time before game starts
const MIN_PLAYERS      = 2;     // minimum players to start
```
