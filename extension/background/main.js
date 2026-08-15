"use strict";

/* Message router: popup port, content port, on-demand injection, tab lifecycle. */

const popupPorts = new Set();
const contentPorts = new Map(); // tabId -> live "tts-content" port (all injected tabs)
let contentPort = null; // port of the tab currently being read
let contentTabId = null;
let starting = false; // guards against concurrent CMD_PLAY during inject/extract
let voicesPayload = null; // cached GET /voices result
let serverOk = false;
let healthLoaded = []; // model ids currently resident on the server

function pushState() {
  const msg = {
    type: "STATE",
    ...Player.snapshot(),
    serverOk,
    voices: voicesPayload,
  };
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {}
  }
}

async function refreshServerInfo() {
  const health = await ServerClient.health();
  serverOk = !!health;
  healthLoaded = health ? health.loaded : [];
  if (serverOk && !voicesPayload) {
    voicesPayload = await ServerClient.voices();
    if (voicesPayload) Player.applyDefaults(voicesPayload);
  }
  pushState();
}

Player.setHooks({
  onState: pushState,
  sendToContent(msg) {
    if (contentPort) {
      try {
        contentPort.postMessage(msg);
      } catch {}
    }
  },
});

async function ensureInjected(tabId) {
  const [already] = await browser.tabs.executeScript(tabId, {
    code: "!!window.__ttsInjected",
  });
  if (already) return;
  for (const file of [
    "/vendor/Readability-readerable.js",
    "/vendor/Readability.js",
    "/content/reader.js",
  ]) {
    await browser.tabs.executeScript(tabId, { file, runAt: "document_idle" });
  }
  await browser.tabs.insertCSS(tabId, { file: "/content/highlight.css" });
}

function waitForContentPort(tabId, timeoutMs = 4000) {
  const existing = contentPorts.get(tabId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.runtime.onConnect.removeListener(onConnect);
      reject(new Error("content script did not connect"));
    }, timeoutMs);
    function onConnect(port) {
      if (port.name === "tts-content" && port.sender.tab && port.sender.tab.id === tabId) {
        clearTimeout(timer);
        browser.runtime.onConnect.removeListener(onConnect);
        resolve(port);
      }
    }
    browser.runtime.onConnect.addListener(onConnect);
  });
}

function requestExtraction(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("extraction timed out"));
    }, timeoutMs);
    function onMsg(msg) {
      if (msg.type === "EXTRACT_RESULT") {
        cleanup();
        resolve(msg);
      }
    }
    function onDisc() {
      cleanup();
      reject(new Error("page went away during extraction"));
    }
    function cleanup() {
      clearTimeout(timer);
      port.onMessage.removeListener(onMsg);
      port.onDisconnect.removeListener(onDisc);
    }
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDisc);
    port.postMessage({ type: "EXTRACT_ARTICLE" });
  });
}

async function startReading(tabId) {
  if (starting) return;
  starting = true;
  try {
    await startReadingInner(tabId);
  } finally {
    starting = false;
  }
}

async function startReadingInner(tabId) {
  Player.stop();
  await refreshServerInfo();
  if (!serverOk) return; // popup renders the server-down panel from STATE
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab && tab.url && tab.url.startsWith("about:reader")) {
    pushError(
      "READER_VIEW",
      "Firefox blocks extensions in Reader View. Exit Reader View (the X in the page's left toolbar), then press play — this extension does its own article extraction."
    );
    return;
  }
  Player.markExtracting();
  try {
    const portPromise = waitForContentPort(tabId);
    portPromise.catch(() => {}); // avoid unhandled rejection if injection throws first
    await ensureInjected(tabId);
    const port = await portPromise;
    if (contentPort && contentPort !== port) {
      try {
        contentPort.postMessage({ type: "CLEAR_HIGHLIGHT" });
      } catch {}
    }
    contentPort = port;
    contentTabId = tabId;

    const result = await requestExtraction(port);
    if (!result.ok) {
      Player.stop();
      pushState();
      const codes = { "not-readerable": "NOT_READERABLE", empty: "NOT_READERABLE", "mapping-failed": "NOT_READERABLE" };
      pushError(codes[result.reason] || "NOT_READERABLE", "Couldn't find an article on this page.");
      return;
    }
    const settings = Player.getSettings();
    await Player.start({
      tabId,
      title: result.title,
      chunks: result.sentences,
      modelLoaded: healthLoaded.includes(settings.model),
    });
  } catch (e) {
    Player.stop();
    pushError("INJECT_FAILED", "Can't read this page (extension pages and PDFs are not supported).");
  }
}

let transientError = null;
function pushError(code, message) {
  transientError = { code, message };
  const msg = { type: "STATE", ...Player.snapshot(), serverOk, voices: voicesPayload, error: transientError };
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {}
  }
  transientError = null;
}

browser.runtime.onConnect.addListener(port => {
  if (port.name === "tts-popup") {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
    port.onMessage.addListener(async msg => {
      switch (msg.type) {
        case "CMD_PLAY":
          if (Player.snapshot().status === "paused" && msg.tabId === contentTabId) Player.resume();
          else startReading(msg.tabId);
          break;
        case "CMD_PAUSE":
          Player.pause();
          break;
        case "CMD_RESUME":
          Player.resume();
          break;
        case "CMD_STOP":
          Player.stop();
          break;
        case "CMD_SKIP":
          Player.skip(msg.delta);
          break;
        case "CMD_SET_SPEED":
          Player.setSpeed(msg.speed);
          break;
        case "CMD_SET_VOICE":
          Player.setVoice(msg.model, msg.voice);
          break;
        case "CMD_REFRESH_VOICES":
          voicesPayload = null;
          Player.retry(); // resumes in place after a SERVER_LOST
          refreshServerInfo();
          break;
      }
    });
    // First STATE reaches the popup once the health check resolves (≤1.5 s);
    // the popup shows "Checking TTS server…" until then.
    refreshServerInfo();
  } else if (port.name === "tts-content") {
    const tabId = port.sender.tab ? port.sender.tab.id : null;
    if (tabId != null) contentPorts.set(tabId, port);
    port.onDisconnect.addListener(() => {
      if (tabId != null && contentPorts.get(tabId) === port) contentPorts.delete(tabId);
      if (port === contentPort) {
        contentPort = null;
        contentTabId = null;
        Player.tabClosed(tabId);
      }
    });
  }
});

browser.tabs.onRemoved.addListener(tabId => Player.tabClosed(tabId));

(async () => {
  await Player.loadSettings();
  await refreshServerInfo();
})();
