export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = "https://deriv-candle-bridge.onrender.com" + url.pathname + url.search;

    const response = await fetch(target);

    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      }
    });
  }
};
