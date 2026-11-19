// Loaded into every helper with NODE_OPTIONS=--import. Keeps a helper from reaching any service outside this machine: the
// plan-usage endpoint answers with a fixed low reading, and any other non-loopback URL fails.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return real(input, init);
  if (url.href.startsWith("https://api.anthropic.com/api/oauth/usage")) {
    const reset = (h) => new Date(Date.now() + h * 3600_000).toISOString();
    return Response.json({ five_hour: { utilization: 5, resets_at: reset(3) }, seven_day: { utilization: 10, resets_at: reset(100) } });
  }
  throw new TypeError(`rig: outbound request to ${url.origin} blocked`);
};
