const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

// Deriv public WebSocket API.
// No account login or trading token is used.
const DERIV_WS = "wss://api.derivws.com/trading/v1/options/ws/public";

function derivRequest(payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error("Deriv request timed out"));
    }, timeoutMs);

    ws.on("open", () => ws.send(JSON.stringify(payload)));

    ws.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());

        if (response.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(response.error.message));
          return;
        }

        clearTimeout(timer);
        ws.close();
        resolve(response);
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function getActiveSymbols() {
  const response = await derivRequest({
    active_symbols: "brief",
    product_type: "basic"
  });

  return response.active_symbols || [];
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const wantedMarkets = [
  "Boom 1000",
  "Boom 900",
  "Boom 500",
  "Crash 1000",
  "Crash 900",
  "Crash 600",
  "Crash 500",
  "Volatility 75",
  "Volatility 100"
];

function findMarket(activeSymbols, wanted) {
  const target = normalize(wanted);

  let found = activeSymbols.find((s) =>
    normalize(s.display_name) === target
  );

  if (found) return found;

  found = activeSymbols.find((s) =>
    normalize(s.display_name).includes(target)
  );

  if (found) return found;

  // Fallback matching for names such as
  // "Volatility 75 Index" or "Boom 1000 Index".
  const words = wanted.toLowerCase().split(/\s+/);

  return activeSymbols.find((s) => {
    const name = String(s.display_name || "").toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

async function getCandles(symbol, granularity, count = 200) {
  const response = await derivRequest({
    ticks_history: symbol,
    adjust_start_time: 1,
    count,
    end: "latest",
    granularity,
    style: "candles"
  });

  return (response.candles || []).map((c) => ({
    epoch: Number(c.epoch),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));
}

app.get("/", (req, res) => {
  res.json({
    service: "Deriv Candle Bridge",
    status: "online",
    authentication: "public-market-data-only",
    endpoints: ["/symbols", "/candles"]
  });
});

app.get("/symbols", async (req, res) => {
  try {
    const symbols = await getActiveSymbols();

    const result = wantedMarkets.map((wanted) => {
      const market = findMarket(symbols, wanted);

      return {
        requested: wanted,
        found: Boolean(market),
        symbol: market?.symbol || null,
        display_name: market?.display_name || null
      };
    });

    res.json({
      timestamp: new Date().toISOString(),
      markets: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/candles", async (req, res) => {
  try {
    const symbols = await getActiveSymbols();
    const output = {};

    for (const wanted of wantedMarkets) {
      const market = findMarket(symbols, wanted);

      if (!market) {
        output[wanted] = {
          status: "symbol_not_found"
        };
        continue;
      }

      try {
        const [m30, h1] = await Promise.all([
          getCandles(market.symbol, 1800, 200),
          getCandles(market.symbol, 3600, 200)
        ]);

        output[wanted] = {
                 status: "ok",
        symbol: market.symbol,
        display_name: market.display_name,
        M30: m30,
        H1: h1
      };
    } catch (err) {
      output[wanted] = {
        status: "error",
        symbol: market.symbol,
        error: err.message
      };
    }
  }

  res.json({
    generated_at: new Date().toISOString(),
    candle_count_requested: 200,
    timeframes: {
      M30: 1800,
      H1: 3600
    },
    markets: output
  });
} catch (err) {
  res.status(500).json({ error: err.message });
}
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Deriv Candle Bridge running on port ${PORT}`);
});
