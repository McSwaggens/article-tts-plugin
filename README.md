# Local Reader TTS

Read articles aloud in Firefox with a high-quality **local** neural TTS model.
No cloud, no accounts, no robotic built-in browser voices — synthesis runs
entirely on your own machine.

- **`server/`** — a small FastAPI service on `127.0.0.1:8765` that runs
  [Qwen3-TTS-1.7B](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
  (best prosody) and [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
  (near-instant) on Apple Silicon via [mlx-audio](https://github.com/Blaizzy/mlx-audio).
- **`extension/`** — a Firefox extension that extracts the article with
  Mozilla's Readability.js (the same library Reader View uses), streams
  per-sentence audio from the server with prefetch, highlights the sentence
  being read, and gives you play/pause, sentence skip, speed control, and a
  voice picker. Audio keeps playing while you browse other tabs.

## Requirements

- macOS on Apple Silicon (M-series)
- [uv](https://docs.astral.sh/uv/) (`brew install uv`)
- Firefox 140+

## Run the server

```sh
uv --directory server run tts-server
```

`uv` fetches Python 3.12 and all dependencies on first run. Model weights
download from Hugging Face to `~/.cache/huggingface` on first use
(Qwen3 ≈ 4 GB, Kokoro ≈ 0.3 GB); after that everything works offline.

### Auto-start at login (optional)

```sh
server/launchd/install-launchd.sh
```

Installs and loads a LaunchAgent; logs go to `~/Library/Logs/tts-server.log`.

## Install the extension

**Quick (temporary):** open `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on…** → pick `extension/manifest.json`. Temporary add-ons
disappear when Firefox quits.

**Permanent:** release Firefox only permanently installs Mozilla-signed
extensions. Build the package with `scripts/package.sh`, upload the zip at
[addons.mozilla.org](https://addons.mozilla.org/developers/) under
**"On your own"** (unlisted self-distribution — nothing is published), download
the signed `.xpi`, and drag it into Firefox. Signed `.xpi`s may also be
attached to this repo's Releases.

## Usage

Open an article, click the toolbar speaker icon, press ▶.

- Use the extension on the **normal** page, not in Reader View — Firefox
  blocks all extensions inside `about:reader`, so this extension does its own
  reader-style extraction instead.
- **Voices**: Qwen3 voices have the best prosody (`aiden` is the default;
  several are accent-flavored). Kokoro voices synthesize ~40x real-time and
  are fully deterministic.
- **Speed**: Kokoro renders speed natively (pitch preserved); Qwen3 uses
  playback-rate adjustment (slight pitch shift at high speeds).
- A sentence that fails to synthesize is retried once, then skipped — one bad
  sentence won't kill a long article.
- First Qwen3 sentence takes a few seconds while the model loads; after that
  generation stays ahead of playback.

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

- **Popup says "TTS server is not running"** — start it with the command
  above, then hit Retry.
- **"Firefox blocks extensions in Reader View"** — exit Reader View (the X in
  the page's left toolbar) and press play on the normal page.
- **"Couldn't find an article on this page"** — the page didn't pass
  Readability's article detection (dashboards, web apps, index pages).

## License

MIT (see [LICENSE](LICENSE)). Vendored Readability.js is Apache 2.0 from
[mozilla/readability](https://github.com/mozilla/readability).
