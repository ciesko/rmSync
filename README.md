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

This project is provided for educational and experimental purposes.

To the maximum extent permitted by applicable law:

- The software is provided **"AS IS" and "AS AVAILABLE"**, without warranties or conditions of any kind, express or implied.
- The authors and contributors disclaim all warranties, including (without limitation) merchantability, fitness for a particular purpose, non-infringement, reliability, security, and accuracy.
- You use this software entirely at your own risk.
- The authors and contributors are **not liable** for any claim, damages, or other liability, whether direct, indirect, incidental, special, exemplary, consequential, or punitive, including (without limitation) data loss, data corruption, device issues, downtime, business interruption, lost profits, or third-party claims.
- You are solely responsible for backups, recovery planning, and validating results before relying on them.

No support, maintenance, uptime, or compatibility guarantees are provided.

If this disclaimer conflicts with any mandatory law in your jurisdiction, only the minimum portion necessary is limited, and the remainder continues to apply.

## License

This project is licensed under the [MIT License](LICENSE).
