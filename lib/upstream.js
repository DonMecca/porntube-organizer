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

async function upstreamGet(configB64, pathAndQuery) {
  const url = `${UPSTREAM}/${configB64}/${pathAndQuery.replace(/^\//, '')}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'PornTube-Organizer/1.0',
      Accept: 'application/json'
    },
    redirect: 'manual'
  });

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
    throw err;
  }
  if (!ct.includes('json') && !text.trim().startsWith('{')) {
    const err = new Error('upstream non-JSON');
    err.status = 502;
    err.body = text.slice(0, 200);
    throw err;
  }
  return JSON.parse(text);
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
    } catch {
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

    // Don't over-fetch far past what this Stremio page needs
    if (matched.length >= skipN + PAGE_SIZE) break;
    if (pages >= MAX_FILL_PAGES && matched.length >= skipN + 1) {
      // Have at least something for this page; keep going only if still short
      if (matched.length >= skipN + PAGE_SIZE) break;
    }
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
    } catch {
      // ignore
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
    } catch {
      break;
    }
  }

  return { metas: scanned.slice(skipN, skipN + PAGE_SIZE) };
}

/**
 * Old catalog with broken .com genres fixed (strip dots for upstream).
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
    } catch {
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
