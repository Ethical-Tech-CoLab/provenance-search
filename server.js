if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
if (!process.env.GEMINI_API_KEY) {
  console.log('GEMINI_API_KEY not in .env, checking process.env directly...');
}
console.log('GEMINI_API_KEY loaded:', process.env.GEMINI_API_KEY ? 'YES' : 'NO');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EUROPEANA_API_KEY = process.env.EUROPEANA_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const GEMINI_MODEL = 'gemini-flash-latest';
const TAVILY_DOMAINS = [
  'metmuseum.org', 'getty.edu', 'interpol.int', 'unesco.org', 'artloss.com',
  'lostart.de', 'lootedart.com', 'christies.com', 'sothebys.com', 'artnet.com',
  'fbi.gov', 'ifar.org', 'wikipedia.org'
];
const WATCHLIST_DOMAINS = ['interpol.int', 'artloss.com', 'lostart.de', 'lootedart.com', 'fbi.gov'];
const WIKIMEDIA_UA = 'arts-and-artifacts-provenance-agent/1.0 (https://github.com/; contact via repo)';

// ── MOMA LOCAL DATASET (bundled, gzip-compressed) ──
// Regenerate with `npm run build:moma`. Source: github.com/MuseumofModernArt/collection

let MOMA_ARTWORKS = [];
try {
  const gz = fs.readFileSync(path.join(__dirname, 'data', 'moma-artworks.json.gz'));
  MOMA_ARTWORKS = JSON.parse(zlib.gunzipSync(gz).toString('utf-8'));
  console.log(`Loaded ${MOMA_ARTWORKS.length} MoMA artworks from bundled dataset.`);
} catch (e) {
  console.warn('Could not load bundled MoMA dataset, MoMA search will return no results:', e.message);
}

// ── GEMINI HELPERS ──

function extractGeminiText(geminiResponse) {
  return (geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function callGemini(parts, maxOutputTokens, isRetry = false) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens }
      }),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Gemini request timed out after 30 seconds.');
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await r.json();
  const isOverloaded = r.status === 503 || /high demand|overloaded/i.test(data.error?.message || '');

  if (isOverloaded) {
    if (!isRetry) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      return callGemini(parts, maxOutputTokens, true);
    }
    throw new Error('Gemini is temporarily busy. Please try again in a moment.');
  }

  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  return extractGeminiText(data);
}

// ── FREE PROVENANCE SOURCES ──

async function searchMet(query) {
  const name = 'The Met Museum';
  const domain = 'metmuseum.org';
  try {
    const sr = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?q=${encodeURIComponent(query)}`);
    const sd = await sr.json();
    const ids = (sd.objectIDs || []).slice(0, 3);
    if (!ids.length) return { name, domain, response: 'not_found', hits: [] };
    const details = await Promise.all(
      ids.map(id => fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`).then(r => r.json()).catch(() => null))
    );
    const hits = details.filter(Boolean).map(o => ({
      title: o.title, artist: o.artistDisplayName, date: o.objectDate,
      medium: o.medium, creditLine: o.creditLine, url: o.objectURL
    }));
    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

