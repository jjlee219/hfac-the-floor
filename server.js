const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
  gameDuration: 90,       // seconds
  lambda: 0.033,          // goals/sec per player (~2/min each — Head Soccer is high-scoring)
  baseHalfSpread: 0.03,   // 3 cents
  botSizeInside: 5,       // contracts at best bid/ask
  botSizeDepth: 3,        // contracts at deeper levels
  depthLevels: 3,         // number of price levels
  botRefreshMs: 1000,     // 1 second
  timerBroadcastMs: 100,  // 100ms for smooth countdown
  startingCash: 500,
  contractPayout: 100,
  playerAName: 'Player A',
  playerBName: 'Player B',
};

// ═══════════════════════════════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════════════════════════════
let game = resetGameState();

function resetGameState() {
  return {
    scoreA: 0,
    scoreB: 0,
    totalDuration: CONFIG.gameDuration,
    timeRemaining: CONFIG.gameDuration,
    status: 'waiting',  // waiting | pre-game | live | paused | settled
    playerAName: CONFIG.playerAName,
    playerBName: CONFIG.playerBName,
    events: [],          // { time, type, description }
    priceHistory: [],    // { time, mid, fairValue }
    startedAt: null,
    pausedAt: null,
    settledWinner: null,
  };
}

// ═══════════════════════════════════════════════════════════════
// TRADERS
// ═══════════════════════════════════════════════════════════════
const traders = {};  // socketId -> { id, name, cash, position, avgEntry, trades[], pnlHistory[] }
let traderIdCounter = 0;

function createTrader(socketId, name) {
  traderIdCounter++;
  traders[socketId] = {
    id: `trader_${traderIdCounter}`,
    name: name,
    cash: CONFIG.startingCash,
    position: 0,
    totalBought: 0,
    totalSold: 0,
    costBasis: 0,
    trades: [],
    pnlHistory: [],
  };
  return traders[socketId];
}

function getTraderPnL(trader) {
  const mid = bot.fairValue;
  const markValue = trader.position * mid * CONFIG.contractPayout;
  return trader.cash + markValue - CONFIG.startingCash;
}

// ═══════════════════════════════════════════════════════════════
// ORDER BOOK & MATCHING ENGINE
// ═══════════════════════════════════════════════════════════════
let orderIdCounter = 0;
let bids = [];  // sorted descending by price, then ascending by time
let asks = [];  // sorted ascending by price, then ascending by time
const allFills = []; // trade log

function clearBook() {
  bids = [];
  asks = [];
}

function cancelOrdersByOwner(ownerId) {
  bids = bids.filter(o => o.ownerId !== ownerId);
  asks = asks.filter(o => o.ownerId !== ownerId);
}

function insertOrder(order) {
  if (order.side === 'buy') {
    let i = 0;
    while (i < bids.length && (bids[i].price > order.price || (bids[i].price === order.price && bids[i].timestamp <= order.timestamp))) {
      i++;
    }
    bids.splice(i, 0, order);
  } else {
    let i = 0;
    while (i < asks.length && (asks[i].price < order.price || (asks[i].price === order.price && asks[i].timestamp <= order.timestamp))) {
      i++;
    }
    asks.splice(i, 0, order);
  }
}

function submitOrder(ownerId, ownerName, side, type, price, size) {
  if (game.status !== 'live' && game.status !== 'pre-game') return { fills: [], resting: null };

  const fills = [];
  let remaining = size;

  if (side === 'buy') {
    // Match against asks
    while (remaining > 0 && asks.length > 0) {
      const bestAsk = asks[0];
      if (type === 'limit' && price < bestAsk.price) break;

      const fillSize = Math.min(remaining, bestAsk.remaining);
      const fillPrice = bestAsk.price;

      fills.push({
        buyerId: ownerId,
        buyerName: ownerName,
        sellerId: bestAsk.ownerId,
        sellerName: bestAsk.ownerName,
        price: fillPrice,
        size: fillSize,
        timestamp: Date.now(),
        timeInGame: game.totalDuration - game.timeRemaining,
      });

      remaining -= fillSize;
      bestAsk.remaining -= fillSize;
      if (bestAsk.remaining <= 0) asks.shift();
    }

    // Rest remainder
    if (remaining > 0 && type === 'limit') {
      orderIdCounter++;
      const order = {
        id: orderIdCounter,
        ownerId, ownerName, side, price, size: remaining, remaining,
        timestamp: Date.now(),
      };
      insertOrder(order);
      return { fills, resting: order };
    }
  } else {
    // sell — match against bids
    while (remaining > 0 && bids.length > 0) {
      const bestBid = bids[0];
      if (type === 'limit' && price > bestBid.price) break;

      const fillSize = Math.min(remaining, bestBid.remaining);
      const fillPrice = bestBid.price;

      fills.push({
        buyerId: bestBid.ownerId,
        buyerName: bestBid.ownerName,
        sellerId: ownerId,
        sellerName: ownerName,
        price: fillPrice,
        size: fillSize,
        timestamp: Date.now(),
        timeInGame: game.totalDuration - game.timeRemaining,
      });

      remaining -= fillSize;
      bestBid.remaining -= fillSize;
      if (bestBid.remaining <= 0) bids.shift();
    }

    if (remaining > 0 && type === 'limit') {
      orderIdCounter++;
      const order = {
        id: orderIdCounter,
        ownerId, ownerName, side, price, size: remaining, remaining,
        timestamp: Date.now(),
      };
      insertOrder(order);
      return { fills, resting: order };
    }
  }

  return { fills, resting: null };
}

