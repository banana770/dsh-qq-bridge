// util.js — logging, retry, small helpers. Zero dependencies, Node >= 22.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function makeLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  const emit = (lv, args) => {
    if (LEVELS[lv] < threshold) return;
    console[lv === "error" ? "error" : lv === "warn" ? "warn" : "log"](
      `[${ts()}] [${lv.toUpperCase()}]`,
      ...args,
    );
  };
  return {
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a single automatic retry (covers transient network failures).
 * Throws on final failure with a readable message.
 */
export async function fetchRetry(url, options = {}, retries = 2, timeoutMs = 15000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** LRU-ish Set that keeps at most `max` entries (insertion order eviction). */
export function makeRecentSet(max = 500) {
  const set = new Set();
  return {
    has: (v) => set.has(v),
    add(v) {
      if (set.has(v)) return;
      set.add(v);
      while (set.size > max) {
        const first = set.values().next().value;
        set.delete(first);
      }
    },
  };
}

/** Read a JSON file, returning null when missing or unparsable. */
export async function readJsonFile(path) {
  try {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Atomic-ish JSON write (write temp + rename). */
export async function writeJsonFile(path, value) {
  const fs = await import("node:fs/promises");
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, path);
}
