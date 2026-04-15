# ReClip

A self-hosted, open-source video and audio downloader with a clean web UI. Paste links from YouTube, TikTok, Instagram, Twitter/X, and 1000+ other sites — download as MP4 or MP3.

![Python](https://img.shields.io/badge/python-3.8+-blue)
![License](https://img.shields.io/badge/license-MIT-green)

https://github.com/user-attachments/assets/419d3e50-c933-444b-8cab-a9724986ba05

![ReClip MP3 Mode](assets/preview-mp3.png)

## Features

- Download videos from 1000+ supported sites (via [yt-dlp](https://github.com/yt-dlp/yt-dlp))
- MP4 video or MP3 audio extraction
- Quality/resolution picker
- Bulk downloads — paste multiple URLs at once
- Automatic URL deduplication
- **Library** — browse files stored on the server, **Save** to your device again, or **Delete** from disk
- **Settings** — optional automatic deletion of media older than **X** days (background cleanup about every hour)
- **Browser extension** (Chrome / Brave, unpacked) — detect streams on the current tab, send URLs to ReClip, download to your device when ready
- Clean, responsive UI — no frameworks, no build step
- Backend: Python + Flask (single `app.py`); frontend: vanilla HTML/CSS/JS (single template)

## Quick Start

```bash
brew install yt-dlp ffmpeg    # or apt install ffmpeg && pip install yt-dlp
git clone https://github.com/averygan/reclip.git
cd reclip
./reclip.sh
```

Open **http://localhost:8899**.

### Docker (single container)

```bash
docker build -t reclip . && docker run -p 8899:8899 reclip
```

### Docker Compose (recommended)

Uses `docker-compose.yml` at the project root: mounts **`./downloads`** so files appear on the host next to the app.

```bash
docker compose up -d --build
```

- **Port:** set `PORT` in a `.env` file (see `.env.example`) or in your environment, default **8899**.
- **Downloads:** `./downloads` on the host is mapped to `/app/downloads` in the container.
- **Settings:** `settings.json` is created at runtime under `/app` inside the container. It is **not** persisted unless you add a volume or mount (see below). Auto-delete and other options are stored there.

## Usage

### Download tab

1. Paste one or more video URLs into the input box
2. Choose **MP4** (video) or **MP3** (audio)
3. Click **Fetch** to load video info and thumbnails
4. Select quality/resolution if available
5. Click **Download** on individual videos, or **Download All**

Completed downloads are stored on the server under **`downloads/`** (next to `app.py` when running locally, or in the mounted volume with Docker Compose). Your browser also receives a copy when you save.

### Library tab

- Lists **media files** currently on the server (`downloads/`).
- **Save** — download a copy to the device you’re using (re-download).
- **Delete** — remove a file from the server.
- **Delete all** — removes every file in the library (with confirmation).

### Settings tab

- **Auto-delete media after (days)** — set to **0** to disable. When set to a positive number, files whose modification time is older than that many days are **deleted automatically** about **once per hour** (and once when you save settings).

## Data on disk

| Path | Purpose |
|------|--------|
| `downloads/` | Downloaded media (gitignored) |
| `settings.json` | Auto-delete days and future settings (gitignored) |

## Browser extension (Chrome / Brave)

An unpacked **Manifest V3** extension lives in [`extension/`](extension/). It:

- Detects `<video>` / `<source>` URLs and common embeds (YouTube, Vimeo) in the page
- Observes network requests for likely stream URLs (`.m3u8`, `.mpd`, `.mp4`, `.webm`, …)
- Lets you choose **MP4** or **MP3**, send the current page URL (or a pasted URL) to ReClip, and **download the file** via the browser when the server job finishes
- Stores your ReClip **base URL** (e.g. `http://192.168.1.22:8899`) in `chrome.storage.sync`

### Install (developer mode)

1. Open `chrome://extensions` or `brave://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and choose the **`extension`** directory from this repository

On first open, set the server URL and click **Save**. Use **Settings** in the popup to change it later.

The Flask app sends **CORS** headers for `chrome-extension://` origins so the extension can call the API from your browser.

### Tests

```bash
pip install -r requirements-dev.txt   # or: pip install pytest
pytest test_app.py
```

## Raspberry Pi (e.g. Pi 5, Pi 4, 64-bit OS)

1. Install Docker: `curl -fsSL https://get.docker.com \| sudo sh` and add your user to the `docker` group.
2. Clone the repo and `cd` into it.
3. Run:

   ```bash
   docker compose up -d --build
   ```

4. Open `http://<pi-ip>:8899` from another device on the LAN.

**CPU / RAM:** the app is idle most of the time; peaks occur during `yt-dlp` / `ffmpeg` work. For personal use, a Pi with 4 GB RAM is usually enough; avoid many parallel downloads on 4 GB.

**Persisting `settings.json` with Docker:** if you recreate the container often, copy `settings.json` out of the container or extend `docker-compose.yml` with an extra volume. On Linux, bind-mounting a **file** requires the file to exist on the host first (e.g. `touch settings.json`) before mounting.

## Supported Sites

Anything [yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), including:

YouTube, TikTok, Instagram, Twitter/X, Reddit, Facebook, Vimeo, Twitch, Dailymotion, SoundCloud, Loom, Streamable, Pinterest, Tumblr, Threads, LinkedIn, and many more.

## Stack

- **Backend:** Python + Flask (`app.py`)
- **Frontend:** Vanilla HTML/CSS/JS (`templates/index.html`)
- **Download engine:** [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org/)
- **Dependencies:** Flask, yt-dlp (`requirements.txt`); dev tests: `requirements-dev.txt` (pytest)

## Disclaimer

This tool is intended for personal use only. Please respect copyright laws and the terms of service of the platforms you download from. The developers are not responsible for any misuse of this tool.

## License

[MIT](LICENSE)