async function searchAIC(query) {
  const name = 'Art Institute of Chicago';
  const domain = 'artic.edu';
  try {
    const fields = 'id,title,artist_display,date_display,medium_display,provenance_text';
    const sr = await fetch(`https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(query)}&fields=${fields}&limit=3`);
    const sd = await sr.json();
    const hits = (sd.data || []).map(o => ({
      title: o.title, artist: o.artist_display, date: o.date_display,
      medium: o.medium_display, provenance: o.provenance_text || null,
      url: `https://www.artic.edu/artworks/${o.id}`
    }));
    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

async function searchEuropeana(query) {
  const name = 'Europeana';
  const domain = 'europeana.eu';
  if (!EUROPEANA_API_KEY) return { name, domain, response: 'not_found', hits: [], skipped: true };
  try {
    const sr = await fetch(`https://api.europeana.eu/record/v2/search.json?query=${encodeURIComponent(query)}&wskey=${EUROPEANA_API_KEY}&rows=3`);
    const sd = await sr.json();
    const hits = (sd.items || []).map(o => ({
      title: Array.isArray(o.title) ? o.title[0] : o.title,
      provider: Array.isArray(o.dataProvider) ? o.dataProvider[0] : o.dataProvider,
      url: o.guid || o.link
    }));
    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

async function searchWikipedia(query) {
  const name = 'Wikipedia';
  const domain = 'wikipedia.org';
  try {
    const sr = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`, {
      headers: { 'User-Agent': WIKIMEDIA_UA }
    });
    const sd = await sr.json();
    const hits = (sd.query?.search || []).slice(0, 3).map(o => ({
      title: o.title,
      snippet: (o.snippet || '').replace(/<[^>]+>/g, ''),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(o.title.replace(/ /g, '_'))}`
    }));
    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

function searchMoma(title, artist) {
  const name = 'MoMA (bundled open dataset)';
  const domain = 'moma.org';
  try {
    const titleTokens = title.toLowerCase().split(/\s+/).filter(Boolean);
    const artistTokens = artist.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const hits = [];
    for (const a of MOMA_ARTWORKS) {
      const hay = (a.t + ' ' + a.a).toLowerCase();
      const titleMatches = titleTokens.every(t => hay.includes(t));
      const artistMatches = artistTokens.some(t => hay.includes(t));
      if (titleMatches && artistMatches) {
        hits.push({ title: a.t, artist: a.a, date: a.d, medium: a.m, creditLine: a.c, url: a.u });
        if (hits.length >= 3) break;
      }
    }
    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

async function searchWikidata(title, artist) {
  const name = 'Wikidata';
  const domain = 'wikidata.org';
  try {
    const sr = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(title)}&language=en&type=item&limit=5&format=json`, {
      headers: { 'User-Agent': WIKIMEDIA_UA }
    });
    const sd = await sr.json();
    const candidates = sd.search || [];
    if (!candidates.length) return { name, domain, response: 'not_found', hits: [] };

    const artistLastName = artist.trim().split(/\s+/).pop().toLowerCase();
    const best = candidates.find(c => (c.description || '').toLowerCase().includes(artistLastName)) || candidates[0];
    const qid = best.id;
    const entityUrl = `https://www.wikidata.org/wiki/${qid}`;

    const sparql = `
      SELECT ?inception ?locationLabel ?collectionLabel ?collStart ?collEnd ?ownerLabel ?ownStart ?ownEnd ?eventLabel ?eventTime WHERE {
        OPTIONAL { wd:${qid} wdt:P571 ?inception. }
        OPTIONAL { wd:${qid} wdt:P276 ?location. }
        OPTIONAL {
          wd:${qid} p:P195 ?collStmt.
          ?collStmt ps:P195 ?collection.
          OPTIONAL { ?collStmt pq:P580 ?collStart. }
          OPTIONAL { ?collStmt pq:P582 ?collEnd. }
        }
        OPTIONAL {
          wd:${qid} p:P127 ?ownStmt.
          ?ownStmt ps:P127 ?owner.
          OPTIONAL { ?ownStmt pq:P580 ?ownStart. }
          OPTIONAL { ?ownStmt pq:P582 ?ownEnd. }
        }
        OPTIONAL {
          wd:${qid} p:P793 ?evStmt.
          ?evStmt ps:P793 ?event.
          OPTIONAL { ?evStmt pq:P585 ?eventTime. }
        }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }`;

    const qr = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`, {
      headers: { 'User-Agent': WIKIMEDIA_UA, 'Accept': 'application/sparql-results+json' }
    });
    const qd = await qr.json();
    const bindings = qd.results?.bindings || [];

    const hits = [];
    const seen = new Set();
    const pushHit = (fact) => {
      const key = JSON.stringify(fact);
      if (!seen.has(key)) { seen.add(key); hits.push(fact); }
    };
    for (const b of bindings) {
      if (b.inception) pushHit({ type: 'inception', date: b.inception.value, url: entityUrl });
      if (b.locationLabel) pushHit({ type: 'current_location', label: b.locationLabel.value, url: entityUrl });
      if (b.collectionLabel) pushHit({ type: 'collection', label: b.collectionLabel.value, start: b.collStart?.value || null, end: b.collEnd?.value || null, url: entityUrl });
      if (b.ownerLabel) pushHit({ type: 'owned_by', label: b.ownerLabel.value, start: b.ownStart?.value || null, end: b.ownEnd?.value || null, url: entityUrl });
      if (b.eventLabel) pushHit({ type: 'significant_event', label: b.eventLabel.value, time: b.eventTime?.value || null, url: entityUrl });
    }

    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits, entityUrl };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

async function searchTavily(title, artist) {
  const name = 'Tavily — provenance & looting research';
  const domain = TAVILY_DOMAINS.join(', ');
  if (!TAVILY_API_KEY) return { name, domain, response: 'not_found', hits: [], skipped: true };
  try {
    const query = `${title} ${artist} provenance ownership history looting theft restitution`;
    const sr = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'advanced',
        include_domains: TAVILY_DOMAINS,
        max_results: 10
      })
    });
    const sd = await sr.json();
    if (sd.error) throw new Error(sd.error);
    const hits = (sd.results || []).map(o => {
      let hostname = '';
      try { hostname = new URL(o.url).hostname.replace(/^www\./, ''); } catch {}
      return { title: o.title, snippet: (o.content || '').slice(0, 600), url: o.url, domain: hostname };
    });
    const hasWatchlistHit = hits.some(h => WATCHLIST_DOMAINS.some(d => h.domain.includes(d)));
    const response = hasWatchlistHit ? 'flagged' : (hits.length ? 'clear' : 'not_found');
    return { name, domain, response, hits };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

// ── SCORING (algorithmic, not AI) ──

function computeConfidenceScore({ provenanceTimeline, riskFlags, authoritiesConsulted, valuationAssessment }) {
  let score = 100;
  const gapCount = (provenanceTimeline || []).filter(e => e.isGap).length;
  score -= gapCount * 30;

  const verifiedCount = (authoritiesConsulted || []).filter(a => a.response !== 'not_found').length;
  if (verifiedCount < 3) score -= 25;

  const highFlagCount = (riskFlags || []).filter(f => f.severity === 'high').length;
  score -= highFlagCount * 10;

  if (valuationAssessment?.anomalous) score -= 10;

  score = Math.max(0, Math.min(100, score));
  return score / 100;
}

function signPassport(artwork) {
  const signedAt = new Date().toISOString();
  const integrityHash = crypto.createHash('sha256').update(`${artwork.title}|${artwork.artist}|${signedAt}`).digest('hex');
  return {
    signedBy: 'arts-and-artifacts-agent-v1',
    signedAt,
    integrityHash,
    attestation: 'This passport records the results of automated queries to free, public provenance and risk-screening sources. It attests to process, not to underlying truth.'
  };
}

// ── PASSPORT SYNTHESIS (Gemini reasons over facts we already fetched) ──

function buildContext({ title, artist, period, medium, price, tavily, met, aic, europeana, wiki, moma, wikidata }) {
  const section = (label, result) => {
    if (result.skipped) return `\n--- ${label} ---\nNot queried (no API key configured for this source).`;
    if (!result.hits.length) return `\n--- ${label} ---\nNo matching records found.`;
    return `\n--- ${label} ---\n${JSON.stringify(result.hits)}`;
  };
  const lines = [`ARTWORK: ${title} by ${artist}${period ? ' (' + period + ')' : ''}${medium ? ', ' + medium : ''}`];
  if (price) lines.push(`USER-PROVIDED LAST SALE PRICE (USD): $${price}`);
  lines.push(section('PRIMARY SOURCE — Tavily web research (provenance, looting alerts, ownership records)', tavily));
  lines.push(section('Supplementary: The Met Museum', met));
  lines.push(section('Supplementary: Art Institute of Chicago', aic));
  lines.push(section('Supplementary: MoMA (bundled open dataset)', moma));
  lines.push(section('Supplementary: Europeana', europeana));
  lines.push(section('Supplementary: Wikipedia', wiki));
  lines.push(section('Supplementary: Wikidata (structured facts)', wikidata));
  return lines.join('\n');
}

async function synthesizePassport(context, meta) {
  const prompt = `You are an art provenance research assistant. You are given raw search results pulled from free public sources. The Tavily source is your main research engine — it is a cross-domain web search restricted to authoritative sites (museums, Interpol, UNESCO, loss registries, auction houses, the FBI, IFAR, Wikipedia) and should be your primary basis for the provenance timeline, looting alerts, and ownership records. The other sources are supplementary — use them to corroborate or add structured facts (exact dates, accession records) around what Tavily found. Build a structured provenance record using ONLY facts present in the sources below.

If the sources leave a period of ownership unaccounted for, add a timeline entry with "isGap": true and a "gapNote" explaining what is missing. A gap is itself a fact worth reporting.

FALLBACK RULE: if, and only if, the live sources above contain little or no provenance information for a work you recognize as well-documented from your own training knowledge (e.g. a famous museum piece with a well-known ownership history), you may add timeline entries drawn from that general knowledge instead of leaving a bare gap. Every such entry MUST have "isGeneralKnowledge": true, "verified": false, "sourceUrl": null, and "sourceAuthority": "General knowledge — not from live source". Never use this fallback to override or contradict what the live sources actually say — live-sourced facts always take priority, and this fallback only fills in what the sources left blank. Do not invent facts even under this fallback; only include ownership history you are confident is well-documented and widely known to be accurate.

SOURCES:
${context}

Return ONLY raw JSON (no markdown, no backticks, no explanation) with this exact shape:
{
  "confidenceRationale": "one or two plain-language sentences on what is and is not verified",
  "provenanceTimeline": [{"period": string, "owner": string, "isGap": boolean, "gapNote": string|null, "note": string|null, "sourceUrl": string|null, "sourceAuthority": string|null, "verified": boolean, "isGeneralKnowledge": boolean}],
  "riskFlags": [{"type": string, "severity": "high"|"medium"|"low", "detail": string, "sourceUrl": string|null}],
  "valuationAssessment": {"providedPrice": ${meta.price ? '"$' + meta.price + '"' : 'null'}, "expectedRange": string|null, "anomalous": boolean, "note": string}
}

Set "isGeneralKnowledge": false on every entry that came from the sources above. Only mark valuationAssessment.anomalous true if a user-provided price is clearly out of line with a comparable figure actually present in the sources. If no price was provided or no comparable exists, set anomalous to false.`;

  const text = await callGemini([{ text: prompt }], 6000);
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Could not parse a passport from Gemini: ' + text.slice(0, 200));
  return parsed;
}

// ── ROUTES ──

app.post('/api/identify', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  try {
    const base64 = req.file.buffer.toString('base64');
    const prompt = `You are an art and artifact identification assistant. Look at this image and identify the artwork or object if you recognize it, or describe your best guess of its title, artist, period, and medium based on visual style if you do not recognize it exactly.

Return ONLY raw JSON (no markdown, no backticks) with this exact shape:
{"title": string|null, "artist": string|null, "period": string|null, "medium": string|null, "confidence": number, "notes": string}

confidence is a number from 0 to 1 reflecting how sure you are of the identification. If you cannot identify anything meaningful, set the fields to null and explain briefly in "notes".`;

    const text = await callGemini([
      { text: prompt },
      { inline_data: { mime_type: req.file.mimetype || 'image/jpeg', data: base64 } }
    ], 500);

    const parsed = extractJson(text);
    if (!parsed) return res.status(502).json({ error: 'Could not parse an identification from Gemini.', raw: text });
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/verify', async (req, res) => {
  const { title, artist, period, medium, price } = req.body || {};
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });

  const query = [title, artist].filter(Boolean).join(' ');

  try {
    const [tavily, met, aic, europeana, wiki, moma, wikidata] = await Promise.all([
      searchTavily(title, artist),
      searchMet(query),
      searchAIC(query),
      searchEuropeana(query),
      searchWikipedia(query),
      Promise.resolve(searchMoma(title, artist)),
      searchWikidata(title, artist)
    ]);

    const authoritiesConsulted = [tavily, met, aic, moma, europeana, wiki, wikidata].map(r => ({
      name: r.name,
      domain: r.domain,
      response: r.response,
      sourceUrl: r.hits?.[0]?.url || null
    }));

    const context = buildContext({ title, artist, period, medium, price, tavily, met, aic, europeana, wiki, moma, wikidata });
    const draft = await synthesizePassport(context, { price });

    const riskFlags = [...(draft.riskFlags || [])];
    const seenUrls = new Set(riskFlags.map(f => f.sourceUrl).filter(Boolean));
    for (const h of tavily.hits) {
      if (WATCHLIST_DOMAINS.some(d => h.domain?.includes(d)) && !seenUrls.has(h.url)) {
        riskFlags.push({ type: 'watchlist_match', severity: 'high', detail: `Match found on ${h.domain}: "${h.title}"`, sourceUrl: h.url });
        seenUrls.add(h.url);
      }
    }

    const provenanceTimeline = draft.provenanceTimeline || [];
    if (provenanceTimeline.some(e => e.isGeneralKnowledge)) {
      riskFlags.push({
        type: 'general_knowledge_used',
        severity: 'medium',
        detail: 'Part of this timeline is drawn from the AI\'s general historical knowledge rather than a live, cited source. Entries built this way are marked "General knowledge — not from live source" and are unverified.',
        sourceUrl: null
      });
    }

    const valuationAssessment = draft.valuationAssessment || {
      providedPrice: price ? `$${price}` : null, expectedRange: null, anomalous: false, note: ''
    };

    const confidenceScore = computeConfidenceScore({
      provenanceTimeline,
      riskFlags,
      authoritiesConsulted,
      valuationAssessment
    });

    const passport = {
      artwork: { title, artist, period: period || null, medium: medium || null },
      confidenceScore,
      confidenceRationale: draft.confidenceRationale || '',
      provenanceTimeline,
      riskFlags,
      valuationAssessment,
      authoritiesConsulted,
      passportSignature: signPassport({ title, artist })
    };

    res.json(passport);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
