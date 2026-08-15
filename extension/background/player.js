"use strict";

/* Playback engine. Lives in the MV2 persistent background page so audio keeps
   playing while the user browses other tabs.

   Chunks arrive from the content script as { i, text, kind, newBlock }:
   - i: sentence index (sub-chunks of an oversized sentence share one i, so
     highlighting and skipping operate on whole sentences)
   - kind: "heading" | "body" (drives inter-chunk pauses)
   - newBlock: true when the chunk starts a new block element (paragraph pause)
*/

const Player = (() => {
  const LRU_MAX = 20;
  const PREFETCH = 3;

  let ctx = null;
  let currentSource = null;
  let session = null; // { id, tabId, title, chunks, pos, totalSentences }
  let sessionSeq = 0;
  let playSeq = 0; // bumped by every playChunk/stop; stale invocations bail out
  let status = "idle"; // idle|extracting|loading_model|buffering|playing|paused|error
  let lastError = null; // { code, message } | null
  let userPaused = false;
  let settings = { model: "qwen3", voice: "", speed: 1.0 };

  // Wired by main.js.
  let hooks = { onState: () => {}, sendToContent: () => {} };

  const cache = new Map(); // key -> { buffer, appliedSpeed }, insertion order = LRU
  const inflight = new Map(); // key -> Promise<{ buffer, appliedSpeed }>

  function ensureCtx() {
    if (!ctx) ctx = new AudioContext();
    return ctx;
  }

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + "_" + s.length;
  }

  function chunkKey(c) {
    // Speed is deliberately NOT part of the key: play time compensates via
    // playbackRate = settings.speed / entry.appliedSpeed, so a buffer rendered
    // at another speed stays usable and a speed nudge doesn't trash the cache.
    return `${settings.model}|${settings.voice}|${hash(c.text)}`;
  }

  function setStatus(next, error = null) {
    status = next;
    lastError = error;
    hooks.onState();
  }

  function snapshot() {
    return {
      status,
      error: lastError,
      settings: { ...settings },
      tabId: session ? session.tabId : null,
      title: session ? session.title : null,
      index: session ? session.chunks[session.pos].i + 1 : 0,
      total: session ? session.totalSentences : 0,
      sentencePreview: session ? session.chunks[session.pos].text.slice(0, 140) : "",
    };
  }

  async function getAudio(c) {
    const key = chunkKey(c);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit); // refresh LRU position
      return hit;
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const { arrayBuffer, appliedSpeed } = await ServerClient.speak({
        text: c.text,
        model: settings.model,
        voice: settings.voice,
        speed: settings.speed,
      });
      const buffer = await ensureCtx().decodeAudioData(arrayBuffer);
      const entry = { buffer, appliedSpeed };
      cache.set(key, entry);
      while (cache.size > LRU_MAX) cache.delete(cache.keys().next().value);
      return entry;
    })();
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  }

  async function getAudioWithRetry(c) {
    try {
      return await getAudio(c);
    } catch (e) {
      if (e.code !== "SYNTH_FAILED") throw e;
      return await getAudio(c); // one retry for a flaky sentence
    }
  }

  function prefetch(from) {
    if (!session) return;
    for (let j = from; j < Math.min(from + PREFETCH, session.chunks.length); j++) {
      getAudio(session.chunks[j]).catch(() => {}); // errors retried at play time
    }
  }

  function stopCurrent() {
    if (currentSource) {
      currentSource.onended = null;
      try {
        currentSource.stop();
      } catch {}
      currentSource = null;
    }
  }

  function pauseBefore(c) {
    if (c.kind === "heading") return 0.35;
    if (c.newBlock) return 0.15;
    return 0.03;
  }

  async function playChunk(pos) {
    const mySession = session;
    const myPlay = ++playSeq;
    const isCurrent = () => session === mySession && playSeq === myPlay;
    mySession.pos = pos;
    const c = mySession.chunks[pos];
    if (status !== "loading_model") setStatus("buffering");

    let entry;
    try {
      entry = await getAudioWithRetry(c);
    } catch (e) {
      if (!isCurrent()) return;
      if (e.code === "SERVER_LOST") {
        // Keep the session and position so Retry can resume in place.
        stopCurrent();
        setStatus("error", { code: "SERVER_LOST", message: "TTS server stopped responding." });
        return;
      }
      // Persistent synthesis failure: skip this sentence, keep reading.
      if (pos + 1 < mySession.chunks.length) return playChunk(pos + 1);
      return stopSession();
    }
    if (!isCurrent()) return;

    const src = ensureCtx().createBufferSource();
    src.buffer = entry.buffer;
    src.playbackRate.value = settings.speed / entry.appliedSpeed;
    src.connect(ctx.destination);
    src.onended = () => {
      if (src !== currentSource) return;
      currentSource = null;
      if (session && session.pos + 1 < session.chunks.length) playChunk(session.pos + 1);
      else stopSession();
    };
    stopCurrent();
    currentSource = src;
    if (!userPaused && ctx.state === "suspended") ctx.resume();
    if (userPaused && ctx.state === "running") ctx.suspend(); // paused while buffering
    src.start(ctx.currentTime + pauseBefore(c));
    setStatus(userPaused ? "paused" : "playing");
    hooks.sendToContent({ type: "HIGHLIGHT", i: c.i });
    prefetch(pos + 1);
  }

  function firstChunkOf(sentenceIdx) {
    return session.chunks.findIndex(c => c.i === sentenceIdx);
  }

  function stopSession() {
    ++playSeq; // invalidate any playChunk still awaiting audio
    stopCurrent();
    if (session) hooks.sendToContent({ type: "CLEAR_HIGHLIGHT" });
    session = null;
    userPaused = false;
    if (ctx && ctx.state === "suspended") ctx.resume(); // leave ctx ready for next session
    setStatus("idle");
  }

  return {
    setHooks(h) {
      hooks = h;
    },
    snapshot,
    getSettings: () => ({ ...settings }),

    async loadSettings() {
      const stored = await browser.storage.local.get(["model", "voice", "speed"]);
      if (stored.model) settings.model = stored.model;
      if (stored.voice) settings.voice = stored.voice;
      if (stored.speed) settings.speed = stored.speed;
    },

    applyDefaults(voicesPayload) {
      // Fill unset voice from the server's default for the selected model.
      const m =
        voicesPayload.models.find(x => x.id === settings.model) ||
        voicesPayload.models.find(x => x.id === voicesPayload.default_model);
      if (m) {
        settings.model = m.id;
        if (!settings.voice || !m.voices.some(v => v.id === settings.voice)) {
          settings.voice = m.default_voice;
        }
      }
    },

    async start({ tabId, title, chunks, modelLoaded }) {
      stopSession();
      const totalSentences = chunks.length ? chunks[chunks.length - 1].i + 1 : 0;
      session = { id: ++sessionSeq, tabId, title, chunks, pos: 0, totalSentences };
      userPaused = false;
      if (!modelLoaded) {
        setStatus("loading_model");
        ServerClient.warmup(settings.model);
      }
      await playChunk(0);
    },

    markExtracting() {
      setStatus("extracting");
    },

    pause() {
      if (!session) return;
      userPaused = true;
      ensureCtx().suspend(); // create-if-missing so pause-while-buffering sticks
      setStatus("paused");
    },

    resume() {
      if (!session) return;
      userPaused = false;
      if (ctx) ctx.resume();
      setStatus("playing");
    },

    stop: stopSession,

    skip(delta) {
      if (!session) return;
      const { chunks, pos } = session;
      const curI = chunks[pos].i;
      let target;
      if (delta > 0) {
        target = chunks.findIndex((c, j) => j > pos && c.i !== curI);
        if (target < 0) return stopSession();
      } else {
        let prevI = -1;
        for (let j = pos - 1; j >= 0; j--)
          if (chunks[j].i !== curI) {
            prevI = chunks[j].i;
            break;
          }
        target = firstChunkOf(prevI < 0 ? curI : prevI);
      }
      stopCurrent();
      playChunk(target);
    },

    async setSpeed(speed) {
      settings.speed = Math.min(3, Math.max(0.5, speed));
      await browser.storage.local.set({ speed: settings.speed });
      if (session) {
        // Restart the current sentence so the new speed applies immediately
        // (usually a cache hit, since speed isn't part of the cache key).
        const target = firstChunkOf(session.chunks[session.pos].i);
        stopCurrent();
        playChunk(target);
      } else {
        hooks.onState();
      }
    },

    async setVoice(model, voice) {
      settings.model = model;
      settings.voice = voice;
      await browser.storage.local.set({ model, voice });
      ServerClient.warmup(model); // load while the current sentence finishes
      hooks.onState(); // takes effect from the next fetched sentence
    },

    retry() {
      if (session && lastError && lastError.code === "SERVER_LOST") {
        playChunk(session.pos);
        return true;
      }
      return false;
    },

    tabClosed(tabId) {
      if (session && session.tabId === tabId) {
        ++playSeq;
        session = null; // content port is already gone; no CLEAR_HIGHLIGHT possible
        stopCurrent();
        userPaused = false;
        setStatus("idle", { code: "PAGE_GONE", message: "Page was closed or navigated." });
      }
    },
  };
})();
