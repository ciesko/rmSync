# rmSync

**Your handwritten notes, on your Mac. No cloud required.**

rmSync connects to your e-ink tablet over Wi-Fi, pulls your notebooks via SSH, and renders them in a native desktop app. No subscriptions, no cloud accounts, no friction — just your notes, locally.

---

## Get Started

**Prerequisites:** [Node.js](https://nodejs.org/) 18+ and SSH enabled on your tablet.

```bash
git clone https://github.com/ciesko/rmSync.git
cd rmSync/src
npm install
npm start
```

On first launch:

1. Click **Settings** → enter your tablet's IP (`10.11.99.1` by default) and SSH password
2. Click **Sync**
3. Your notebooks appear. That's it.

> 💡 **Where's the SSH password?** On your tablet: *Settings → Help → Copyrights and licenses* — scroll to the bottom.

After the first sync, rmSync auto-syncs every hour in the background. If your tablet isn't reachable, it quietly retries later.

## What You Get

🖊️ **Pixel-perfect note rendering** — pressure, tilt, all pen types, highlighters, erasers. Parsed directly from the v6 binary format.

📄 **PDF upload** — drag PDFs into the sidebar to send them to your tablet.

🔍 **Trackpad zoom & pan** — pinch-to-zoom and two-finger scroll, native macOS feel.

🎬 **Ink reveal** — strokes animate in writing order when you open a page. See how your notes were written.

🌈 **Temporal gradient** — press `T` to color strokes by writing order. Instantly spot what was added last.

📐 **Grid view** — press `G` to see every page at a glance. Click any thumbnail to jump there.

🧘 **Focus mode** — press `F` or double-click to dissolve all UI chrome and just see your writing.

🌙 **Dark mode** — follows your macOS system appearance.

### Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` | Previous / next page |
| `F` | Focus mode |
| `G` | Grid view |
| `T` | Temporal gradient |
| `Esc` | Exit focus / close settings |

## How It Works

```
  Your tablet                         Your Mac
 ┌───────────┐    SSH / SFTP    ┌────────────────┐
 │  xochitl   │ ──────────────▶ │  local cache    │
 │  (notes)   │   over Wi-Fi    │  (~/.rmsync/)   │
 └───────────┘                  └───────┬────────┘
                                        │ parse .rm binaries
                                        ▼
                                ┌────────────────┐
                                │  rmSync app     │
                                │  (Electron)     │
                                └────────────────┘
```

Everything stays on your local network. Notes are cached in `~/.rmsync/` so you can browse them offline.

## Contributing

Contributions welcome — keep them lean. No frameworks, no build tools, vanilla JS.

1. Fork → branch → commit → PR.
2. See [README-CONCEPTS.md](README-CONCEPTS.md) for technical background on the device filesystem, binary format, and sync approaches.

## License

[MIT](LICENSE)

---

<sub>
This project is not affiliated with, endorsed by, or sponsored by reMarkable AS. "reMarkable" is a registered trademark of reMarkable AS. All trademarks are property of their respective owners. Software provided "as is" without warranty. You are responsible for your own backups.
</sub>
