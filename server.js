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
const sharp = require('sharp');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Trust the first proxy hop (Railway) so req.ip reflects the real client IP from
// X-Forwarded-For instead of the proxy's own address — required for per-IP rate limiting
// to actually be per-visitor rather than global.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ── RATE LIMITING (in-memory, per-IP) ──
// Fixed-window limiter: max 10 requests per IP per 60s, applied to the two endpoints that
// call paid/quota-limited external APIs (Gemini, Tavily, Europeana). In-memory only — fine
// for a single-instance deployment; resets naturally as old timestamps age out.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateLimitMap = new Map(); // ip -> array of request timestamps (ms)

function rateLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - timestamps[0])) / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: `Too many requests. Please wait ${retryAfterSec}s and try again.` });
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  next();
}

// Periodic cleanup so the Map doesn't grow unbounded from one-off visitor IPs.
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap.entries()) {
    const fresh = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length) rateLimitMap.set(ip, fresh);
    else rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EUROPEANA_API_KEY = process.env.EUROPEANA_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const GEMINI_MODEL = 'gemini-flash-latest';
// unesco.org is matched by hostname, not path, so it already covers UNESCO's illicit-
// trafficking/repatriation pages (e.g. unesco.org/en/fight-illicit-trafficking) — no separate
// entry needed for that.
// ifar.org removed: IFAR (International Foundation for Art Research) shut down in 2024/2025
// after 55 years — confirmed via Artnet, Artforum, and the Met's own IFAR-archive digitization
// project ("as the organization prepared to permanently close in 2025").
const TAVILY_DOMAINS = [
  'metmuseum.org', 'getty.edu', 'interpol.int', 'unesco.org', 'artloss.com',
  'lostart.de', 'lootedart.com', 'christies.com', 'sothebys.com', 'artnet.com',
  'fbi.gov',
  // Government cultural-property/repatriation authorities — colonial-era and antiquities
  // claims, not just Nazi-era looting.
  'thegazette.co.uk', 'culture.gov.gr', 'antiquities.gov.eg'
];
// A hit on any of these domains is a government or international-body cultural-property
// claim (UK Gazette notices, Greek Ministry of Culture, Egyptian antiquities authority) —
// treated as seriously as an INTERPOL match.
const WATCHLIST_DOMAINS = [
  'interpol.int', 'artloss.com', 'lostart.de', 'lootedart.com', 'fbi.gov',
  'thegazette.co.uk', 'culture.gov.gr', 'antiquities.gov.eg'
];
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

// Retry schedule: up to 3 retries (4 attempts total) with exponential backoff 1s/2s/4s,
// for rate-limit (429) and overload (503 / "high demand") responses. Each attempt gets its
// own 30s timeout via a fresh AbortController.
const GEMINI_RETRY_DELAYS_MS = [1000, 2000, 4000];

async function callGemini(parts, maxOutputTokens, attempt = 0) {
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

  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(`Gemini returned a non-JSON response (HTTP ${r.status}).`);
  }

  const isRateLimited = r.status === 429;
  const isOverloaded  = r.status === 503 || /high demand|overloaded/i.test(data.error?.message || '');

  if (isRateLimited || isOverloaded) {
    if (attempt < GEMINI_RETRY_DELAYS_MS.length) {
      await new Promise(resolve => setTimeout(resolve, GEMINI_RETRY_DELAYS_MS[attempt]));
      return callGemini(parts, maxOutputTokens, attempt + 1);
    }
    throw new Error(isRateLimited
      ? 'Gemini rate limit reached after 3 retries. Please try again in a moment.'
      : 'Gemini is temporarily busy after 3 retries. Please try again in a moment.');
  }

  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  return extractGeminiText(data);
}

// ── FREE PROVENANCE SOURCES ──