function processFills(fills) {
  for (const fill of fills) {
    allFills.push(fill);

    // Update buyer
    const buyer = Object.values(traders).find(t => t.id === fill.buyerId);
    if (buyer) {
      buyer.cash -= fill.price * CONFIG.contractPayout * fill.size;
      buyer.position += fill.size;
      buyer.totalBought += fill.size;
      buyer.costBasis += fill.price * CONFIG.contractPayout * fill.size;
      buyer.trades.push({ ...fill, side: 'buy' });
    }

    // Update seller
    const seller = Object.values(traders).find(t => t.id === fill.sellerId);
    if (seller) {
      seller.cash += fill.price * CONFIG.contractPayout * fill.size;
      seller.position -= fill.size;
      seller.totalSold += fill.size;
      seller.costBasis -= fill.price * CONFIG.contractPayout * fill.size;
      seller.trades.push({ ...fill, side: 'sell' });
    }

    // Bot bookkeeping
    if (fill.buyerId === 'bot') {
      bot.netPosition += fill.size;
    }
    if (fill.sellerId === 'bot') {
      bot.netPosition -= fill.size;
    }
  }
}

function getBookSnapshot() {
  // Aggregate by price level
  const bidLevels = {};
  const askLevels = {};

  for (const b of bids) {
    const p = b.price.toFixed(2);
    bidLevels[p] = (bidLevels[p] || 0) + b.remaining;
  }
  for (const a of asks) {
    const p = a.price.toFixed(2);
    askLevels[p] = (askLevels[p] || 0) + a.remaining;
  }

  return {
    bids: Object.entries(bidLevels).map(([p, s]) => ({ price: parseFloat(p), size: s })).sort((a, b) => b.price - a.price).slice(0, 8),
    asks: Object.entries(askLevels).map(([p, s]) => ({ price: parseFloat(p), size: s })).sort((a, b) => a.price - b.price).slice(0, 8),
    bestBid: bids.length > 0 ? bids[0].price : null,
    bestAsk: asks.length > 0 ? asks[0].price : null,
    mid: bids.length > 0 && asks.length > 0 ? (bids[0].price + asks[0].price) / 2 : bot.fairValue,
  };
}

// ═══════════════════════════════════════════════════════════════
// BOT PRICING ENGINE — Skellam Distribution
// ═══════════════════════════════════════════════════════════════

// Modified Bessel function of the first kind, order n, argument x
// Series: I_n(x) = sum_{m=0}^{inf} (x/2)^{2m+n} / (m! * (m+n)!)
function besselI(n, x) {
  if (x === 0) return n === 0 ? 1.0 : 0.0;
  const absN = Math.abs(n);
  let sum = 0;
  let term = 1;
  const halfX = x / 2;

  // First term: (x/2)^n / n!
  let firstTerm = 1;
  for (let i = 0; i < absN; i++) {
    firstTerm *= halfX / (i + 1);
  }
  // Oops, that's (x/2)^n / n! but we need careful computation.
  // Let's use log-space for stability.

  let logHalfX = Math.log(halfX);
  sum = 0;

  for (let m = 0; m < 60; m++) {
    // log of term: (2m + n) * log(x/2) - log(m!) - log((m+n)!)
    let logTerm = (2 * m + absN) * logHalfX - logFactorial(m) - logFactorial(m + absN);
    sum += Math.exp(logTerm);
  }

  return sum;
}

