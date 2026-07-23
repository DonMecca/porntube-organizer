'use strict';

/**
 * Parse the same Base64 JSON config blob Porn Tube uses in its install URL.
 */

function decodeConfig(raw) {
  if (!raw) return null;
  let text = String(raw).trim();

  // Allow pasting a full Porn Tube / organizer URL
  const m = text.match(/\/([A-Za-z0-9_\-+/=]+)\/(?:manifest\.json)?/);
  if (m) text = m[1];

  // URL-safe base64 → standard
  text = text.replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4) text += '=';

  try {
    const json = Buffer.from(text, 'base64').toString('utf8');
    const cfg = JSON.parse(json);
    if (!cfg || typeof cfg !== 'object') return null;
    return normalizeConfig(cfg);
  } catch {
    return null;
  }
}

function normalizeConfig(cfg) {
  const sites = Array.isArray(cfg.sites)
    ? cfg.sites.map((s) => String(s || '').trim()).filter(Boolean)
    : [];

  return {
    rdToken: String(cfg.rdToken || ''),
    tbToken: String(cfg.tbToken || ''),
    easynewsUsername: String(cfg.easynewsUsername || ''),
    easynewsPassword: String(cfg.easynewsPassword || ''),
    sites,
    resolutions: Array.isArray(cfg.resolutions) ? cfg.resolutions : ['UHD', 'FullHD', 'HD'],
    hideTorrents: Boolean(cfg.hideTorrents),
    showOldCatalog: cfg.showOldCatalog !== false,
    vr: cfg.vr !== false,
    timestamp: cfg.timestamp || Date.now()
  };
}

function encodeConfig(cfg) {
  const normalized = normalizeConfig(cfg);
  return Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64');
}

/** Collapse BaDoinkVR + BaDoinkVR.com into one dropdown label. */
function studioGenreOptions(sites) {
  const byKey = new Map();

  for (const site of sites || []) {
    const key = studioKey(site);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, preferredLabel(site));
      continue;
    }
    // Prefer cleaner label without .com when both exist
    byKey.set(key, preferredLabel(existing, site));
  }

  return ['Latest', ...[...byKey.values()].sort((a, b) => a.localeCompare(b))];
}

function studioKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.com$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function preferredLabel(...names) {
  const cleaned = names
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .sort((a, b) => {
      const aDot = /\.com$/i.test(a) ? 1 : 0;
      const bDot = /\.com$/i.test(b) ? 1 : 0;
      if (aDot !== bDot) return aDot - bDot; // prefer no .com
      return a.length - b.length;
    });
  return cleaned[0] || '';
}

/** Match variants used when querying upstream. */
function studioQueryVariants(genre) {
  const raw = String(genre || '').trim();
  if (!raw || /^latest$/i.test(raw) || /^none$/i.test(raw)) return [];

  const noCom = raw.replace(/\.com$/i, '');
  const withCom = /\.com$/i.test(raw) ? raw : `${noCom}.com`;
  const variants = [raw, noCom, withCom];

  // Extra short query for search (BaDoinkVR → BaDoink)
  if (/vr$/i.test(noCom) && noCom.length > 4) {
    variants.push(noCom.replace(/vr$/i, ''));
  }

  const seen = new Set();
  const out = [];
  for (const v of variants) {
    const t = String(v || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function metaMatchesStudio(meta, genre) {
  const variants = studioQueryVariants(genre).map((v) => v.toLowerCase());
  if (!variants.length) return true;

  const hay = [
    meta && meta.name,
    meta && meta.releaseInfo,
    meta && meta.description,
    Array.isArray(meta && meta.genres) ? meta.genres.join(' ') : ''
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return variants.some((v) => hay.includes(v.toLowerCase()));
}

module.exports = {
  decodeConfig,
  normalizeConfig,
  encodeConfig,
  studioGenreOptions,
  studioKey,
  studioQueryVariants,
  metaMatchesStudio
};
