# notebooklm-dump

Serverless audio library hosted on GitHub Pages. Audio files live as GitHub Release assets and stream directly via native HTML5 `<audio>` over HTTP byte-range requests. No backend, no transcoding, no HLS.

- **Listener**: https://luqmansen.github.io/notebooklm-dump/
- **Owner upload**: https://luqmansen.github.io/notebooklm-dump/upload.html

## Upload (owner only)

### One-time setup

1. Deploy the upload proxy Worker (required — `uploads.github.com` does not send CORS headers):
   - Cloudflare Dashboard → Workers & Pages → Create application → Create Worker.
   - Replace the default code with the contents of [`worker.js`](worker.js). Deploy.
   - Copy the Worker URL (e.g. `https://notebooklm-upload.<sub>.workers.dev`).
   - Edit [`assets/js/uploader.js`](assets/js/uploader.js), set `UPLOAD_PROXY_BASE` to that URL, commit + push.
2. Mint a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new):
   - Repository access: only this repo
   - Permissions: **Contents: Read and write**
   - Expiry: 90 days (rotate via the same UI when it expires)

### Per upload

1. Open `/upload.html`, paste the token (stored only in your browser's `localStorage`).
2. Pick an audio file — title auto-fills from the filename, edit if needed.
3. Hit **Upload & Publish**.
4. Pages rebuilds in ~30–60 s, then the new track appears in the library.

### Worker free-tier limits

- 100,000 requests/day (one upload = one request)
- 100 MB request body cap on free; 500 MB on Workers Paid
- Worker streams the body through to GitHub; it does not store or buffer the audio

## How it works

- `upload.html`: 3 GitHub API calls per upload — create release, upload asset, update `tracks.json`.
- `index.html`: fetches `tracks.json`, renders a list, plays the selected track. Browser handles streaming + seek via byte-range requests against the release CDN.
- One release per track. Releases are permanent.

See [`plan.md`](plan.md) for the full design (local only, gitignored).
