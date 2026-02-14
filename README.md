# reMarkable Sync

A lightweight Electron desktop application that syncs handwritten notes from a [reMarkable 2](https://remarkable.com/) tablet to your Mac over SSH. It connects directly to the device via Wi-Fi, pulls the raw note data, renders pages, and presents them in a simple viewer — no cloud subscription or third-party services required.

## How It Works

1. **SSH connection** — Connects to the reMarkable 2 over your local network using the device's built-in SSH server.
2. **Note sync** — Downloads the raw xochitl note files (metadata, stroke data, page templates) from the tablet.
3. **Local viewing** — Renders and displays synced notebook pages in a desktop window with page navigation and a folder tree.

## Tech Stack

- **Electron** — Desktop shell and UI
- **ssh2** — Node.js SSH client for device communication
- **Vanilla JS / HTML / CSS** — Renderer UI with no framework dependencies

## Disclaimer

> **This project is for educational and experimental purposes only.**
>
> It is **not intended for commercial use**. The software is provided **as-is, with absolutely no warranty or liability of any kind**, express or implied. Use it at your own risk. The authors accept no responsibility for any damage, data loss, or other issues that may arise from using this software.

## License

This project is licensed under the [MIT License](LICENSE).
