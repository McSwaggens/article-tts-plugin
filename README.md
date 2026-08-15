# Local Reader TTS

Read articles aloud in Firefox with a high-quality **local** neural TTS model —
no cloud, no built-in-browser-voice sound. Two halves:

- **`server/`** — a small FastAPI service on `127.0.0.1:8765` that runs
  [Qwen3-TTS-1.7B](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
  (best prosody) and [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
  (near-instant) on Apple Silicon via [mlx-audio](https://github.com/Blaizzy/mlx-audio).
- **`extension/`** — an MV2 Firefox extension that extracts the article with
  Mozilla's Readability.js (the same library Reader View uses), streams
  per-sentence audio from the server, highlights the sentence being read, and
  gives you play/pause, skip, speed, and a voice picker.

Firefox blocks extensions from `about:reader` pages, so use the extension on the
**normal** page — it does its own reader-mode extraction.

## Run the server

```sh
uv --directory server run tts-server
```

`uv` fetches Python 3.12 and all dependencies on first run. Model weights
download from Hugging Face to `~/.cache/huggingface` on first use
(Qwen3 ≈ 4 GB, Kokoro ≈ 0.3 GB); after that everything is offline.

### Auto-start at login (optional)

```sh
cp server/launchd/com.daniel.tts-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.daniel.tts-server.plist
```

Logs go to `~/Library/Logs/tts-server.log`.

## Load the extension

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/manifest.json`
3. Open an article, click the toolbar speaker icon, press ▶

Temporary add-ons disappear when Firefox quits — re-load after a restart.
(For a permanent install you'd need Firefox Developer Edition with
`xpinstall.signatures.required=false`, or an AMO-signed build.)

## Usage notes

- **Voice picker**: Qwen3 voices (best quality — `aiden` is the default; some
  voices are accent-flavored) and Kokoro voices (fastest, deterministic).
  Switching models warms the new model in the background.
- **Speed**: Kokoro renders speed natively (pitch stays natural); Qwen3 uses
  playback-rate adjustment (slight pitch shift at high speeds).
- Audio keeps playing while you browse other tabs. Starting a read on another
  tab stops the current one.
- If a single sentence fails to synthesize it is retried once, then skipped —
  a bad sentence won't kill a long article.

## Server API

| Endpoint | Description |
|---|---|
| `GET /health` | `{status, loaded, loading}` |
| `GET /voices` | models + voices + defaults |
| `POST /warmup {"model"}` | load a model in the background |
| `POST /speak {"text","model","voice","speed"}` | returns `audio/wav`; headers `X-Applied-Speed`, `X-Sample-Rate` |

Smoke test:

```sh
curl -sf -X POST http://127.0.0.1:8765/speak \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from the local server.","model":"kokoro","voice":"af_heart"}' \
  -o /tmp/t.wav && afplay /tmp/t.wav
```

## Troubleshooting

- **Popup says "TTS server is not running"** — start it with the command above,
  then hit Retry.
- **First Qwen3 sentence takes ~10 s** — one-time model load (longer if weights
  are still downloading); the popup shows "Loading model…". Use Kokoro if you
  want instant starts, or `curl -X POST localhost:8765/warmup -d '{"model":"qwen3"}' -H 'Content-Type: application/json'` after boot.
- **"Couldn't find an article on this page"** — the page didn't pass
  Readability's article detection (dashboards, web apps, index pages).
