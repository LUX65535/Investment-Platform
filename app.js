require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { subDays, format } = require('date-fns');
var path = require('path');
const cors = require('cors');

const app = express();
const port = 3000;
const api_key       = process.env.API_KEY;
const api_poly_key  = process.env.API_POLY_KEY;
const uri           = process.env.MONGO_URI;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'my-angular-app/dist/my-angular-app/browser')));


app.get('/company_quote', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'Missing stock symbol' });
  }

  try {
    const response = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${api_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company_quote' });
  }
});


app.get('/company_profile', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'Missing stock symbol' });
  }

  try {
    const response = await axios.get(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${api_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company_quote' });
  }});



app.get('/company_recommendation', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'Missing stock symbol' });
  }

  try {
    const response = await axios.get(`https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${api_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company_quote' });
  }});



app.get('/company_news', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'Missing stock symbol' });
  }
    const from_date_str = format(subDays(new Date(), 7), 'yyyy-MM-dd'); // Last 1 week
    const to_date_str = format(new Date(), 'yyyy-MM-dd');
  try {

    const response = await axios.get(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from_date_str}&to=${to_date_str}&token=${api_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company_quote' });
  }});



app.get('/company_sentiment', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'Missing stock symbol' });
  }
  try {
    const response = await axios.get(`https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${symbol}&from=2022-01-01&token=${api_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company_quote' });
  }});



app.get('/company_peers', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'Missing stock symbol' });
  }
  try {
    const response = await axios.get(`https://finnhub.io/api/v1/stock/peers?symbol=${symbol}&token=${api_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company_quote' });
  }});



app.get('/company_Earning', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'Missing stock symbol' });
  }
  try {
    const response = await axios.get(`https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${api_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company_quote' });
  }});



app.get('/Autocomplete_Search', async (req, res) => {
  const symbol = req.query.symbol;
  const response = await axios.get(`https://finnhub.io/api/v1/search?q=${symbol}&token=${api_key}`);
  res.json(response.data);
  });



app.get('/company_data', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ 'error': 'symbol' });
  }

  const from_date_str = format(subDays(new Date(), 720), 'yyyy-MM-dd');
  const to_date_str = format(new Date(), 'yyyy-MM-dd');

  try {
    const response = await axios.get(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from_date_str}/${to_date_str}?adjusted=true&sort=asc&apiKey=${api_poly_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company data' });
  }
});


