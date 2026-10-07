const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

// Deriv public WebSocket API.
// No login, password or trading token is used.
const DERIV_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

function derivRequest(payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);

    let finished = false;

    const finish = (error, response) => {
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
    };

    const timer = setTimeout(() => {
      finish(new Error("Deriv request timed out"));
    }, timeoutMs);

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

async function getActiveSymbols() {
  const response = await derivRequest({
    active_symbols: "brief"
  });

  // We keep this flexible while checking the exact
  // response structure of the new Deriv API.
  if (Array.isArray(response.active_symbols)) {
    return response.active_symbols;
  }

  if (
    response.data &&
    Array.isArray(response.data.active_symbols)
  ) {
    return response.data.active_symbols;
  }

  return [];
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

function getDisplayName(item) {
  return (
    item.display_name ||
    item.name ||
    item.symbol_display_name ||
    ""
  );
}

function getSymbolCode(item) {
  return (
    item.symbol ||
    item.symbol_code ||
    item.code ||
    null
  );
}

function findMarket(activeSymbols, wanted) {
  const target = normalize(wanted);

  let found = activeSymbols.find((item) => {
    return normalize(getDisplayName(item)) === target;
  });

  if (found) return found;

  found = activeSymbols.find((item) => {
    return normalize(getDisplayName(item)).includes(target);
  });

  if (found) return found;

  const words = wanted.toLowerCase().split(/\s+/);

  return activeSymbols.find((item) => {
    const name = getDisplayName(item).toLowerCase();

    return words.every((word) => name.includes(word));
  });
}

async function getCandles(symbol, granularity, count = 200) {
  const response = await derivRequest({
    ticks_history: symbol,
    adjust_start_time: 1,
    count: count,
    end: "latest",
    granularity: granularity,
    style: "candles"
  });

  let candles = [];

  if (Array.isArray(response.candles)) {
    candles = response.candles;
  } else if (
    response.data &&
    Array.isArray(response.data.candles)
  ) {
    candles = response.data.candles;
  }

  return candles.map((candle) => ({
    epoch: Number(candle.epoch),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close)
  }));
}

// HOME
app.get("/", (req, res) => {
  res.json({
    service: "Deriv Candle Bridge",
    status: "online",
    authentication: "public-market-data-only",
    endpoints: [
      "/debug-symbols",
      "/symbols",
      "/candles"
    ]
  });
});

// DEBUG
// Shows the raw response received from Deriv.
// Temporary endpoint for diagnosing symbol structure.
app.get("/debug-symbols", async (req, res) => {
  try {
    const response = await derivRequest({
      active_symbols: "brief"
    });

    res.json(response);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

// SYMBOL CHECK
app.get("/symbols", async (req, res) => {
  try {
    const symbols = await getActiveSymbols();

    const result = wantedMarkets.map((wanted) => {
      const market = findMarket(symbols, wanted);

      return {
        requested: wanted,
        found: Boolean(market),
        symbol: market ? getSymbolCode(market) : null,
        display_name: market
          ? getDisplayName(market)
          : null
      };
    });

    res.json({
      timestamp: new Date().toISOString(),
      symbols_received: symbols.length,
      markets: result
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

// CANDLES
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

      const symbol = getSymbolCode(market);

      if (!symbol) {
        output[wanted] = {
          status: "symbol_code_not_found",
          display_name: getDisplayName(market)
        };
        continue;
      }

      try {
        const [m30, h1] = await Promise.all([
          getCandles(symbol, 1800, 200),
          getCandles(symbol, 3600, 200)
        ]);

        output[wanted] = {
          status: "ok",
          symbol: symbol,
          display_name: getDisplayName(market),
          M30: m30,
          H1: h1
        };
      } catch (err) {
        output[wanted] = {
          status: "error",
          symbol: symbol,
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
    res.status(500).json({
      error: err.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Deriv Candle Bridge running on port ${PORT}`
  );
});