const _logFactCache = [0, 0];
function logFactorial(n) {
  if (n <= 1) return 0;
  if (_logFactCache[n] !== undefined) return _logFactCache[n];
  let result = 0;
  for (let i = 2; i <= n; i++) {
    result += Math.log(i);
  }
  _logFactCache[n] = result;
  return result;
}

function skellamPMF(k, mu) {
  // For equal-rate: P(K=k) = e^{-2μ} * I_{|k|}(2μ)
  if (mu <= 0) return k === 0 ? 1.0 : 0.0;
  const val = Math.exp(-2 * mu) * besselI(Math.abs(k), 2 * mu);
  return isNaN(val) ? 0 : val;
}

function computeFairValue(scoreA, scoreB, timeRemaining, lambda) {
  const d = scoreA - scoreB;
  const mu = lambda * timeRemaining;

  if (timeRemaining <= 0) {
    if (d > 0) return 1.0;
    if (d < 0) return 0.0;
    return 0.5;
  }

  if (mu < 0.001) {
    // Almost no time left — practically determined by current score
    if (d > 0) return 0.99;
    if (d < 0) return 0.01;
    return 0.50;
  }

  // P(A wins) = P(remaining diff > -d) = sum_{k > -d} skellamPMF(k, mu)
  let pAWins = 0;
  let pDraw = 0;

  const bound = Math.max(30, Math.abs(d) + 25);
  for (let k = -bound; k <= bound; k++) {
    const p = skellamPMF(k, mu);
    if (k > -d) pAWins += p;
    if (k === -d) pDraw = p;
  }

  // Split draw probability equally (no-draw rule)
  let fv = pAWins + 0.5 * pDraw;

  // Clamp to [0.01, 0.99]
  fv = Math.max(0.01, Math.min(0.99, fv));

  return fv;
}

// ═══════════════════════════════════════════════════════════════
// BOT MARKET MAKER
// ═══════════════════════════════════════════════════════════════
const bot = {
  fairValue: 0.50,
  netPosition: 0,
};

function botRefresh() {
  if (game.status !== 'live' && game.status !== 'pre-game') return;

  // Cancel all bot orders
  cancelOrdersByOwner('bot');

  // Recompute fair value
  bot.fairValue = computeFairValue(game.scoreA, game.scoreB, game.timeRemaining, CONFIG.lambda);

  const s = CONFIG.baseHalfSpread;
  const fv = bot.fairValue;

  // Post quotes at multiple levels
  for (let level = 0; level < CONFIG.depthLevels; level++) {
    const offset = level * 0.01;
    const size = level === 0 ? CONFIG.botSizeInside : CONFIG.botSizeDepth;

    const bidPrice = Math.max(0.01, Math.round((fv - s - offset) * 100) / 100);
    const askPrice = Math.min(0.99, Math.round((fv + s + offset) * 100) / 100);

    if (bidPrice > 0 && bidPrice < 1) {
      orderIdCounter++;
      insertOrder({
        id: orderIdCounter,
        ownerId: 'bot', ownerName: 'Market Maker',
        side: 'buy', price: bidPrice, size, remaining: size,
        timestamp: Date.now(),
      });
    }

    if (askPrice > 0 && askPrice < 1) {
      orderIdCounter++;
      insertOrder({
        id: orderIdCounter,
        ownerId: 'bot', ownerName: 'Market Maker',
        side: 'sell', price: askPrice, size, remaining: size,
        timestamp: Date.now(),
      });
    }
  }

  // Record price history
  const elapsed = game.totalDuration - game.timeRemaining;
  game.priceHistory.push({
    time: elapsed,
    fairValue: bot.fairValue,
    mid: getBookSnapshot().mid,
    scoreA: game.scoreA,
    scoreB: game.scoreB,
  });
}

// ═══════════════════════════════════════════════════════════════
// TIMER
// ═══════════════════════════════════════════════════════════════
let timerInterval = null;
let botInterval = null;

function startTimer() {
  if (timerInterval) return;

  game.startedAt = Date.now();
  game.status = 'live';

  // Main timer — ticks every 100ms for smooth countdown
  timerInterval = setInterval(() => {
    game.timeRemaining = Math.max(0, game.timeRemaining - 0.1);

    if (game.timeRemaining <= 0) {
      game.timeRemaining = 0;
      settleGame();
    }

    broadcastGameState();
  }, 100);

  // Bot refresh — every second
  botInterval = setInterval(() => {
    botRefresh();
    broadcastBook();
  }, CONFIG.botRefreshMs);

  // Initial bot refresh
  botRefresh();
  broadcastAll();
}

function pauseTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (botInterval) {
    clearInterval(botInterval);
    botInterval = null;
  }
  game.status = 'paused';
  broadcastAll();
}

function settleGame() {
  // Stop timers
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (botInterval) { clearInterval(botInterval); botInterval = null; }

  game.status = 'settled';

  // Determine winner
  const d = game.scoreA - game.scoreB;
  let settlementPrice;
  if (d > 0) {
    game.settledWinner = 'A';
    settlementPrice = 1.0;
  } else if (d < 0) {
    game.settledWinner = 'B';
    settlementPrice = 0.0;
  } else {
    game.settledWinner = 'draw';
    settlementPrice = 0.5;
  }

  // Settle all positions
  for (const trader of Object.values(traders)) {
    const settlementValue = trader.position * settlementPrice * CONFIG.contractPayout;
    trader.cash += settlementValue;
    trader.finalPnL = trader.cash - CONFIG.startingCash;
  }

  // Cancel all orders
  clearBook();

  // Add final price point
  game.priceHistory.push({
    time: game.totalDuration,
    fairValue: settlementPrice,
    mid: settlementPrice,
    scoreA: game.scoreA,
    scoreB: game.scoreB,
  });

  broadcastAll();
  broadcastSettlement();
}

// ═══════════════════════════════════════════════════════════════
// BROADCASTS
// ═══════════════════════════════════════════════════════════════

function broadcastGameState() {
  io.emit('gameState', {
    scoreA: game.scoreA,
    scoreB: game.scoreB,
    timeRemaining: Math.max(0, game.timeRemaining),
    totalDuration: game.totalDuration,
    status: game.status,
    playerAName: game.playerAName,
    playerBName: game.playerBName,
    fairValue: bot.fairValue,
    settledWinner: game.settledWinner,
    events: game.events,
  });
}

function broadcastBook() {
  io.emit('bookUpdate', getBookSnapshot());
}

function broadcastTraders() {
  // Send each trader their own data
  for (const [socketId, trader] of Object.entries(traders)) {
    const pnl = game.status === 'settled' ? trader.finalPnL : getTraderPnL(trader);
    io.to(socketId).emit('traderUpdate', {
      ...trader,
      pnl,
      markPrice: bot.fairValue,
    });
  }

  // Send leaderboard to everyone
  const leaderboard = Object.values(traders).map(t => ({
    name: t.name,
    pnl: game.status === 'settled' ? (t.finalPnL || 0) : getTraderPnL(t),
    position: t.position,
    trades: t.trades.length,
  })).sort((a, b) => b.pnl - a.pnl);

  io.emit('leaderboard', leaderboard);
}

function broadcastSettlement() {
  const leaderboard = Object.values(traders).map(t => ({
    name: t.name,
    pnl: t.finalPnL || 0,
    position: t.position,
    trades: t.trades.length,
  })).sort((a, b) => b.pnl - a.pnl);

  io.emit('settlement', {
    winner: game.settledWinner,
    leaderboard,
    priceHistory: game.priceHistory,
    events: game.events,
    allFills: allFills,
  });
}

