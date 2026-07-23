'use strict';

const {
  studioQueryVariants,
  metaMatchesStudio
} = require('./config');

const UPSTREAM = (process.env.PORNTUBE_UPSTREAM || 'https://ptube.ers.pw').replace(/\/+$/, '');
const PAGE_SIZE = 36;
const MAX_SCAN_PAGES = 8;

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
  // Stremio style: genre=X&skip=Y (values URL-encoded)
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
 * Build a studio-filtered page for VR.
 * Strategy:
 *  1) Prefer upstream VR search (works well for BaDoink/Wankz/etc.)
 *  2) Also try Old catalog with plain site name (dots/.com break upstream)
 *  3) Fallback: scan Latest pages and title-match
 */
async function organizedVrCatalog(configB64, genre, skip = 0) {
  const skipN = Math.max(0, Number(skip) || 0);

  if (!genre || /^latest$/i.test(genre) || /^none$/i.test(genre)) {
    return fetchCatalogPage(configB64, 'pt_vr', { genre: 'Latest', skip: skipN });
  }

  const variants = studioQueryVariants(genre);
  const buckets = [];

  // VR search — best signal for VRPorn-style titles
  for (const q of variants.slice(0, 3)) {
    try {
      const data = await fetchCatalogPage(configB64, 'pt_vr', { search: q, skip: 0 });
      const metas = (data.metas || []).filter((m) => metaMatchesStudio(m, genre));
      if (metas.length) buckets.push(metas);
    } catch {
      // ignore and try next
    }
  }

  // Old catalog with plain names only (no dots)
  for (const q of variants) {
    if (q.includes('.')) continue;
    try {
      const data = await fetchCatalogPage(configB64, 'pt_old', { genre: q, skip: 0 });
      const metas = data.metas || [];
      if (metas.length) buckets.push(metas);
    } catch {
      // ignore
    }
  }

  let merged = mergeMetas(buckets);

  // If search returned nothing useful, scan Latest pages
  if (merged.length < 5) {
    const scanned = [];
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      try {
        const data = await fetchCatalogPage(configB64, 'pt_vr', {
          genre: 'Latest',
          skip: page * PAGE_SIZE
        });
        const metas = data.metas || [];
        if (!metas.length) break;
        scanned.push(...metas.filter((m) => metaMatchesStudio(m, genre)));
        if (metas.length < PAGE_SIZE) break;
      } catch {
        break;
      }
    }
    merged = mergeMetas([merged, scanned]);
  }

  const page = merged.slice(skipN, skipN + PAGE_SIZE);
  return { metas: page };
}

/**
 * Old catalog with broken .com genres fixed (strip dots for upstream).
 */
async function organizedOldCatalog(configB64, genre, skip = 0) {
  const skipN = Math.max(0, Number(skip) || 0);

  if (!genre || /^latest$/i.test(genre) || /^none$/i.test(genre)) {
    // No "all" on Old without a genre — fall back to first safe site or empty
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

  // Search fallback on Old
  for (const q of studioQueryVariants(genre).slice(0, 2)) {
    try {
      const data = await fetchCatalogPage(configB64, 'pt_old', { search: q, skip: skipN });
      const metas = (data.metas || []).filter((m) => metaMatchesStudio(m, genre));
      if (metas.length) return { metas };
    } catch {
      // ignore
    }
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
