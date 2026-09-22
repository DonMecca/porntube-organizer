'use strict';

const {
  studioQueryVariants,
  metaMatchesStudio
} = require('./config');

const UPSTREAM = (process.env.PORNTUBE_UPSTREAM || 'https://ptube.ers.pw').replace(/\/+$/, '');
const PAGE_SIZE = 36;
/** How many upstream pages to walk when filling one Stremio page after title filtering. */
const MAX_FILL_PAGES = 12;
/** Hard cap when building a deep studio list (skip high). */
const MAX_UPSTREAM_PAGES = 40;
/** Upstream enforces x-ratelimit-limit: 60/min; a request timeout keeps handlers from hanging. */
const UPSTREAM_TIMEOUT_MS = Number(process.env.PORNTUBE_TIMEOUT_MS) || 12000;
/** Upstream sends Cache-Control: max-age=86400 and Cloudflare does not cache it, so we must. */
const CACHE_TTL_MS = Number(process.env.PORNTUBE_CACHE_TTL_MS) || 120000;
const CACHE_MAX_ENTRIES = 200;

const cache = new Map(); // url -> { expires, value, promise }

function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(url);
    return null;
  }
  return hit;
}

function cacheSet(url, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order; drop the oldest entry.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(url, { expires: Date.now() + CACHE_TTL_MS, value, promise: null });
}