function broadcastAll() {
  broadcastGameState();
  broadcastBook();
  broadcastTraders();
}

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO CONNECTIONS
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Send current state immediately
  socket.emit('gameState', {
    scoreA: game.scoreA,
    scoreB: game.scoreB,
    timeRemaining: game.timeRemaining,
    totalDuration: game.totalDuration,
    status: game.status,
    playerAName: game.playerAName,
    playerBName: game.playerBName,
    fairValue: bot.fairValue,
    settledWinner: game.settledWinner,
    events: game.events,
  });
  socket.emit('bookUpdate', getBookSnapshot());
  socket.emit('config', CONFIG);

  // ── TRADER EVENTS ──
  socket.on('joinTrader', (data) => {
    const trader = createTrader(socket.id, data.name);
    console.log(`Trader joined: ${data.name} (${trader.id})`);
    socket.emit('traderJoined', trader);
    broadcastTraders();
  });

  socket.on('submitOrder', (data) => {
    const trader = traders[socket.id];
    if (!trader) return;
    if (game.status !== 'live' && game.status !== 'pre-game') {
      socket.emit('orderError', { message: 'Market is not open' });
      return;
    }

    const { side, type, price, size } = data;

    // Validate: check if trader has enough cash for a buy
    if (side === 'buy') {
      const maxPrice = type === 'market' ? 0.99 : price;
      const cost = maxPrice * CONFIG.contractPayout * size;
      if (cost > trader.cash && trader.position <= 0) {
        socket.emit('orderError', { message: 'Insufficient cash' });
        return;
      }
    }

    const result = submitOrder(trader.id, trader.name, side, type, price || (side === 'buy' ? 0.99 : 0.01), size);
    processFills(result.fills);

    if (result.fills.length > 0) {
      // Broadcast fills
      for (const fill of result.fills) {
        io.emit('fill', fill);
      }
      broadcastBook();
      broadcastTraders();
    }
  });

  // ── OPERATOR EVENTS ──
  socket.on('operatorAction', (data) => {
    console.log(`Operator action: ${data.action}`);

    switch (data.action) {
      case 'configure':
        if (game.status === 'waiting') {
          if (data.duration) {
            CONFIG.gameDuration = data.duration;
            game.totalDuration = data.duration;
            game.timeRemaining = data.duration;
          }
          if (data.lambda) CONFIG.lambda = data.lambda;
          if (data.playerAName) { CONFIG.playerAName = data.playerAName; game.playerAName = data.playerAName; }
          if (data.playerBName) { CONFIG.playerBName = data.playerBName; game.playerBName = data.playerBName; }
          io.emit('config', CONFIG);
        }
        break;

      case 'preGame':
        if (game.status === 'waiting') {
          game.status = 'pre-game';
          botRefresh();
          broadcastAll();
        }
        break;

      case 'start':
        if (game.status === 'pre-game' || game.status === 'paused') {
          startTimer();
        } else if (game.status === 'waiting') {
          game.status = 'pre-game';
          botRefresh();
          broadcastAll();
          setTimeout(() => startTimer(), 500);
        }
        break;

      case 'pause':
        if (game.status === 'live') {
          pauseTimer();
        }
        break;

      case 'goalA':
        if (game.status === 'live') {
          game.scoreA++;
          const elapsed = game.totalDuration - game.timeRemaining;
          game.events.push({ time: elapsed, type: 'goal', player: 'A', description: `${game.playerAName} scores! (${game.scoreA}-${game.scoreB})` });
          console.log(`GOAL: ${game.playerAName}! Score: ${game.scoreA}-${game.scoreB}`);
          // Immediate bot reprice
          botRefresh();
          broadcastAll();
        }
        break;

      case 'goalB':
        if (game.status === 'live') {
          game.scoreB++;
          const elapsed2 = game.totalDuration - game.timeRemaining;
          game.events.push({ time: elapsed2, type: 'goal', player: 'B', description: `${game.playerBName} scores! (${game.scoreA}-${game.scoreB})` });
          console.log(`GOAL: ${game.playerBName}! Score: ${game.scoreA}-${game.scoreB}`);
          botRefresh();
          broadcastAll();
        }
        break;

      case 'undo':
        if (game.events.length > 0) {
          const last = game.events.pop();
          if (last.player === 'A') game.scoreA = Math.max(0, game.scoreA - 1);
          if (last.player === 'B') game.scoreB = Math.max(0, game.scoreB - 1);
          console.log(`UNDO: reverted. Score: ${game.scoreA}-${game.scoreB}`);
          botRefresh();
          broadcastAll();
        }
        break;

      case 'reset':
        // Full reset
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        if (botInterval) { clearInterval(botInterval); botInterval = null; }
        clearBook();
        allFills.length = 0;
        bot.fairValue = 0.50;
        bot.netPosition = 0;
        game = resetGameState();
        // Reset all traders
        for (const trader of Object.values(traders)) {
          trader.cash = CONFIG.startingCash;
          trader.position = 0;
          trader.totalBought = 0;
          trader.totalSold = 0;
          trader.costBasis = 0;
          trader.trades = [];
          trader.pnlHistory = [];
          trader.finalPnL = undefined;
        }
        broadcastAll();
        break;
    }
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    // Keep trader in memory so they can reconnect / for leaderboard
  });
});

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/operator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operator.html')));
app.get('/trade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'trader.html')));

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║         THE FLOOR — HFAC Quant           ║
║    Live Event Prediction Market Game     ║
╠══════════════════════════════════════════╣
║  Server running on port ${PORT}              ║
║                                          ║
║  Landing:   http://localhost:${PORT}          ║
║  Operator:  http://localhost:${PORT}/operator  ║
║  Trader:    http://localhost:${PORT}/trade     ║
╚══════════════════════════════════════════╝
  `);
});
