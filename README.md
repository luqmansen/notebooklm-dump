# notebooklm-dump

Serverless audio library hosted on GitHub Pages. Audio files live as GitHub Release assets and stream directly via native HTML5 `<audio>` over HTTP byte-range requests. No backend, no transcoding, no HLS.

- **Listener**: https://luqmansen.github.io/notebooklm-dump/
- **Owner upload**: https://luqmansen.github.io/notebooklm-dump/upload.html

## Upload (owner only)

1. Mint a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new): repository access = this repo, permissions = **Contents: Read and write**.
2. Open `/upload.html`, paste the token (stored only in your browser's `localStorage`).
3. Pick an audio file, fill title + artist, hit **Upload & Publish**.
4. Pages rebuilds in ~30–60 s, then the new track appears in the library.

## How it works

- `upload.html`: 3 GitHub API calls per upload — create release, upload asset, update `tracks.json`.
- `index.html`: fetches `tracks.json`, renders a list, plays the selected track. Browser handles streaming + seek via byte-range requests against the release CDN.
- One release per track. Releases are permanent.

See [`plan.md`](plan.md) for the full design (local only, gitignored).
