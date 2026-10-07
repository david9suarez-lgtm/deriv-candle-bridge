const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

const DERIV_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

// Mercados que vamos a analizar.
// Estos códigos fueron obtenidos directamente de Deriv.
const MARKETS = {
  "Boom 1000": "BOOM1000",
  "Boom 900": "BOOM900",
  "Boom 500": "BOOM500",
  "Crash 1000": "CRASH1000",
  "Crash 900": "CRASH900",
  "Crash 600": "CRASH600",
  "Crash 500": "CRASH500",
  "Volatility 75": "1HZ75V",
  "Volatility 100": "1HZ100V"
};

function derivRequest(payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);

    let finished = false;

    const timer = setTimeout(() => {
      finish(new Error("Deriv request timed out"));
    }, timeoutMs);

    function finish(error, response) {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      try {
        ws.close();
      } catch (_) {}

      if (error) {
        reject(error);
      } else {
        resolve(response);
      }
    }

    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        finish(err);
      }
    });

    ws.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());

        if (response.error) {
          finish(
            new Error(
              response.error.message ||
              JSON.stringify(response.error)
            )
          );
          return;
        }

        finish(null, response);
      } catch (err) {
        finish(err);
      }
    });

    ws.on("error", (err) => {
      finish(err);
    });
  });
}

function extractCandles(response) {
  if (Array.isArray(response.candles)) {
    return response.candles;
  }

  if (
    response.data &&
    Array.isArray(response.data.candles)
  ) {
    return response.data.candles;
  }

  return [];
}

async function getCandles(
  symbol,
  granularity,
  count = 200
) {
  const response = await derivRequest({
    ticks_history: symbol,
    adjust_start_time: 1,
    count: count,
    end: "latest",
    granularity: granularity,
    style: "candles"
  });

  const candles = extractCandles(response);

  return candles.map((candle) => ({
    epoch: Number(candle.epoch),
    time: new Date(
      Number(candle.epoch) * 1000
    ).toISOString(),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close)
  }));
}

// Página principal
app.get("/", (req, res) => {
  res.json({
    service: "Deriv Candle Bridge",
    status: "online",
    source: "Deriv public market data",
    authentication: "none",
    markets: Object.keys(MARKETS),
    endpoints: [
      "/symbols",
      "/candles"
    ]
  });
});

// Lista de mercados y códigos
app.get("/symbols", (req, res) => {
  const markets = Object.entries(MARKETS).map(
    ([name, symbol]) => ({
      name: name,
      symbol: symbol
    })
  );

  res.json({
    timestamp: new Date().toISOString(),
    count: markets.length,
    markets: markets
  });
});

// Velas H1 y M30
app.get("/candles", async (req, res) => {
  try {
    const output = {};

    for (const [name, symbol] of Object.entries(MARKETS)) {
      try {
        const [m30, h1] = await Promise.all([
          getCandles(symbol, 1800, 200),
          getCandles(symbol, 3600, 200)
        ]);

        output[name] = {
          status:
            m30.length > 0 && h1.length > 0
              ? "ok"
              : "no_candles",
          symbol: symbol,
          candle_count: {
            M30: m30.length,
            H1: h1.length
          },
          M30: m30,
          H1: h1
        };
      } catch (err) {
        output[name] = {
          status: "error",
          symbol: symbol,
          error: err.message
        };
      }
    }

    res.json({
      generated_at: new Date().toISOString(),
      source: "Deriv",
      candle_count_requested: 200,
     
