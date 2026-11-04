const express = require('express');
const { createHash, randomBytes } = require('node:crypto');

const cookieName = 'investment_paper_v1';
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const startingCashCents = 2_500_000;
const limits = { watchlist: 50, positions: 100, receipts: 500, writes: 2500 };
const maxMutationAttempts = 12;
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

function cookieToken(req) {
  const entry = req.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(cookieName + '='));
  const token = entry?.slice(cookieName.length + 1);
  return /^[\w-]{43}$/.test(token ?? '') ? token : null;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function openSandbox(req, res) {
  const token = cookieToken(req);
  if (!token) return null;
  return res.locals.paper.findOne({ _id: hashToken(token), expiresAt: { $gt: new Date() } });
}

function sessionRequired() {
  return {
    status: 428,
    body: { code: 'PAPER_SESSION_REQUIRED', message: 'Your paper session expired. Refresh to open a new session.' },
  };
}

function send(res, result) {
  return res.status(result.status ?? 200).json(result.body);
}

// The revision check makes the cash, positions and receipt one atomic write.
// A concurrent winner forces the loser to recalculate against the new balance.
async function mutate(req, res, decide, initial) {
  let sandbox = initial;
  for (let attempt = 0; attempt < maxMutationAttempts; attempt++) {
    sandbox ??= await openSandbox(req, res);
    if (!sandbox) return sessionRequired();
    const result = decide(sandbox);
    if (!result.patch) return result;
    if (sandbox.revision >= limits.writes) {
      return { status: 409, body: { message: 'This paper session has reached its update limit. Existing records remain available.' } };
    }
    const saved = await res.locals.paper.updateOne(
      { _id: sandbox._id, revision: sandbox.revision, expiresAt: { $gt: new Date() } },
      { $set: result.patch, $inc: { revision: 1 } }
    );
    if (saved.matchedCount === 1) return result;
    sandbox = null;
  }
  return { status: 503, body: { message: 'This paper session is busy. Please retry the same request.' } };
}

function orderValue(quote, quantity) {
  const unitPrice = quote?.c;
  if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  const gross = unitPrice * quantity;
  const totalCents = Math.round((gross + gross * Number.EPSILON) * 100);
  return Number.isSafeInteger(totalCents) && totalCents > 0 ? { unitPrice, totalCents } : null;
}

function dollars(cents) {
  return cents === null ? null : cents / 100;
}

function receiptBody(order) {
  return {
    orderId: order.orderId,
    side: order.side,
    ticker: order.ticker,
    quantity: order.quantity,
    status: order.status,
    submittedAt: order.submittedAt,
    price: order.unitPrice ?? dollars(order.priceCents ?? null),
    total: dollars(order.totalCents),
    balance: dollars(order.balanceCents),
    message: order.message,
  };
}

function receiptResponse(order, patch) {
  return {
    status: order.responseStatus,
    body: { message: order.message, receipt: receiptBody(order) },
    patch,
  };
}

function existingOrder(sandbox, intent) {
  const order = sandbox.receipts.find(item => item.orderId === intent.orderId);
  if (!order) return null;
  if (order.ticker !== intent.ticker || order.quantity !== intent.quantity || order.side !== intent.side) {
    return { status: 409, body: { message: 'This order ID is already used for a different order.' } };
  }
  return receiptResponse(order);
}

function proportionalCost(cost, remaining, originalQuantity) {
  const divisor = BigInt(originalQuantity);
  return Number((BigInt(cost) * BigInt(remaining) + divisor / 2n) / divisor);
}

