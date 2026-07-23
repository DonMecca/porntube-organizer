# Porn Tube Organizer

Stremio wrapper around [Porn Tube](https://ptube.ers.pw/) that puts your selected studios into the **Genre** dropdown for VR (and repairs Old filters that break on `.com` site names).

## Install

1. Open the configure page on the deployed host.
2. Paste your existing Porn Tube manifest URL (same Base64 config).
3. Install the generated `stremio://…` link.
4. In Discover → **PornTube VR** → **Genre**, pick a studio instead of only Latest.

## Dev

```bash
npm install
PORT=7010 npm start
```

Upstream default: `https://ptube.ers.pw` (`PORNTUBE_UPSTREAM`).
