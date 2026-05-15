# notebooklm-dump

Serverless audio library hosted on GitHub Pages. Audio files live as GitHub Release assets and stream directly via native HTML5 `<audio>` over HTTP byte-range requests. No backend.

- **Listener**: https://luqmansen.github.io/notebooklm-dump/
- **Owner upload**: https://luqmansen.github.io/notebooklm-dump/upload.html

## Architecture

```
Browser ──► [if >100 MB: ffmpeg.wasm re-encodes to AAC in browser, serial]
       ──► api.github.com         (create release, CORS-friendly)
       ──► <cf-worker>             (CORS proxy → uploads.github.com, 100 MB cap)
       ──► api.github.com         (append tracks.json, batched at end)
```

Up to 3 uploads run in parallel. Re-encoding runs one file at a time (single CPU).

## One-time setup

### 1. Cloudflare Worker upload proxy

The Worker is auto-deployed from this repo via Cloudflare Workers Builds (`wrangler.toml`).

If you haven't set it up yet:
- Cloudflare Dashboard → Workers & Pages → **Create application** → **Workers** → **Import a repository** → pick this repo.
- Worker name must be `notebooklm-upload` (matches `wrangler.toml`).
- Production branch: `main`. Deploy command: `npx wrangler deploy`. Build command: empty.
- Save and Deploy.

Verify with:
```
curl -i -X OPTIONS https://notebooklm-upload.luqmansen.workers.dev/ \
  -H "Origin: https://luqmansen.github.io" \
  -H "Access-Control-Request-Method: POST"
```
Expected: `HTTP/2 204` + `access-control-allow-*` headers.

### 2. GitHub PAT

[Fine-grained PAT](https://github.com/settings/personal-access-tokens/new):
- Repository access: only this repo
- Permissions: **Contents: Read and write**
- Expiry: 90 days

## Per upload

1. Open `/upload.html`, paste the token (stored only in browser `localStorage`).
2. Pick one or more audio files — titles auto-fill from filenames, editable inline.
3. Hit **Upload All**. Files ≤100 MB upload immediately; larger files queue for in-browser re-encoding first.
4. After all files complete, `tracks.json` updates in one commit.
5. Pages rebuilds in ~30–60 s, then the new tracks appear in the library.

### Re-encoding details

Triggered when a source file is >100 MB. The browser computes a target AAC bitrate to fit the result in ~95 MB:

```
target_kbps = min(96, floor(95 MB × 8 / duration_seconds / 1000))
```

Floor: 32 kbps. So sources too long to fit at 32 kbps fail with a clear error (a ~7 h source at 32 kbps already lands at ~100 MB).

ffmpeg.wasm runs in the browser as a single-threaded WebAssembly build. ~30 MB on first use (cached afterward). Encode speed is 5–15× realtime on a modern laptop (a 1 h podcast: ~5 min). Output is fast-start `.m4a` (`-movflags +faststart`), so it streams immediately from the release CDN.

## Limits

| Resource | Free tier | Notes |
|---|---|---|
| Worker requests | 100k/day | 1 per upload |
| Worker request body | **100 MB** | The cap that triggers re-encoding |
| GitHub release asset | 2 GB | Per file, hard cap |
| GitHub Pages bandwidth | 100 GB/month | HTML/JS only — audio served by GitHub's release CDN, not Pages |
| GitHub API | 5,000 req/hr (auth) | ~3 calls per upload; massive headroom |

## Branches

- `main` — current architecture (simple Worker proxy + browser ffmpeg.wasm fallback)
- `feature/r2-staging` — alternative design using Cloudflare R2 as staging to bypass the 100 MB Worker cap without re-encoding. Heavier setup (R2 bucket + CORS + API token + Worker secrets). Preserved for reference.