function calculateFill(sandbox, intent, market) {
  if (sandbox.cashCents === null) return { status: 409, message: 'Initialize your paper wallet before placing an order.' };
  if (market.currency !== 'USD') return { status: 422, message: 'Paper trading is available only for USD quotes.' };
  const value = orderValue(market.quote, intent.quantity);
  if (!value) {
    return { status: 422, message: 'A valid trading quote is unavailable for this ticker.' };
  }

  const { unitPrice, totalCents } = value;
  const { side, ticker, quantity } = intent;
  const previous = sandbox.positions.find(position => position.ticker === ticker);
  const positions = sandbox.positions.filter(position => position.ticker !== ticker);
  if (side === 'buy') {
    if (sandbox.cashCents < totalCents) return { status: 400, message: 'Insufficient funds.' };
    if (!previous && positions.length >= limits.positions) {
      return { status: 409, message: 'This paper portfolio has reached its position limit.' };
    }
    const shares = (previous?.quantity ?? 0) + quantity;
    const costCents = (previous?.costCents ?? 0) + totalCents;
    if (!Number.isSafeInteger(shares) || !Number.isSafeInteger(costCents)) {
      return { status: 409, message: 'This order would exceed the paper portfolio limits.' };
    }
    positions.push({ ticker, quantity: shares, costCents });
    return {
      status: 200, message: 'Paper buy filled.', unitPrice, totalCents,
      positions, balanceCents: sandbox.cashCents - totalCents,
    };
  }

  if (!previous || previous.quantity < quantity) return { status: 400, message: 'Insufficient shares.' };
  const balanceCents = sandbox.cashCents + totalCents;
  if (!Number.isSafeInteger(balanceCents)) return { status: 409, message: 'This order would exceed the paper wallet limit.' };
  const remaining = previous.quantity - quantity;
  if (remaining) {
    positions.push({ ticker, quantity: remaining, costCents: proportionalCost(previous.costCents, remaining, previous.quantity) });
  }
  return { status: 200, message: 'Paper sell filled.', unitPrice, totalCents, positions, balanceCents };
}

function decideOrder(sandbox, intent, market) {
  const replay = existingOrder(sandbox, intent);
  if (replay) return replay;
  // Never remove earlier receipts to make space, as doing so would permit a replay.
  if (sandbox.receipts.length >= limits.receipts) {
    return { status: 409, body: { message: 'This paper session has reached its order limit. Existing receipts remain available.' } };
  }
  // An optimistic retry may observe a wallet initialized after the first read.
  if (!market && sandbox.cashCents !== null) {
    return { status: 503, body: { message: 'Paper wallet changed. Please retry the same order.' } };
  }
  const fill = calculateFill(sandbox, intent, market);
  const order = {
    ...intent,
    submittedAt: new Date(),
    status: fill.status === 200 ? 'filled' : 'rejected',
    responseStatus: fill.status,
    message: fill.message,
    unitPrice: fill.unitPrice ?? null,
    totalCents: fill.totalCents ?? null,
    balanceCents: fill.balanceCents ?? null,
  };
  const patch = { receipts: [...sandbox.receipts, order] };
  if (fill.positions) {
    patch.positions = fill.positions;
    patch.cashCents = fill.balanceCents;
  }
  return receiptResponse(order, patch);
}

function publicPosition({ ticker, quantity, costCents }) {
  return { ticker, quantity, totalCost: dollars(costCents) };
}

