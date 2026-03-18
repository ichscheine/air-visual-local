# Air Visual

`air-visual` is a lightweight Airbnb host copilot MVP:

- Chrome extension side panel for scanning the current Airbnb listing
- Tier 1 recommendations only: cover photo, brightness, crop, composition, amenity visibility, and photo sequencing
- Stateless backend proxy for `Gemini 2.5 Flash-Lite` or local `Ollama + Qwen2.5-VL` analysis
- No external database

## What the MVP does

1. Detects the current Airbnb listing page.
2. Extracts visible listing context from the page:
   - title
   - nightly rate when visible
   - occupancy hints when visible
   - top photo candidates from the DOM
3. Sends the listing context to a local backend.
4. Uses:
   - `Gemini 2.5 Flash-Lite` through the Gemini Developer API when `GEMINI_API_KEY` is set
   - `Qwen2.5-VL 3B` through Ollama as the local fallback
   - deterministic local preview transforms for brightness, crop, and composition
5. Lets the host review preview variants and mark each one as `Accept` or `Decline`.

## Safety boundary

This MVP only supports Tier 1 changes:

- better hero selection
- lighting and white-balance improvements
- crop and composition improvements
- clearer amenity visibility
- better photo ordering

It explicitly avoids fabricating amenities, adding furniture, removing permanent flaws, or changing the underlying property.

## Setup

1. Copy `.env.example` to `.env`.
2. Choose a provider:

For Gemini free tier:

```bash
# put your Google AI Studio key in .env
```

For local Ollama fallback:

```bash
ollama pull qwen2.5vl:3b
```

3. Start Ollama if it is not already running, then start the local proxy:

```bash
npm run dev
```

If vision analysis is slow or unavailable, tune `.env` first, then restart `npm run dev`:

- `AI_PROVIDER=auto` uses Gemini when `GEMINI_API_KEY` is present and falls back to Ollama otherwise.
- `GEMINI_MODEL=gemini-2.5-flash-lite` is the hosted default for low-cost analysis.
- `OLLAMA_MODEL=qwen2.5vl:3b` is the local fallback model in this repo.
- `OLLAMA_VISION_MODELS=qwen2.5vl:3b` keeps Ollama analysis on a single model instead of the slower ensemble path.
- `MAX_ANALYSIS_PHOTOS=2` is the current quality/speed default.
- `PHOTO_FETCH_TIMEOUT_MS=10000` bounds slow Airbnb CDN image fetches.
- `GEMINI_TIMEOUT_MS=30000` bounds hosted Gemini analysis waits.
- `OLLAMA_CHAT_TIMEOUT_MS=150000` sets the backend wait time for Ollama analysis.
- `USE_MOCK_AI=1` skips Ollama entirely for workflow testing.

If you need a lighter fallback for very constrained machines, switch both `OLLAMA_MODEL` and `OLLAMA_VISION_MODELS` to `moondream`.

4. In the extension side panel, click `Check backend`.
   - If Gemini is selected but the API key is missing, the panel will tell you.
   - If Ollama is selected but not running, the panel will tell you.
   - If the local model is missing, the panel will tell you which `ollama pull ...` command to run.

5. Load the extension:
   - Open `chrome://extensions`
   - Enable `Developer mode`
   - Click `Load unpacked`
   - Select the repo root: [`air-visual`](/Users/daoming/Documents/Github/air-visual)
6. Open an Airbnb listing or host photo page and click the extension icon to open the side panel.

## Demo mode

If `USE_MOCK_AI=1`, the backend runs in demo mode and returns heuristic analysis plus a deterministic preview plan. This lets you test the workflow without Ollama.

## Files

- [`manifest.json`](/Users/daoming/Documents/Github/air-visual/manifest.json)
- [`content.js`](/Users/daoming/Documents/Github/air-visual/content.js)
- [`sidepanel.js`](/Users/daoming/Documents/Github/air-visual/sidepanel.js)
- [`server/server.mjs`](/Users/daoming/Documents/Github/air-visual/server/server.mjs)

## Chrome Web Store

Run `npm run build:cws` to create a packaged extension at `dist/air-visual-cws.zip`.

If you want to regenerate the store icon and promo art from a reference logo with Gemini image generation, run:

```bash
npm run generate:cws-assets -- --reference path/to/reference.png
```

That command updates:

- `icons/icon-16.png`
- `icons/icon-32.png`
- `icons/icon-48.png`
- `icons/icon-128.png`
- `store-assets/promo/air-visual-small-promo-440x280.png`
- `store-assets/promo/air-visual-marquee-promo-1400x560.png`
- `store-assets/screenshots/air-visual-screenshot-1-1280x800.png`
- `store-assets/screenshots/air-visual-screenshot-2-1280x800.png`

Notes:

- The generator expects `GEMINI_API_KEY` in `.env`.
- The default image model is `GEMINI_IMAGE_MODEL=gemini-2.5-flash-image`.
- Generated masters are kept under `tmp/generated-cws-masters/`.
- Chrome Web Store screenshots are safest when replaced with real product captures before submission.

Store privacy disclosures live in:

- [`docs/privacy-policy.md`](/Users/daoming/Documents/Github/air-visual/docs/privacy-policy.md)
- [`docs/vision-models-report.html`](/Users/daoming/Documents/Github/air-visual/docs/vision-models-report.html)
- [`docs/vision-models-report.pdf`](/Users/daoming/Documents/Github/air-visual/docs/vision-models-report.pdf)

## Limitations

- Airbnb DOM structure varies by page and locale, so extraction is heuristic.
- The extension does not auto-upload edited photos back into Airbnb.
- Occupancy is estimated from visible page signals when possible and falls back to a benchmark default.
- Remote image fetches can fail if Airbnb changes CDN rules or requires authenticated URLs.
- Vision inference can be slow on CPU-only setups; lowering `MAX_ANALYSIS_PHOTOS` is the first lever to pull.
- Preview variants are deterministic transforms, not generative image rewrites.
- The extension now checks backend and Ollama readiness before starting analysis.
