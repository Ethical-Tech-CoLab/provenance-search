# Arts & Artifacts — Provenance Intelligence

**[Live site](https://ethical-tech-colab.github.io/provenance-search/)** ·
**[Research report](Provenance-Search-Paper.md)** (plain-language, non-technical)

Looks up an artwork's ownership history across free public sources and emits a
provenance passport with a confidence score computed by a fixed algorithm
(not by the AI).

## Live Demo

**[https://provenance-search-production.up.railway.app](https://provenance-search-production.up.railway.app)**

## Architecture

- `index.html` — static frontend (text form, image upload, camera capture)
- `server.js` — Express backend; the only thing that talks to external APIs
- Frontend only ever calls its own server: `POST /api/identify`, `POST /api/verify`
- All API keys live in `.env` on the server and are never sent to the browser

## Input modes

1. **Text form** — title, artist, period, medium (+ optional last known sale price)
2. **Upload image** — pick a photo from disk
3. **Camera** — opens the device camera (works on mobile, e.g. in a museum);
   falls back to a helpful error if the browser denies camera access

Providing an image calls `/api/identify` (Gemini Vision, free tier), which
auto-fills the form and automatically triggers `/api/verify`.

## Free APIs used

| Source | Used for | Key required? |
|---|---|---|
| [Tavily Search API](https://tavily.com/) | **Primary research engine** — provenance history, looting alerts, ownership records, restricted to metmuseum.org, getty.edu, interpol.int, unesco.org, artloss.com, lostart.de, lootedart.com, christies.com, sothebys.com, artnet.com, fbi.gov, ifar.org, wikipedia.org | Yes (free dev tier) |
| [The Met Museum API](https://metmuseum.github.io/) | Supplementary: museum collection records | No |
| [Art Institute of Chicago API](https://api.artic.edu/docs/) | Supplementary: museum collection + provenance text | No |
| [MoMA open dataset](https://github.com/MuseumofModernArt/collection) | Supplementary: MoMA collection records (bundled locally, see below) | No |
| [Wikipedia API](https://www.mediawiki.org/wiki/API:Search) | Supplementary: general background/encyclopedic hits | No |
| [Wikidata (SPARQL)](https://query.wikidata.org/) | Supplementary: structured facts — inception date, collection history, ownership, significant events | No |
| [Europeana API](https://pro.europeana.eu/page/apis) | Supplementary: European cultural heritage records | Yes (free) |
| [Gemini API](https://ai.google.dev/) | Vision-based identification + synthesizing the timeline/flags from the facts above | Yes (free tier) |

Tavily is the main research engine: it's the first source Gemini is told to
weight most heavily, and the only source whose hits trigger the deterministic
high-severity "watchlist match" flag (a hit on interpol.int, artloss.com,
lostart.de, lootedart.com, or fbi.gov). The rest are supplementary — they
corroborate or add exact dates/accession records around what Tavily finds.

### MoMA dataset

MoMA has no live public search API — its website is behind Cloudflare's bot
protection, and its only open data is a static export on GitHub
([MuseumofModernArt/collection](https://github.com/MuseumofModernArt/collection)).
A slimmed, gzip-compressed copy (title/artist/date/medium/credit line/URL for
~159k works, ~3.7MB) is bundled at `data/moma-artworks.json.gz` and loaded
into memory at startup — no network call needed at request time. To refresh
it from the upstream dataset:

```bash
npm run build:moma
```

### General knowledge fallback

For very famous, well-documented works (e.g. the Mona Lisa, The Starry Night),
if all of the live sources above return little or no ownership history, Gemini
is allowed to fill in widely-known historical facts from its own training data.
Every such entry is explicitly labeled `"isGeneralKnowledge": true` and
`sourceAuthority: "General knowledge — not from live source"` in the JSON, is
tagged **general knowledge** in the timeline UI, is never marked `verified`,
and never overrides what a live source actually says. A medium-severity risk
flag is added automatically whenever this fallback is used, so it's always
visible even without reading the raw timeline.

## Getting each key (all free)

### Gemini API key
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Sign in with a Google account, click "Create API key"
3. Copy it into `.env` as `GEMINI_API_KEY`

### Tavily API key
1. Go to [tavily.com](https://tavily.com/) and sign up (free dev tier, no billing info)
2. Copy your API key from the dashboard into `.env` as `TAVILY_API_KEY`
3. If left blank, the server skips Tavily entirely and falls back to the
   supplementary sources only (this also removes the deterministic
   high-severity "watchlist match" flag, since that depends on Tavily's hits)

### Europeana API key
1. Go to [pro.europeana.eu/page/get-api](https://pro.europeana.eu/page/get-api)
2. Fill out the free request form (instant, no billing info)
3. Copy the key into `.env` as `EUROPEANA_API_KEY`
4. If left blank, the server simply skips this source

The Met, Art Institute of Chicago, MoMA (bundled), Wikipedia, and Wikidata
need no keys at all.

## Local setup

```bash
npm install
cp .env.example .env   # then fill in your keys
npm start
```

Visit `http://localhost:3000`.

## Confidence score algorithm

Computed entirely in `server.js` (`computeConfidenceScore`), never by the AI:

- Start at 100%
- **−30%** per custody gap in the provenance timeline
- **−25%** if fewer than 3 of the 7 sources returned a verified hit
- **−10%** per high-severity risk flag
- **−10%** if the valuation is flagged anomalous

Score is clamped to 0–100%.

## Deploying to Railway

1. Push this project to a GitHub repo (or use `railway up` from this directory)
2. In Railway, create a new project from the repo
3. Railway auto-detects `npm start` from `package.json`
4. Add the environment variables from `.env.example` in the Railway project's
   **Variables** tab (do not commit `.env` — it's already in `.gitignore`)
5. Railway sets `PORT` automatically; `server.js` reads `process.env.PORT`

## Security note

`.env` and `.env.save` contain live API keys and are excluded via
`.gitignore`. If either file was ever committed or shared, rotate the keys
before relying on this project further.
