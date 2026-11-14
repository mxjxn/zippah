// WebSocket client for Generant's remote (127.0.0.1:57143).
// Commands share Generant's /generant/v1 parser; state queries return the
// live studio snapshot (devices, params, patterns, banks, transport).
export function createGenerant({ url = "ws://127.0.0.1:57143" } = {}) {
  let socket = null;
  let seq = 0;
  const pending = new Map();
  let snapshot = { connected: false, bpm: null, playing: false, devices: [], patterns: [], banks: { defs: [], lanes: [] } };

  const status = () => (socket?.readyState === 1 ? "connected" : "disconnected");

  function send(msg) {
    return new Promise((res, rej) => {
      if (socket?.readyState !== 1) return rej(new Error("Not connected to Generant — run (generant/connect)."));
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.get(id).rej(new Error("Generant timed out."));
          pending.delete(id);
        }
      }, 3000);
      pending.set(id, { res, rej, timer });
      socket.send(JSON.stringify({ ...msg, id }));
    });
  }

  function connect() {
    socket?.close();
    socket = new WebSocket(url);
    socket.addEventListener("message", ({ data }) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.ok) res(msg.result ?? msg);
        else rej(new Error(msg.error ?? "Generant error."));
      }
    });
    return new Promise((res, rej) => {
      socket.addEventListener("open", () => res(status()), { once: true });
      socket.addEventListener("error", () => rej(new Error(`No Generant WS remote at ${url}.`)), { once: true });
    });
  }

  const command = (address, args = []) => send({ address, args });

  async function refresh() {
    const result = await send({ query: "state" });
    snapshot = { ...result, connected: true };
    return snapshot;
  }

  const sanitize = (name) =>
    String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "device";

  function makePlayer(dev) {
    const player = (pitch, velocity = 0.8) => command("/generant/v1/device/note", [dev.id, pitch, velocity]);
    player.device = dev;
    player.sanitized = sanitize(dev.name);
    // ReBirth-style bank swap: pattern by bank pattern id or name, transpose in semitones.
    player.pattern = (pattern, transpose = 0) => command("/generant/v1/bank/lane", [dev.id, pattern, transpose]);
    player.param = (param, value) => command("/generant/v1/device/param", [dev.id, param, value]);
    return player;
  }

  function player(name) {
    const dev = snapshot.devices.find((d) => d.id === name || d.name === name);
    if (!dev) throw new Error(`No live Generant device "${name}" — (generant/refresh) then retry.`);
    return makePlayer(dev);
  }

  function players() {
    return Object.fromEntries(snapshot.devices.map((d) => [sanitize(d.name), makePlayer(d)]));
  }

  return { connect, command, refresh, status, url, sanitize, player, players, makePlayer, snapshot: () => snapshot };
}