async function upstreamGet(configB64, pathAndQuery) {
  const url = `${UPSTREAM}/${configB64}/${pathAndQuery.replace(/^\//, '')}`;

  const cached = cacheGet(url);
  if (cached) {
    // A pending fetch is shared so concurrent requests coalesce into one call.
    if (cached.promise) return cached.promise;
    return cached.value;
  }

  const entry = { expires: Date.now() + CACHE_TTL_MS, value: null, promise: null };
  entry.promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': 'PornTube-Organizer/1.0',
          Accept: 'application/json'
        },
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`);
        timeoutErr.status = 504;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const err = new Error(`upstream redirect ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`upstream HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 200);
      // Surface rate limiting distinctly so callers can back off instead of
      // reporting an empty catalog as if the studio simply had no videos.
      err.rateLimited = res.status === 429;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    if (!ct.includes('json') && !text.trim().startsWith('{')) {
      const err = new Error('upstream non-JSON');
      err.status = 502;
      err.body = text.slice(0, 200);
      throw err;
    }
    return JSON.parse(text);
  })();

  cache.set(url, entry);
  try {
    const value = await entry.promise;
    entry.value = value;
    entry.promise = null;
    entry.expires = Date.now() + CACHE_TTL_MS;
    return value;
  } catch (err) {
    // Never cache failures.
    cache.delete(url);
    throw err;
  }
}

function encodeExtra(parts) {
  return parts
    .filter(Boolean)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function fetchCatalogPage(configB64, catalogId, extras = {}) {
  const pairs = [];
  if (extras.genre) pairs.push(['genre', extras.genre]);
  if (extras.search) pairs.push(['search', extras.search]);
  if (extras.skip != null && Number(extras.skip) > 0) pairs.push(['skip', Number(extras.skip)]);

  const extra = encodeExtra(pairs);
  const path = extra
    ? `catalog/movie/${catalogId}/${extra}.json`
    : `catalog/movie/${catalogId}.json`;
  return upstreamGet(configB64, path);
}

function mergeMetas(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const meta of list || []) {
      if (!meta || !meta.id) continue;
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      out.push(meta);
    }
  }
  return out;
}

/**
 * Page through upstream VR search until we can return `PAGE_SIZE` items
 * starting at `skip`, or upstream runs out.
 */
async function pagedSearchFiltered(configB64, catalogId, query, genre, skipN) {
  const matched = [];
  const seen = new Set();
  let upstreamSkip = 0;
  let pages = 0;
  let emptyStreak = 0;

  while (pages < MAX_UPSTREAM_PAGES && matched.length < skipN + PAGE_SIZE) {
    pages += 1;
    let metas = [];
    try {
      const data = await fetchCatalogPage(configB64, catalogId, {
        search: query,
        skip: upstreamSkip
      });
      metas = data.metas || [];
    } catch (err) {
      // Rate limiting affects every variant equally, so surface it instead of
      // returning an empty catalog that looks like "no videos for this studio".
      if (err && err.rateLimited) throw err;
      break;
    }

    if (!metas.length) break;

    let added = 0;
    for (const meta of metas) {
      if (!meta || !meta.id || seen.has(meta.id)) continue;
      if (!metaMatchesStudio(meta, genre)) continue;
      seen.add(meta.id);
      matched.push(meta);
      added += 1;
    }

    if (added === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
    } else {
      emptyStreak = 0;
    }

    if (metas.length < PAGE_SIZE) break;
    upstreamSkip += PAGE_SIZE;

    if (matched.length >= skipN + PAGE_SIZE) break;

    // Past the fill budget, serve a partial page rather than walking the full
    // cap. (The previous form of this check was unreachable — the loop
    // condition above already guarantees the opposite.)
    if (pages >= MAX_FILL_PAGES && matched.length > skipN) break;
  }

  return matched.slice(skipN, skipN + PAGE_SIZE);
}

/**
 * Build a studio-filtered page for VR.
 * Forwards pagination into upstream search so studios aren't capped at ~36.
 */
async function organizedVrCatalog(configB64, genre, skip = 0) {
  const skipN = Math.max(0, Number(skip) || 0);

  if (!genre || /^latest$/i.test(genre) || /^none$/i.test(genre)) {
    return fetchCatalogPage(configB64, 'pt_vr', { genre: 'Latest', skip: skipN });
  }

  const variants = studioQueryVariants(genre);

  // Prefer the variant that looks most like a VR search key (with VR / .com stripped short names last)
  const searchOrder = [...variants].sort((a, b) => {
    const score = (q) => {
      let s = 0;
      if (/vr/i.test(q)) s += 2;
      if (!q.includes('.')) s += 1;
      if (q.length >= 5) s += 1;
      return s;
    };
    return score(b) - score(a);
  });

  for (const q of searchOrder.slice(0, 3)) {
    const page = await pagedSearchFiltered(configB64, 'pt_vr', q, genre, skipN);
    if (page.length) return { metas: page };
  }

  // Old catalog plain-name genre (paginated)
  for (const q of variants) {
    if (q.includes('.')) continue;
    try {
      const data = await fetchCatalogPage(configB64, 'pt_old', { genre: q, skip: skipN });
      if ((data.metas || []).length) return data;
    } catch (err) {
      if (err && err.rateLimited) throw err;
      // try next
    }
  }

  // Last resort: scan Latest feed with title match (slow; limited depth)
  const scanned = [];
  const seen = new Set();
  for (let page = 0; page < MAX_FILL_PAGES; page++) {
    try {
      const data = await fetchCatalogPage(configB64, 'pt_vr', {
        genre: 'Latest',
        skip: page * PAGE_SIZE
      });
      const metas = data.metas || [];
      if (!metas.length) break;
      for (const meta of metas) {
        if (!meta || !meta.id || seen.has(meta.id)) continue;
        if (!metaMatchesStudio(meta, genre)) continue;
        seen.add(meta.id);
        scanned.push(meta);
      }
      if (metas.length < PAGE_SIZE) break;
      if (scanned.length >= skipN + PAGE_SIZE) break;
    } catch (err) {
      if (err && err.rateLimited) throw err;
      break;
    }
  }

  return { metas: scanned.slice(skipN, skipN + PAGE_SIZE) };
}

/**
 * Old catalog with broken .com genres fixed (strip dots for upstream).
 *
 * This catalog is studio-filter-only: upstream `pt_old` ignores `skip` and has
 * no usable default listing, so with no genre there is nothing meaningful to
 * return. Callers surface that as a normal empty page rather than an error.
 */
async function organizedOldCatalog(configB64, genre, skip = 0) {
  const skipN = Math.max(0, Number(skip) || 0);

  if (!genre || /^latest$/i.test(genre) || /^none$/i.test(genre)) {
    return { metas: [] };
  }

  const variants = studioQueryVariants(genre).filter((v) => !v.includes('.'));
  for (const q of variants) {
    try {
      const data = await fetchCatalogPage(configB64, 'pt_old', { genre: q, skip: skipN });
      if ((data.metas || []).length) return data;
    } catch (err) {
      if (err && err.rateLimited) throw err;
      // try next
    }
  }

  for (const q of studioQueryVariants(genre).slice(0, 2)) {
    const page = await pagedSearchFiltered(configB64, 'pt_old', q, genre, skipN);
    if (page.length) return { metas: page };
  }

  return { metas: [] };
}

async function proxyMeta(configB64, type, id) {
  return upstreamGet(configB64, `meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
}

async function proxyStream(configB64, type, id) {
  return upstreamGet(configB64, `stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
}

module.exports = {
  UPSTREAM,
  organizedVrCatalog,
  organizedOldCatalog,
  proxyMeta,
  proxyStream,
  fetchCatalogPage
};