module.exports = function createPaperRouter({ normalizeTicker, getTradeMarket, sendMarketError, sendDatabaseError }) {
  const router = express.Router();
  let ttlIndex;

  const run = handler => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      return sendDatabaseError(res, error);
    }
  };
  const withSandbox = handler => run(async (req, res) => {
    const sandbox = await openSandbox(req, res);
    if (!sandbox) return send(res, sessionRequired());
    return handler(req, res, sandbox);
  });
  const parseTicker = (res, value) => {
    const ticker = normalizeTicker(value);
    if (!ticker) res.status(400).json({ message: 'Enter a valid stock symbol.' });
    return ticker;
  };

  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      return res.status(403).json({ message: 'Open the paper workspace from its own website.' });
    }
    res.locals.paper = res.locals.db.collection('paper_sandboxes');
    return next();
  });

  router.get('/paper/session', run(async (req, res) => {
    const existing = await openSandbox(req, res);
    if (existing) return res.json({ expiresAt: existing.expiresAt });

    ttlIndex ??= res.locals.paper.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(error => {
      ttlIndex = undefined;
      throw error;
    });
    await ttlIndex;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetime);
    await res.locals.paper.insertOne({
      _id: hashToken(token), expiresAt, revision: 0, cashCents: null,
      watchlist: [], positions: [], receipts: [],
    });
    res.cookie(cookieName, token, {
      httpOnly: true, sameSite: 'strict', secure: req.secure || process.env.VERCEL === '1',
      path: '/api', expires: expiresAt,
    });
    return res.json({ expiresAt });
  }));

  router.get('/watchlist', withSandbox((_req, res, sandbox) => res.json(sandbox.watchlist.map(ticker => ({ ticker })))));
  router.get('/watchlist/check/:ticker', withSandbox((req, res, sandbox) => {
    const ticker = parseTicker(res, req.params.ticker);
    if (ticker) res.json(sandbox.watchlist.includes(ticker));
  }));
  router.post('/watchlist', withSandbox(async (req, res, initial) => {
    const ticker = parseTicker(res, req.body?.ticker);
    if (!ticker) return;
    return send(res, await mutate(req, res, sandbox => {
      if (sandbox.watchlist.includes(ticker)) return { body: { acknowledged: true, insertedId: null } };
      if (sandbox.watchlist.length >= limits.watchlist) {
        return { status: 409, body: { message: 'The watchlist is full. Remove a symbol before adding another.' } };
      }
      return { body: { acknowledged: true, insertedId: ticker }, patch: { watchlist: [...sandbox.watchlist, ticker] } };
    }, initial));
  }));
  router.delete('/watchlist/:ticker', withSandbox(async (req, res, initial) => {
    const ticker = parseTicker(res, req.params.ticker);
    if (!ticker) return;
    return send(res, await mutate(req, res, sandbox => {
      const body = { message: 'Stock removed from watchlist' };
      if (!sandbox.watchlist.includes(ticker)) return { body };
      return { body, patch: { watchlist: sandbox.watchlist.filter(item => item !== ticker) } };
    }, initial));
  }));

  router.get('/stocks', withSandbox((_req, res, sandbox) => res.json(sandbox.positions.map(publicPosition))));
  router.get('/stocks/:ticker', withSandbox((req, res, sandbox) => {
    const ticker = parseTicker(res, req.params.ticker);
    if (!ticker) return;
    const position = sandbox.positions.find(item => item.ticker === ticker);
    return position ? res.json(publicPosition(position)) : res.status(404).json({ message: 'Position not found.' });
  }));
  router.get('/balance', withSandbox((_req, res, sandbox) => res.json({
    balance: dollars(sandbox.cashCents ?? 0), initialized: sandbox.cashCents !== null,
  })));
  router.post('/initWallet', withSandbox(async (req, res, initial) => send(res, await mutate(req, res, sandbox => {
    if (sandbox.cashCents !== null) return { body: { message: 'Paper wallet is already initialized.' } };
    return { body: { message: 'Paper wallet initialized with $25,000.' }, patch: { cashCents: startingCashCents } };
  }, initial))));

  for (const side of ['buy', 'sell']) {
    router.post('/' + side, withSandbox(async (req, res, initial) => {
      const ticker = parseTicker(res, req.body?.ticker);
      if (!ticker) return;
      const { quantity, orderId } = req.body;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || typeof orderId !== 'string' || !uuidPattern.test(orderId)) {
        return res.status(400).json({ message: 'Enter a positive whole number of shares and a valid order ID.' });
      }
      const intent = { side, ticker, quantity, orderId: orderId.toLowerCase() };
      const replay = existingOrder(initial, intent);
      if (replay) return send(res, replay);

      let market;
      if (initial.cashCents !== null && initial.receipts.length < limits.receipts) {
        try {
          market = await getTradeMarket(ticker);
        } catch (error) {
          const current = await openSandbox(req, res);
          const concurrentReplay = current && existingOrder(current, intent);
          if (concurrentReplay) return send(res, concurrentReplay);
          return sendMarketError(res, error, 'message');
        }
      }
      return send(res, await mutate(req, res, sandbox => decideOrder(sandbox, intent, market), initial));
    }));
  }

  router.get('/orders', withSandbox((_req, res, sandbox) => res.json(sandbox.receipts.slice().reverse().map(receiptBody))));
  router.get('/orders/:orderId', withSandbox((req, res, sandbox) => {
    const order = sandbox.receipts.find(item => item.orderId === req.params.orderId.toLowerCase());
    return order ? res.json(receiptBody(order)) : res.status(404).json({ message: 'Order receipt not found.' });
  }));

  return router;
};