app.get('/company_OneDay_data', async (req, res) => {
  const { symbol, from, to } = req.query;
  const isMarketOpen = req.query.isMarketOpen
  if (!symbol || !from || !to) {
    return res.status(400).json({ 'error': 'Missing symbol, from or to query parameters' });
  }

  try {
    const response = await axios.get(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/hour/${from}/${to}?adjusted=true&sort=asc&apiKey=${api_poly_key}`);
    res.json(response.data);
  } catch (error) {
    res.status(error.response.status).json({ 'error': 'company data' });
  }
});


//Database related
const { MongoClient, ServerApiVersion } = require('mongodb');
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
async function run() {
  try {
    await client.connect();
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (error) {
    console.error("Failed to connect to MongoDB", error);
  }
}
run().catch(console.dir);

app.post('/api/watchlist', async (req, res) => {
  let { ticker } = req.body;
  ticker = ticker.toUpperCase();
  try {
    const collection = client.db("Assignment3").collection("watchlist");
    const result = await collection.insertOne({ ticker });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/watchlist', async (req, res) => {
  try {
    const collection = client.db("Assignment3").collection("watchlist");
    const watchlist = await collection.find({}).toArray();
    res.status(200).json(watchlist);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching watchlist', error: error.message || error.toString() });
  }
});



app.get('/api/watchlist/check/:ticker', async (req, res) => {
  let { ticker } = req.params;
  ticker = ticker.toUpperCase();
  try {
    const collection = client.db("Assignment3").collection("watchlist");
    const item = await collection.findOne({ ticker });
    res.status(200).json(!!item);
  } catch (error) {
    res.status(500).json({ message: 'Error checking watchlist', error: error.message || error.toString() });
  }
});
app.delete('/api/watchlist/:ticker', async (req, res) => {
  let { ticker } = req.params;
  ticker = ticker.toUpperCase();
  try {
    const collection = client.db("Assignment3").collection("watchlist");
    await collection.deleteOne({ ticker });
    res.status(200).json({ message: 'Stock removed from watchlist' });
  } catch (error) {
    res.status(500).json({ message: 'Error removing stock from watchlist', error });
  }
});

app.post('/api/buy', async (req, res) => {
  const { ticker, quantity, buyPrice } = req.body;
  try {
    const portfolioCollection = client.db("Assignment3").collection("portfolio");
    const walletCollection = client.db("Assignment3").collection("wallet");

    const wallet = await walletCollection.findOne({});
    const currentBalance = wallet.balance;

    const cost = quantity * buyPrice;
    if (currentBalance >= cost) {
      await walletCollection.updateOne({}, { $inc: { balance: -cost } });
      await portfolioCollection.updateOne(
          { ticker },
          { $inc: { quantity, totalCost: cost } },
          { upsert: true }
      );

      res.status(200).json({ message: 'Stock purchased successfully' });
    } else {
      res.status(400).json({ message: 'Insufficient funds' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


app.post('/api/sell', async (req, res) => {
  const { ticker, quantity, sellPrice } = req.body;
  try {
    const portfolioCollection = client.db("Assignment3").collection("portfolio");
    const walletCollection = client.db("Assignment3").collection("wallet");

    const stock = await portfolioCollection.findOne({ticker});
    if(stock){
    if (stock.quantity >= quantity) {
      const revenue = quantity * sellPrice;

      await walletCollection.updateOne({}, {$inc: {balance: revenue}});
      if (stock.quantity === quantity) {
        await portfolioCollection.deleteOne({ticker});
      } else {
        await portfolioCollection.updateOne(
            {ticker},
            {$inc: {quantity: -quantity, totalCost: -(sellPrice * quantity)}}
        );
      }
      res.status(200).json({message: 'Stock sold successfully'});
    } else {
      res.status(400).json({message: 'Insufficient stock quantity'});
    }
  }else {
      res.status(600).json({message: 'No such stock exist'});
    }

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/stocks', async (req, res) => {
  try {
    const portfolioCollection = client.db("Assignment3").collection("portfolio");
    const stocks = await portfolioCollection.find({}).toArray();
    res.status(200).json(stocks);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stocks', error: error.message || error.toString() });
  }
});

app.get('/api/stocks/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();

  try {
    const portfolioCollection = client.db("Assignment3").collection("portfolio");
    const stock = await portfolioCollection.findOne({ ticker: ticker });

    if (stock) {
      res.status(200).json({
        ticker: ticker,
        quantity: stock.quantity,
        totalCost: stock.totalCost
      });
    } else {
      res.status(404).json({ message: `Ticker ${ticker} not found in portfolio.` });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stock', error: error.message || error.toString() });
  }
});

app.get('/api/balance', async (req, res) => {
  try {
    const walletCollection = client.db("Assignment3").collection("wallet");
    const wallet = await walletCollection.findOne({});
    res.status(200).json({ balance: wallet.balance });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching balance', error: error.message || error.toString() });
  }
});

app.post('/api/initWallet', async (req, res) => {
  try {
    const walletCollection = client.db("Assignment3").collection("wallet");
    const existingWallet = await walletCollection.findOne({});

    if (existingWallet) {
      await walletCollection.updateOne({}, { $set: { balance: 25000 } });
      res.status(200).json({ message: 'Wallet balance reset to $25,000' });
    } else {
      await walletCollection.insertOne({ balance: 25000 });
      res.status(200).json({ message: 'Wallet initialized with $25,000' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error initializing or resetting wallet', error: error.message || error.toString() });
  }
});



//

process.on('SIGINT', async () => {
  console.log('Closing MongoDB connection');
  await client.close();
  process.exit(0);
});

app.use((error, req, res, next) => {
  console.error('An error occurred:', error);
  res.status(500).json({ message: 'Internal Server Error' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'my-angular-app/dist/my-angular-app/browser/index.html'));
});

app.use(cors());
module.exports = app;