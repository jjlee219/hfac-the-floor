# THE FLOOR — Live Event Prediction Market Game

**HFAC Quant Education Session**

A simulated prediction market exchange where participants trade contracts on the outcome of a live Head Soccer match. Bot market makers provide continuous liquidity using a Poisson/Skellam fair value model, and human traders try to profit by reading the game better than the bots.

---

## Quick Start

```bash
npm install
npm start
```

The server starts on port 3000. Three URLs:

| URL | Who | Purpose |
|-----|-----|---------|
| `http://localhost:3000` | Everyone | Landing page with role selection |
| `http://localhost:3000/operator` | The designated operator | Broadcast desk: score entry, timer control |
| `http://localhost:3000/trade` | All participants | Trading interface |

### For Remote Participants (same WiFi)
Find your local IP (`ifconfig` or `ipconfig`) and share it:
```
http://192.168.x.x:3000/trade
```

### For fully remote participants
Use ngrok:
```bash
npx ngrok http 3000
```

---

## How to Play

### Setup (before the game)
1. Open the **Operator Console** at `/operator` on one screen
2. Enter the player names and game duration (default: 90 seconds)
3. Click **Apply Config**
4. Have all traders open `/trade` on their phones/laptops and enter their names

### During the Game
1. Two people start a Head Soccer match on a separate screen
2. The operator presses **[Space]** to start the countdown timer simultaneously
3. Whenever a goal is scored, the operator presses **[A]** or **[B]**
4. The bot instantly reprices — traders see the probability jump on their screens
5. Traders buy/sell contracts using the big buttons (or keyboard shortcuts)
6. When the timer hits 0:00, the market settles automatically

### Operator Hotkeys

| Key | Action |
|-----|--------|
| `A` | Player A scored a goal |
| `B` | Player B scored a goal |
| `Space` | Start / resume timer |
| `P` | Pause timer |
| `Z` | Undo last goal (mistake correction) |
| `R` | Reset entire game |

### Trader Hotkeys

| Key | Action |
|-----|--------|
| `↑` or `W` | Buy (A wins) |
| `↓` or `S` | Sell (B wins) |
| `1/2/3/5` | Set quantity |

---

## How the Bot Works

The bot computes a **fair value** (implied win probability) using the **Skellam distribution** — the standard model used by sportsbooks for soccer/hockey in-play pricing.

**Key idea:** Both players score goals as independent Poisson processes with rate λ. The difference in remaining goals follows a Skellam distribution. Given the current score differential and time remaining, we can compute the exact probability that Player A ends up ahead.

### Fair Value Formula
```
μ = λ × time_remaining
P(A wins) = Σ_{k > -d} e^{-2μ} × I_{|k|}(2μ)
```
Where `d = score_A - score_B` and `I_n` is the modified Bessel function of the first kind.

### Example Fair Values (λ = 0.033)
| Score | Time Left | Fair Value (A wins) |
|-------|-----------|-------------------|
| 0-0 | 90s | 50% |
| 1-0 | 60s | 69% |
| 0-1 | 60s | 31% |
| 2-0 | 30s | 92% |
| 2-1 | 10s | 88% |

The bot quotes a **two-sided market** (bid and ask) with a 3-cent spread around the fair value, at multiple depth levels.

---

## Configuration

Edit the `CONFIG` object in `server.js`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `gameDuration` | 90s | Match length |
| `lambda` | 0.033 | Goals/sec per player (~2/min each) |
| `baseHalfSpread` | 0.03 | Bot's half-spread (3¢ = 3 percentage points) |
| `botSizeInside` | 5 | Contracts at best bid/ask |
| `depthLevels` | 3 | Number of price levels the bot quotes |
| `startingCash` | $500 | Each trader's starting bankroll |
| `contractPayout` | $100 | Payout per winning contract |

### Tuning λ (Lambda)
Head Soccer is a fast, high-scoring game. Suggested approach:
1. Play 2–3 practice games and count total goals scored per game
2. λ = (total goals by one player) / (game duration in seconds)
3. Example: if each player scores ~3 goals in 90 seconds → λ = 3/90 ≈ 0.033

---

## Architecture

```
Server (Node.js + Socket.IO)
├── Game State Manager (score, timer, events)
├── Matching Engine (limit order book, price-time priority)
├── Bot Pricing Engine (Skellam distribution)
├── Bot Market Maker (two-sided quotes, multi-level depth)
└── WebSocket Hub → broadcasts to all clients

Clients
├── Operator Console (hotkey-driven broadcast desk)
└── Trader Interface (order book, buy/sell buttons, price chart, leaderboard)
```

---

## Teaching Points

After each game, discuss:
1. **How did the price move?** Show the price chart with goal events overlaid
2. **Did anyone beat the bot?** Look at the leaderboard — who traded profitably?
3. **What edge did humans have?** Could you see a goal coming before the operator pressed the key?
4. **Was the bot well-calibrated?** Were events it priced at 70% happening ~70% of the time?
5. **This is Polymarket.** The price chart you just watched looks exactly like an election night on Polymarket — same mechanics, longer time horizon

---

## Running Multiple Games

The operator can press **[R]** to reset and start a new game. Trader accounts persist across games (cash resets). For a proper tournament:
- Run best-of-3 or best-of-5
- Track aggregate PnL across all games
- Award a prize to the top trader

---

*Built for HFAC Quant education sessions.*
