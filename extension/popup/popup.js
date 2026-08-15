"use strict";

/* Pure renderer of STATE snapshots pushed by the background page. */

const $ = id => document.getElementById(id);
const port = browser.runtime.connect({ name: "tts-popup" });

let state = null;
let activeTabId = null;

browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  activeTabId = tab ? tab.id : null;
});

port.onMessage.addListener(msg => {
  if (msg.type === "STATE") {
    state = msg;
    render();
  }
});

const STATUS_TEXT = {
  idle: "Ready",
  extracting: "Finding article…",
  loading_model: "Loading model (first use may download weights)…",
  buffering: "Buffering…",
  playing: "Playing",
  paused: "Paused",
  error: "Error",
};

function render() {
  const s = state;
  $("connecting").hidden = true;
  $("server-down").hidden = s.serverOk;
  $("main").hidden = !s.serverOk;
  if (!s.serverOk) return;

  const busy = s.status === "playing" || s.status === "buffering" || s.status === "loading_model";
  $("playpause").textContent = busy ? "⏸" : "▶";
  $("title").textContent = s.title || "";
  $("preview").textContent = s.sentencePreview || "";
  $("status").textContent =
    (STATUS_TEXT[s.status] || s.status) + (s.total ? ` — sentence ${s.index} of ${s.total}` : "");

  for (const id of ["back", "fwd", "stop"]) $(id).disabled = !s.total;

  if (document.activeElement !== $("speed")) $("speed").value = s.settings.speed;
  $("speedval").textContent = Number(s.settings.speed).toFixed(2) + "x";

  renderVoices(s);

  $("error").hidden = !s.error;
  if (s.error) $("error").textContent = s.error.message || s.error.code;
}

function renderVoices(s) {
  const sel = $("voice");
  const want = s.settings.model + "|" + s.settings.voice;
  if (sel.dataset.rendered === JSON.stringify(s.voices) && sel.value === want) return;
  sel.textContent = "";
  if (!s.voices) return;
  for (const m of s.voices.models) {
    const group = document.createElement("optgroup");
    group.label = m.id === "qwen3" ? "Qwen3-TTS (best quality)" : "Kokoro (fastest)";
    for (const v of m.voices) {
      const opt = document.createElement("option");
      opt.value = m.id + "|" + v.id;
      opt.textContent = v.label;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  sel.value = want;
  sel.dataset.rendered = JSON.stringify(s.voices);
}

$("playpause").addEventListener("click", () => {
  if (!state) return;
  if (state.status === "playing" || state.status === "buffering" || state.status === "loading_model") {
    port.postMessage({ type: "CMD_PAUSE" });
  } else if (state.status === "paused") {
    port.postMessage({ type: "CMD_RESUME" });
  } else {
    port.postMessage({ type: "CMD_PLAY", tabId: activeTabId });
  }
});
$("stop").addEventListener("click", () => port.postMessage({ type: "CMD_STOP" }));
$("back").addEventListener("click", () => port.postMessage({ type: "CMD_SKIP", delta: -1 }));
$("fwd").addEventListener("click", () => port.postMessage({ type: "CMD_SKIP", delta: 1 }));

$("speed").addEventListener("input", () => {
  $("speedval").textContent = Number($("speed").value).toFixed(2) + "x";
});
$("speed").addEventListener("change", () => {
  port.postMessage({ type: "CMD_SET_SPEED", speed: parseFloat($("speed").value) });
});

$("voice").addEventListener("change", () => {
  const [model, voice] = $("voice").value.split("|");
  port.postMessage({ type: "CMD_SET_VOICE", model, voice });
});

$("retry").addEventListener("click", () => port.postMessage({ type: "CMD_REFRESH_VOICES" }));