async function searchMet(query, signal) {
  const name = 'The Met Museum';
  const domain = 'metmuseum.org';
  try {
    const sr = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?q=${encodeURIComponent(query)}`, { signal });
    const sd = await sr.json();
    const ids = (sd.objectIDs || []).slice(0, 3);
    if (!ids.length) return { name, domain, response: 'not_found', hits: [] };
    const details = await Promise.all(
      ids.map(id => fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, { signal }).then(r => r.json()).catch(() => null))
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

async function searchAIC(query, signal) {
  const name = 'Art Institute of Chicago';
  const domain = 'artic.edu';
  try {
    const fields = 'id,title,artist_display,date_display,medium_display,provenance_text';
    const sr = await fetch(`https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(query)}&fields=${fields}&limit=3`, { signal });
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

async function searchEuropeana(query, signal) {
  const name = 'Europeana';
  const domain = 'europeana.eu';
  if (!EUROPEANA_API_KEY) return { name, domain, response: 'not_found', hits: [], skipped: true };
  try {
    const sr = await fetch(`https://api.europeana.eu/record/v2/search.json?query=${encodeURIComponent(query)}&wskey=${EUROPEANA_API_KEY}&rows=3`, { signal });
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

// ── VICTORIA AND ALBERT MUSEUM (V&A) COLLECTIONS API ──
// Replaces a British Museum endpoint (collection.britishmuseum.org) originally specified for
// this fix: that host does not resolve to a live service (TCP connection times out on both
// port 443 and 80 — confirmed live, not just undocumented). No current (2025/2026) public
// British Museum API could be found either. The V&A's api.vam.ac.uk is a real, currently
// live, keyless REST API with the fields this fix actually needs: _primaryPlace (production
// place) and an acquisition year embedded in accessionNumber (V&A's standard
// "prefix.number-YYYY" convention, e.g. "E.50-1987" -> acquired 1987).
async function searchVAM(query, signal) {
  const name = 'Victoria and Albert Museum';
  const domain = 'vam.ac.uk';
  try {
    const sr = await fetch(`https://api.vam.ac.uk/v2/objects/search?q=${encodeURIComponent(query)}&page_size=5`, { signal });
    const sd = await sr.json();
    const hits = (sd.records || []).map(o => {
      const yearMatch = String(o.accessionNumber || '').match(/-(\d{4})$/);
      return {
        title: o._primaryTitle,
        artist: o._primaryMaker?.name || null,
        date: o._primaryDate,
        productionPlace: o._primaryPlace || null,
        objectType: o.objectType,
        accessionNumber: o.accessionNumber,
        acquisitionYear: yearMatch ? Number(yearMatch[1]) : null,
        url: `https://collections.vam.ac.uk/item/${o.systemNumber}/`
      };
    });
    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

// Flags an object acquired before the 1970 UNESCO Convention cutoff whose production place is
// outside the UK — same methodological rationale as the pre1970/non-Western-origin flag below,
// but grounded in the V&A's own structured acquisition data rather than a free-text heuristic.
function findVamPre1970NonUKAcquisition(vamResult) {
  const hits = vamResult.hits || [];
  return hits.find(h =>
    h.productionPlace &&
    !/united kingdom|england|scotland|wales|northern ireland|britain|british isles/i.test(h.productionPlace) &&
    h.acquisitionYear && h.acquisitionYear < 1970
  ) || null;
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

async function searchWikidata(title, artist, signal) {
  const name = 'Wikidata';
  const domain = 'wikidata.org';
  try {
    const sr = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(title)}&language=en&type=item&limit=5&format=json`, {
      headers: { 'User-Agent': WIKIMEDIA_UA },
      signal
    });
    const sd = await sr.json();
    const candidates = sd.search || [];
    if (!candidates.length) return { name, domain, response: 'not_found', hits: [] };

    const artistLastName = artist.trim().split(/\s+/).pop().toLowerCase();
    const best = candidates.find(c => (c.description || '').toLowerCase().includes(artistLastName)) || candidates[0];
    const qid = best.id;
    const entityUrl = `https://www.wikidata.org/wiki/${qid}`;

    // Repatriation/looting signal properties (added on top of the original dates/collection
    // query): P7084 (related category — catches categories like "cultural property
    // repatriation"), P1343 (described by source — academic references, surfaced as
    // supporting citations only, see findWikidataRepatriationSignal below), and a check for
    // whether the item is classified under looting.
    //
    // Correction: the original spec for this check named wd:Q41207, but that QID resolves to
    // "coin" on live Wikidata, not "looted art" — using it as given would have silently
    // matched the wrong concept. Q192623 ("looting") is the closest real match. In practice
    // Wikidata rarely types an artwork instance-of/subclass-of "looting" directly — looting is
    // normally recorded as a *significant event* via P793 (already queried below as
    // ?eventLabel), which remains the primary signal; this P31/P279* check is a best-effort
    // backstop, not the main detection path.
    const sparql = `
      SELECT ?inception ?locationLabel ?collectionLabel ?collStart ?collEnd ?ownerLabel ?ownStart ?ownEnd ?eventLabel ?eventTime ?relatedCategoryLabel ?sourceStmtLabel ?isLootedArt WHERE {
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
        OPTIONAL { wd:${qid} wdt:P7084 ?relatedCategory. }
        OPTIONAL { wd:${qid} wdt:P1343 ?sourceStmt. }
        BIND(EXISTS { wd:${qid} wdt:P31/wdt:P279* wd:Q192623 } AS ?isLootedArt)
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }`;

    const qr = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`, {
      headers: { 'User-Agent': WIKIMEDIA_UA, 'Accept': 'application/sparql-results+json' },
      signal
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
      if (b.relatedCategoryLabel) pushHit({ type: 'related_category', label: b.relatedCategoryLabel.value, url: entityUrl });
      if (b.sourceStmtLabel) pushHit({ type: 'described_by_source', label: b.sourceStmtLabel.value, url: entityUrl });
      if (b.isLootedArt && b.isLootedArt.value === 'true') pushHit({ type: 'looting_classification', label: 'Classified in Wikidata as a form of looting (P31/P279* → Q192623 "looting")', url: entityUrl });
    }

    return { name, domain, response: hits.length ? 'clear' : 'not_found', hits, entityUrl };
  } catch (e) {
    return { name, domain, response: 'not_found', hits: [], error: e.message };
  }
}

// ── REPATRIATION SIGNAL DETECTION (Wikidata) ──
// Looks for any of the three genuine looting/repatriation indicators among the hits above —
// an explicit looting classification, a related-category naming repatriation, or a
// significant-event label using theft/looting/repatriation vocabulary. "described_by_source"
// (P1343) hits are deliberately excluded: that property just links to whatever encyclopedia
// entry documents the item at all (used for virtually every well-documented artwork), so
// treating its mere presence as a looting signal would flag almost everything and defeat the
// purpose of a high-severity flag.
const REPATRIATION_SIGNAL_RE = /\b(stolen|looted|claimed|repatriat)/i;

function findWikidataRepatriationSignal(wikidataResult) {
  const hits = wikidataResult.hits || [];
  return hits.find(h =>
    h.type === 'looting_classification' ||
    (h.type === 'related_category' && /repatriat/i.test(h.label || '')) ||
    (h.type === 'significant_event' && REPATRIATION_SIGNAL_RE.test(h.label || ''))
  ) || null;
}

async function searchTavily(title, artist, signal) {
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
      }),
      signal
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
//
// VALIDATION AGAINST KNOWN CASES — checked by constructing realistic inputs from each work's
// well-documented public record and running them through this exact function (not hand
// arithmetic). Wally and Dalí are reconstructed from well-established public-record facts —
// Gemini's free-tier quota (20 req/min) was exhausted from earlier testing this session, so a
// full live pipeline run wasn't available for those two at the time of this check. Nefertiti's
// number is a REAL live result captured earlier in this session (not reconstructed).
//
// Case 1 — Egon Schiele, "Portrait of Wally": forced 1938 transfer from Lea Bondi Jaray to
// Nazi dealer Friedrich Welz; genuinely murky Austrian-state custody 1945-1954 (the actual
// gap); Leopold 1954; seized by the NY DA in 1997 and litigated for over a decade; 2010
// settlement ($19M to the Bondi estate). Reconstructed input: 1 real gap (the 1945-1954
// patch — the rest of the history is unusually WELL documented, that's precisely why it could
// be litigated), 3 high flags (Nazi spoliation, watchlist_match, wikidata_repatriation_signal),
// verifiedCount=2 (a Leopold Museum piece, not held by Met/AIC/MoMA/Europeana/V&A).
//   Old weights (30/25/10/10): 15% — directionally low, but the textbook "known looted,
//   litigated, settled" case should not still read as "some real risk of being fine".
//   New weights (30/25/20/10): 0% — matches expectation.
//
// Case 2 — Salvador Dalí, "The Persistence of Memory": created 1931, MoMA acquired 1934
// (anonymous gift), continuously in MoMA's own collection since — one of the most
// exhaustively documented paintings in existence, zero theft/looting history. Reconstructed
// input: 0 gaps, 0 risk flags, verifiedCount=3 (Tavily, MoMA, Wikidata clear).
//   Both old and new weights: 100%. Deliberately NOT capped down to fit the illustrative
//   "70-85%" expectation: a fixed, published, deterministic rule set (this project's explicit
//   design principle — see passport attestation: "attests to process, not to underlying
//   truth") should return 100% when it finds zero gaps, zero flags, and sufficient
//   corroboration. Adding an arbitrary ceiling just to land under a human-estimated range
//   would itself be an unprincipled fudge — the number means "no automated red flags," not
//   "certified beyond doubt," and the UI's own framing already carries that caveat.
//
// Case 3 — Nefertiti Bust (Ägyptisches Museum Berlin): excavated 1912, taken to Berlin,
// contested pre-1970 colonial-era gap. REAL result captured earlier this session: 1 gap,
// 2 high flags (contested-export flag from Gemini, watchlist_match), verifiedCount>=3.
//   Old weights: 50% (top edge of the 30-50% expected band).
//   New weights: 30% (bottom edge) — an improvement: "contested repatriation, low-medium" per
//   the case's own status label reads more accurately at 30% than sitting right at the
//   boundary of "medium".
//
// Conclusion: highFlag weight raised from 10 to 20. This is safe now specifically because of
// the same-day watchlist-precision fix (hitMentionsArtwork) — before that fix, a "high" flag
// could fire on a same-domain-but-unrelated Tavily hit, so doubling its weight would have
// doubled the cost of a false positive too. Now that "high" is reserved for hits that actually
// mention the artwork, each one carries more real signal and can reasonably cost more.
function computeConfidenceScore({ provenanceTimeline, riskFlags, authoritiesConsulted, valuationAssessment }) {
  let score = 100;
  const gapCount = (provenanceTimeline || []).filter(e => e.isGap).length;
  score -= gapCount * 30;

  const verifiedCount = (authoritiesConsulted || []).filter(a => a.response !== 'not_found').length;
  if (verifiedCount < 3) score -= 25;

  const highFlagCount = (riskFlags || []).filter(f => f.severity === 'high').length;
  score -= highFlagCount * 20;

  if (valuationAssessment?.anomalous) score -= 10;

  score = Math.max(0, Math.min(100, score));
  return score / 100;
}

// A watchlist-domain hit only means the *domain* is on the watchlist — Tavily's search can
// still surface a page from that domain that doesn't actually discuss this specific artwork
// (e.g. a general index page, or an unrelated case study). Require the hit's own title or
// snippet to mention the artwork's title or artist before treating it as a real match; domain
// hits that fail this check are downgraded to a low-severity "needs manual verification" flag
// instead of being silently dropped or over-reported as a high-severity match.
function hitMentionsArtwork(hit, title, artist) {
  const haystack = `${hit.title || ''} ${hit.snippet || ''}`.toLowerCase();
  const titleMatch = Boolean(title) && haystack.includes(title.toLowerCase());
  const artistMatch = Boolean(artist) && haystack.includes(artist.toLowerCase());
  return titleMatch || artistMatch;
}

// ── PRE-1970 CUSTODY GAP FLAG (non-Western-origin works) ──
// Methodological context: the 1970 UNESCO Convention on the Means of Prohibiting and
// Preventing the Illicit Import, Export and Transfer of Ownership of Cultural Property is the
// field's accepted due-diligence cutoff. An unexplained custody gap straddling 1970 in a work
// whose origin lies outside the traditional Western-museum-collecting countries is a
// recognized red flag for colonial-era removal or antiquities trafficking — separate from,
// and in addition to, the Nazi-era (1933-1945) screening this tool already does via the
// watchlist domains. The goal is to surface candidate cases for museums in the country of
// origin to pursue repatriation, identify where a royalty arrangement might be appropriate,
// and document the custody chain in a form usable in restitution proceedings.
//
// This is a keyword heuristic over free-text fields (period/artist/Wikidata labels), not a
// geographic classification system: it will miss unlisted regions and can mismatch ambiguous
// terms (e.g. an artist surname that happens to match a place name). It exists to flag
// candidates for human review, not to make a determination on its own.
const NON_WESTERN_ORIGIN_RE = /\b(egypt\w*|gree\w*|ital\w*|africa\w*|asia\w*|latin america\w*|mesopotam\w*|maya\w*|aztec\w*|inca\w*|benin\w*|nigeria\w*|ethiopia\w*|peru\w*|mexic\w*|china|chinese|india\w*|cambodia\w*|khmer)\b/i;

function detectsNonWesternOrigin({ period, artist, wikidata }) {
  const haystack = [period, artist, ...((wikidata?.hits || []).map(h => h.label || ''))].filter(Boolean).join(' ');
  return NON_WESTERN_ORIGIN_RE.test(haystack);
}

// Extracts 4-digit years from a free-text period string (Gemini writes things like
// "1938–1941" or "c. 1920s"); a single year found is treated as an open-ended gap starting
// there, since a bare start date with no listed end is itself part of the unexplained gap.
function extractYears(periodStr) {
  const matches = String(periodStr || '').match(/\b(1[5-9]\d{2}|20\d{2})\b/g);
  return matches ? matches.map(Number) : [];
}

function gapCrosses1970(entry) {
  const years = extractYears(entry.period);
  if (!years.length) return false;
  const start = Math.min(...years);
  const end = Math.max(...years);
  return years.length === 1 ? start <= 1970 : (start <= 1970 && end >= 1970);
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

function buildContext({ title, artist, period, medium, price, tavily, met, aic, europeana, vam, moma, wikidata }) {
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
  lines.push(section('Supplementary: Victoria and Albert Museum (production place, acquisition date)', vam));
  lines.push(section('Supplementary: Wikidata (structured facts, incl. repatriation/looting signals)', wikidata));
  return lines.join('\n');
}

async function synthesizePassport(context, meta) {
  const prompt = `You are an art provenance research assistant. You are given raw search results pulled from free public sources. The Tavily source is your main research engine — it is a cross-domain web search restricted to authoritative sites (museums, Interpol, UNESCO, loss registries, auction houses, the FBI, and government cultural-property authorities including the UK Gazette, the Greek Ministry of Culture, and Egypt's Ministry of Antiquities) and should be your primary basis for the provenance timeline, looting alerts, and ownership records. The other sources are supplementary — use them to corroborate or add structured facts (exact dates, accession records) around what Tavily found. Build a structured provenance record using ONLY facts present in the sources below.

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

// ── INPUT SANITIZATION ──
// Strips control characters (which could otherwise disrupt the Gemini prompt or leak into
// downstream API query strings) and caps length before any user-supplied text reaches a
// prompt or an external API call.

function sanitizeText(value, maxLength) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);
}

// ── ROUTES ──

app.post('/api/identify', rateLimiter, upload.single('image'), async (req, res) => {
  console.log('Identify request received, image size:', req.file?.size || 0);
  if (!req.file) return res.status(400).json({ error: 'No image provided.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  try {
    let imageBuffer = req.file.buffer;
    let imageMimeType = req.file.mimetype || 'image/jpeg';
    if (imageBuffer.length > 4 * 1024 * 1024) {
      imageBuffer = await sharp(imageBuffer).resize(1500, 1500, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
      imageMimeType = 'image/jpeg';
    }
    const base64 = imageBuffer.toString('base64');
    const prompt = `You are an art and artifact identification assistant. Look at this image and identify the artwork or object if you recognize it, or describe your best guess of its title, artist, period, and medium based on visual style if you do not recognize it exactly.

Return ONLY raw JSON (no markdown, no backticks) with this exact shape:
{"title": string|null, "artist": string|null, "period": string|null, "medium": string|null, "confidence": number, "notes": string}

confidence is a number from 0 to 1 reflecting how sure you are of the identification. If you cannot identify anything meaningful, set the fields to null and explain briefly in "notes".`;

    const text = await callGemini([
      { text: prompt },
      { inline_data: { mime_type: imageMimeType, data: base64 } }
    ], 500);
    console.log('Gemini raw response:', text.substring(0, 300));

    const parsed = extractJson(text);
    console.log('Parsed artwork:', JSON.stringify(parsed));
    if (!parsed) return res.status(502).json({ error: 'Could not parse an identification from Gemini.', raw: text });
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/verify', rateLimiter, async (req, res) => {
  const body = req.body || {};
  const title  = sanitizeText(body.title, 200);
  const artist = sanitizeText(body.artist, 100);
  const period = sanitizeText(body.period, 100);
  const medium = sanitizeText(body.medium, 100);
  const price  = sanitizeText(body.price, 50);
  if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required.' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });

  const query = [title, artist].filter(Boolean).join(' ');

  // Stream per-source progress over SSE so a museum visitor on slow wifi sees which of the
  // 7 sources has answered, instead of staring at one static spinner for 10-20s. Errors that
  // happen before this point (validation, missing key) are still plain JSON below — only
  // once we commit to the event-stream content type do failures become 'error' events.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Wikipedia was removed as a source (not credible enough for academic/professional
  // provenance use); Victoria and Albert Museum was added (see searchVAM above) — net count
  // is 7, not the 6 it briefly was between those two changes.
  const SOURCE_LABELS = {
    tavily: 'Tavily', met: 'The Met Museum', aic: 'Art Institute of Chicago',
    moma: 'MoMA', europeana: 'Europeana', vam: 'Victoria and Albert Museum', wikidata: 'Wikidata'
  };
  for (const label of Object.values(SOURCE_LABELS)) send({ type: 'progress', name: label, status: 'searching' });
  const track = (key, promise) => promise.then(r => {
    send({ type: 'progress', name: SOURCE_LABELS[key], status: 'done' });
    return r;
  });

  // Global 30s bound on the parallel search phase: if it runs long, abort every in-flight
  // fetch at once via the shared signal rather than letting the request hang indefinitely.
  // Individual source failures do NOT cancel their siblings — every searchX() already
  // degrades gracefully to a fallback result on its own error, so a flaky single source
  // (e.g. Wikidata timing out) must not blank out the other 6 independent sources.
  const searchController = new AbortController();
  const searchTimeoutId = setTimeout(() => searchController.abort(), 30000);
  const signal = searchController.signal;

  try {
    const [tavily, met, aic, europeana, vam, moma, wikidata] = await Promise.all([
      track('tavily', searchTavily(title, artist, signal)),
      track('met', searchMet(query, signal)),
      track('aic', searchAIC(query, signal)),
      track('europeana', searchEuropeana(query, signal)),
      track('vam', searchVAM(query, signal)),
      track('moma', Promise.resolve(searchMoma(title, artist))),
      track('wikidata', searchWikidata(title, artist, signal))
    ]);
    clearTimeout(searchTimeoutId);
    send({ type: 'stage', stage: 'synthesizing' });

    const authoritiesConsulted = [tavily, met, aic, moma, europeana, vam, wikidata].map(r => ({
      name: r.name,
      domain: r.domain,
      response: r.response,
      sourceUrl: r.hits?.[0]?.url || null
    }));

    const context = buildContext({ title, artist, period, medium, price, tavily, met, aic, europeana, vam, moma, wikidata });
    const draft = await synthesizePassport(context, { price });

    const riskFlags = [...(draft.riskFlags || [])];
    const seenUrls = new Set(riskFlags.map(f => f.sourceUrl).filter(Boolean));
    for (const h of tavily.hits) {
      if (WATCHLIST_DOMAINS.some(d => h.domain?.includes(d)) && !seenUrls.has(h.url)) {
        if (hitMentionsArtwork(h, title, artist)) {
          riskFlags.push({ type: 'watchlist_match', severity: 'high', detail: `Match found on ${h.domain}: "${h.title}"`, sourceUrl: h.url });
        } else {
          riskFlags.push({
            type: 'watchlist_domain_unconfirmed',
            severity: 'low',
            detail: `Watchlist domain found but content may not relate to this specific artwork — manual verification recommended. (${h.domain}: "${h.title}")`,
            sourceUrl: h.url
          });
        }
        seenUrls.add(h.url);
      }
    }

    const wikidataSignal = findWikidataRepatriationSignal(wikidata);
    if (wikidataSignal) {
      riskFlags.push({
        type: 'wikidata_repatriation_signal',
        severity: 'high',
        detail: `Repatriation or looting record found in Wikidata — verify with source country. (${wikidataSignal.label})`,
        sourceUrl: wikidataSignal.url || wikidata.entityUrl || null
      });
    }

    const vamFlag = findVamPre1970NonUKAcquisition(vam);
    if (vamFlag) {
      riskFlags.push({
        type: 'vam_pre1970_non_uk_acquisition',
        severity: 'medium',
        detail: `Object acquired pre-1970 from non-UK origin — Victoria and Albert Museum collection. (${vamFlag.productionPlace}, acquired ${vamFlag.acquisitionYear})`,
        sourceUrl: vamFlag.url || null
      });
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

    if (detectsNonWesternOrigin({ period, artist, wikidata })) {
      const crossingGap = provenanceTimeline.find(e => e.isGap && gapCrosses1970(e));
      if (crossingGap) {
        riskFlags.push({
          type: 'pre1970_gap_non_western_origin',
          severity: 'medium',
          detail: `Provenance gap crosses 1970 UNESCO Convention — country of origin may have repatriation claim. (Gap period: ${crossingGap.period || 'undated'})`,
          sourceUrl: null
        });
      }
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

    send({ type: 'result', passport });
    res.end();
  } catch (e) {
    clearTimeout(searchTimeoutId);
    send({ type: 'error', message: e.message });
    res.end();
  }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Image too large. Please use an image under 20MB.' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
