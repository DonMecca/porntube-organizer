'use strict';

const express = require('express');
const path = require('path');
const { decodeConfig, studioGenreOptions } = require('./lib/config');
const {
  organizedVrCatalog,
  organizedOldCatalog,
  proxyMeta,
  proxyStream,
  fetchCatalogPage,
  UPSTREAM
} = require('./lib/upstream');
const {
  createNoIndexMiddleware,
  createRobotsHandler,
  createAccessSecretMiddleware,
  createConfigurePasswordMiddleware
} = require('./lib/privacy_middleware');

const app = express();
const PORT = process.env.PORT || 7010;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/+$/,
  ''
);

app.use(createNoIndexMiddleware());
app.use(createAccessSecretMiddleware());
app.use(createConfigurePasswordMiddleware());
app.get('/robots.txt', createRobotsHandler());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'alive', upstream: UPSTREAM });
});

app.get(['/', '/configure'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function buildManifest(cfg) {
  const sites = (cfg && cfg.sites) || [];
  const genres = studioGenreOptions(sites);
  const catalogs = [];

  if (!cfg || cfg.vr !== false) {
    catalogs.push({
      id: 'pt_vr_org',
      type: 'movie',
      name: 'PornTube VR',
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: genres }
      ]
    });
  }

  if (!cfg || cfg.showOldCatalog !== false) {
    catalogs.push({
      id: 'pt_old_org',
      type: 'movie',
      name: 'PornTube Old',
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false },
        {
          name: 'genre',
          isRequired: false,
          options: genres.filter((g) => g !== 'Latest')
        }
      ]
    });
  }

  catalogs.push({
    id: 'tpdb_catalog',
    type: 'movie',
    name: 'PornTube New',
    extra: [
      { name: 'skip', isRequired: false },
      { name: 'search', isRequired: false },
      { name: 'genre', isRequired: false }
    ]
  });

  return {
    id: 'pw.ers.porntube.organizer',
    version: '1.0.1',
    name: 'Porn Tube Organizer',
    description:
      'Studio Genre filters for Porn Tube VR/Old. Reuses your Porn Tube config (RD/TorBox/sites).',
    logo: 'https://ptube.ers.pw/logo.png',
    background: 'https://ptube.ers.pw/background.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    idPrefixes: ['pt', 'porndb'],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: !cfg,
      adult: true
    }
  };
}

function parseExtras(extraPath) {
  const out = {};
  if (!extraPath) return out;
  const cleaned = String(extraPath).replace(/\.json$/i, '');
  for (const part of cleaned.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
  }
  return out;
}

async function handleCatalog(configB64, catalogId, extras, res) {
  const cfg = decodeConfig(configB64);
  if (!cfg) return res.status(400).json({ error: 'invalid config' });

  const skip = extras.skip || 0;
  const genre = extras.genre || '';
  const search = extras.search || '';

  let data;
  if (catalogId === 'pt_vr_org') {
    data = search
      ? await fetchCatalogPage(configB64, 'pt_vr', { search, skip })
      : await organizedVrCatalog(configB64, genre || 'Latest', skip);
  } else if (catalogId === 'pt_old_org') {
    data = search
      ? await fetchCatalogPage(configB64, 'pt_old', { search, skip })
      : await organizedOldCatalog(configB64, genre, skip);
  } else if (catalogId === 'tpdb_catalog') {
    data = await fetchCatalogPage(configB64, 'tpdb_catalog', {
      genre: genre || undefined,
      search: search || undefined,
      skip
    });
  } else {
    return res.status(404).json({ error: 'unknown catalog' });
  }

  res.setHeader('Cache-Control', 'max-age=120, public');
  return res.json({ metas: data.metas || [] });
}

app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'max-age=300, public');
  res.json(buildManifest(null));
});

app.get('/:config/manifest.json', (req, res) => {
  const cfg = decodeConfig(req.params.config);
  if (!cfg) return res.status(400).json({ error: 'invalid config' });
  res.setHeader('Cache-Control', 'max-age=300, public');
  res.json(buildManifest(cfg));
});

// /config/catalog/movie/pt_vr_org.json
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
  try {
    await handleCatalog(req.params.config, req.params.id, {}, res);
  } catch (err) {
    console.error('catalog error', err.message);
    res.status(502).json({ metas: [], error: err.message });
  }
});

// /config/catalog/movie/pt_vr_org/genre=BaDoinkVR&skip=0.json
app.get('/:config/catalog/:type/:id/:extra.json', async (req, res) => {
  try {
    await handleCatalog(req.params.config, req.params.id, parseExtras(req.params.extra), res);
  } catch (err) {
    console.error('catalog error', err.message);
    res.status(502).json({ metas: [], error: err.message });
  }
});

// IDs may contain colons: pt:pxl:123
app.get(/^\/([^/]+)\/meta\/([^/]+)\/(.+)\.json$/, async (req, res) => {
  try {
    const configB64 = req.params[0];
    const type = req.params[1];
    const id = req.params[2];
    if (!decodeConfig(configB64)) return res.status(400).json({ error: 'invalid config' });
    const data = await proxyMeta(configB64, type, id);
    res.setHeader('Cache-Control', 'max-age=300, public');
    res.json(data);
  } catch (err) {
    console.error('meta error', err.message);
    res.status(502).json({ meta: null, error: err.message });
  }
});

app.get(/^\/([^/]+)\/stream\/([^/]+)\/(.+)\.json$/, async (req, res) => {
  try {
    const configB64 = req.params[0];
    const type = req.params[1];
    const id = req.params[2];
    if (!decodeConfig(configB64)) return res.status(400).json({ error: 'invalid config' });
    const data = await proxyStream(configB64, type, id);
    res.setHeader('Cache-Control', 'max-age=60, public');
    res.json(data);
  } catch (err) {
    console.error('stream error', err.message);
    res.status(502).json({ streams: [], error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Porn Tube Organizer on ${BASE_URL} (port ${PORT})`);
  console.log(`Upstream: ${UPSTREAM}`);
});
