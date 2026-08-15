"use strict";

/* Thin fetch wrappers around the local TTS server. Runs in the background
   page, which holds the http://127.0.0.1/* host permission. */

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";

const ServerClient = {
  async baseUrl() {
    const { serverUrl } = await browser.storage.local.get("serverUrl");
    return (serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, "");
  },

  async _getJson(path, timeoutMs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch((await this.baseUrl()) + path, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  },

  health(timeoutMs = 1500) {
    return this._getJson("/health", timeoutMs);
  },

  voices(timeoutMs = 3000) {
    return this._getJson("/voices", timeoutMs);
  },

  async warmup(model) {
    try {
      await fetch((await this.baseUrl()) + "/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
    } catch {
      /* best effort */
    }
  },

  /* Resolves to { arrayBuffer, appliedSpeed }. Throws Error with .code:
     "SERVER_LOST" (network) or "SYNTH_FAILED" (HTTP error). */
  async speak({ text, model, voice, speed }) {
    let res;
    try {
      res = await fetch((await this.baseUrl()) + "/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model, voice, speed }),
      });
    } catch (e) {
      const err = new Error("TTS server unreachable");
      err.code = "SERVER_LOST";
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`synthesis failed (HTTP ${res.status})`);
      err.code = "SYNTH_FAILED";
      err.status = res.status;
      throw err;
    }
    const appliedSpeed = parseFloat(res.headers.get("X-Applied-Speed") || "1") || 1;
    return { arrayBuffer: await res.arrayBuffer(), appliedSpeed };
  },
};
