<p align="center">
  <br>
  <strong>rmSync</strong><br>
  <em>Your handwritten notes, on your Mac. No cloud required.</em>
  <br><br>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-contributing">Contributing</a>
</p>

---

rmSync connects to your e-ink tablet over Wi-Fi, pulls your notebooks via SSH, and renders them locally in a native Mac app. Zero cloud, zero subscription, zero friction.

## ⚡ Quick Start

```bash
git clone https://github.com/ciesko/remarkableSync.git
cd remarkableSync/src
npm install
npm start
```

1. Open **Settings** (⌘ ,) → enter your tablet's IP and SSH password
2. Hit **Sync** → your notebooks appear in the sidebar
3. That's it. Auto-sync keeps everything fresh every hour.

> **Requires:** Node.js 18+, npm, and SSH enabled on your tablet (Settings → Help → Copyright → SSH password).

## ✨ Features

| | |
|---|---|
| 🖊️ **Stroke-perfect rendering** | Parses v6 `.rm` binary format — pressure, tilt, pen types, highlighters, erasers |
| 📄 **PDF upload** | Drag & drop PDFs into the sidebar to send them to your tablet |
| 🔄 **Auto-sync** | Background sync every 60 min; retries in 30 min if tablet is unreachable |
| 🔍 **Trackpad zoom & pan** | Pinch-to-zoom, two-finger pan — feels native on macOS |
| 🎬 **Ink reveal** | Watch strokes animate in writing order when you open a page |
| 🌈 **Temporal gradient** | Toggle `T` to color strokes by writing order — see what changed last |
| 📐 **Grid view** | Toggle `G` to see all pages at a glance, click to jump |
| 🧘 **Focus mode** | Double-click or press `F` to dissolve all chrome |
| 🌙 **Dark mode** | Follows macOS system appearance automatically |
| 🔎 **Search** | Filter notebooks instantly from the sidebar |
| 📁 **Folder tree** | Mirrors your tablet's folder hierarchy with PDFs grouped separately |

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `←` `→` | Previous / next page |
| `F` | Toggle focus mode |
| `G` | Toggle grid view |
| `T` | Toggle temporal gradient |
| `Esc` | Exit focus mode / close settings |

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Mac                                                    │
│                                                         │
│  ┌──────────────┐    IPC     ┌───────────────────────┐  │
│  │  renderer.js  │◄────────►│      main.js           │  │
│  │  (UI, canvas) │           │  (Electron main proc)  │  │
│  └──────────────┘            └──────┬────────────────┘  │
│                                     │                    │
│                    ┌────────────────┼────────────────┐   │
│                    │                │                │   │
│              ┌─────▼─────┐  ┌──────▼──────┐  ┌─────▼─┐ │
│              │  sync.js   │  │ pdfUpload.js│  │store.js│ │
│              │  (SFTP dl) │  │ (SFTP up)   │  │(prefs) │ │
│              └─────┬──────┘  └──────┬──────┘  └───────┘ │
│                    │                │                    │
│              ┌─────▼────────────────▼──────┐             │
│              │         ssh.js              │             │
│              │   (ssh2 connection pool)     │             │
│              └─────────────┬───────────────┘             │
└────────────────────────────┼─────────────────────────────┘
                             │ SSH/SFTP over Wi-Fi
                    ┌────────▼────────┐
                    │   E-ink Tablet   │
                    │   (xochitl fs)   │
                    └─────────────────┘
```

**Data flow:** `tablet → SSH/SFTP → ~/.rmsync/ (local cache) → rmparser.js → canvas`

| Module | Role |
|---|---|
| `main.js` | Electron main process, IPC handlers, auto-sync timer |
| `renderer.js` | All UI: sidebar, canvas rendering, animations, interactions |
| `rmparser.js` | Binary parser for v6 `.rm` stroke files |
| `notes.js` | Document discovery, folder-path resolution, page enumeration |
| `sync.js` | SFTP download of notebook data |
| `pdfUpload.js` | PDF upload with safe write order and rollback |
| `ssh.js` | SSH/SFTP connection wrapper |
| `store.js` | Settings persistence with encrypted password storage |

## 🤝 Contributing

Contributions are welcome! This is a hobby project — keep it lean.

1. Fork the repo
2. Create a feature branch (`git checkout -b my-feature`)
3. Commit your changes (`git commit -m 'Add something cool'`)
4. Push and open a PR

Please keep PRs focused and small. No frameworks, no build tools — vanilla JS all the way.

## 📜 License

[MIT](LICENSE) — do whatever you want with it.

---

<details>
<summary><strong>Disclaimer & Trademark Notice</strong></summary>

This project is provided for educational and experimental purposes only.

**This project is not affiliated with, endorsed by, or sponsored by reMarkable AS.** "reMarkable" is a registered trademark of reMarkable AS. All trademarks and registered trademarks are the property of their respective owners. Any use of third-party trademarks in this project is for identification and interoperability purposes only and does not imply any association or endorsement.

The software is provided **"AS IS"** without warranty of any kind. You use it at your own risk. The authors are not liable for any damages including data loss, device issues, or corruption. You are solely responsible for backups.

</details>
