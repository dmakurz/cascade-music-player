# Cascade Music Player

A self-hosted, full-featured music streaming web app with Deezer metadata, YouTube Music audio streaming via yt-dlp, ListenBrainz scrobbling, synchronized lyrics (karaoke mode), a local media library, and a 10-band equalizer.

Built as a single-user personal music service with a responsive, dark/light UI and installable PWA support.

## Features

**Discovery & metadata**
- Track, artist, and album search via the Deezer API
- Artist and album detail pages with top tracks and discographies
- Personal recommendations powered by ListenBrainz
- Global charts and track radio

**Audio**
- Streaming via yt-dlp (YouTube Music / "Topic" sources), with quality switching (high / medium)
- Smart proxy mode (SSRF-protected) or direct CDN redirect
- Disk cache for played streams (LRU eviction, configurable size)
- Crossfade and gapless playback using dual `<audio>` elements and Web Audio API gain ramps
- 10-band equalizer with presets (Flat, Bass Boost, Electronic, Rock, Pop)

**ListenBrainz integration**
- Token-based authentication (validated and cached)
- "Playing now" and "single" scrobble submission
- Love / hate feedback with automatic MBID lookup (ListenBrainz + MusicBrainz)
- Personal recommendations and auto-playlists
- Listening stats (top artists, recent listens)

**Library & collections**
- Playlists (create, edit, add/remove tracks)
- Favorites and dislikes (mutually exclusive)
- Blocked artists (filtered from all API responses, exact match)
- Play history (last 200)
- Local media library — scan a folder for MP3, FLAC, OGG, M4A, WAV files and stream them directly

**Karaoke & lyrics**
- Synced lyrics from LRCLIB with auto-scroll and click-to-seek
- Plain lyrics fallback
- Fullscreen now-playing view with cover, dynamic ambient glow derived from the cover art, and a live audio visualizer
- Cover-art proxy endpoint (solves CORS for color extraction and loads YouTube-hosted covers)

**UX**
- Dark / light theme (persisted, `Alt+T` toggle)
- Sleep timer (15 / 30 / 60 min)
- Keyboard shortcuts
- Toast notifications
- Mobile bottom navigation
- Installable PWA with a service worker (offline-cached shell, network-first streams)

## Tech stack

- **Backend:** Python 3.12+, FastAPI, uvicorn, httpx
- **Streaming:** yt-dlp (YouTube Music)
- **Metadata:** Deezer API, LRCLIB (lyrics), MusicBrainz (MBID lookup)
- **Audio metadata:** mutagen
- **Database:** SQLite (one connection per query via a context manager)
- **Frontend:** Vanilla JS (single file), Tailwind CSS (CDN), lucide icons, Web Audio API
- **PWA:** Web manifest + service worker

## Prerequisites

- Python 3.12 or newer
- `ffmpeg` installed and on `PATH` (required by yt-dlp for some formats)
- An active internet connection (for streaming and metadata)

## Installation

```bash
git clone https://github.com/dmakurz/cascade-music-player.git
cd cascade_music_v2
mkdir music
python -m venv venv
source venv/bin/activate    # Linux/macOS
# venv\Scripts\activate     # Windows
pip install -r requirements.txt
```

## Running

```bash
python cascade_music_app.py
```

By default the server starts at `http://127.0.0.1:8000`. Open it in your browser.

To listen on all interfaces (e.g. on a home server), set `HOST=0.0.0.0`.

## Configuration

Settings such as the ListenBrainz token, audio quality, equalizer preset, and stream mode are managed in-app (Settings tab) and persisted in the SQLite database. The following environment variables are optional:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address for the server |
| `PORT` | `8000` | Port for the server |
| `ALLOWED_ORIGINS` | `http://localhost:8000,http://127.0.0.1:8000` | Comma-separated CORS allowlist |
| `DEBUG` | unset | If set, enables debug-level logging |
| `AUDIO_CACHE_DIR` | `audio_cache` | Directory for the on-disk stream cache |
| `AUDIO_CACHE_MAX_MB` | `500` | Max size of the audio cache in MB (LRU eviction) |

## ListenBrainz

To enable scrobbling, recommendations, and stats:

1. Create a free account at [listenbrainz.org](https://listenbrainz.org)
2. Generate an API token in your profile settings
3. Open the **Settings** tab in Cascade and paste the token

The token is stored locally in SQLite and never exposed in API responses (masked on return).

## Local media library

1. Put audio files in the `music/` directory (supports MP3, FLAC, OGG, M4A, WAV)
2. Open **Settings → Local library** and click **Scan**
3. Tracks appear under **Library → Local** and can be streamed directly from disk

Metadata (artist, title, album, duration) is read from file tags via mutagen.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `→` / `←` | Seek ±5 seconds |
| `Shift+→` / `Shift+←` | Next / previous track |
| `M` | Mute / unmute |
| `F` | Toggle fullscreen now-playing view |
| `L` | Like / unlike current track |
| `Alt+T` | Toggle dark / light theme |
| `Esc` | Close any open modal |

## API overview

All endpoints are prefixed with `/api` and return JSON unless noted.

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Health check (DB ping) |
| GET | `/api/recommendations` | Personal mix + charts |
| GET | `/api/explore` | Charts by country |
| GET | `/api/search` | Search tracks / artists / albums / playlists |
| GET | `/api/artist/{id}` | Artist details |
| GET | `/api/album/{id}` | Album details with tracklist |
| GET | `/api/radio` | Track radio |
| GET | `/api/lyrics` | Synced / plain lyrics |
| GET | `/api/stream` | Proxied audio stream (YouTube) |
| GET | `/api/cover_proxy` | Proxied cover image (CORS-safe) |
| GET | `/api/library/scan` | Scan local `music/` folder |
| GET | `/api/library/tracks` | List local tracks |
| GET | `/api/library/track/{id}/stream` | Stream a local track file |
| GET/POST/DELETE | `/api/playlists[...]` | Playlist CRUD |
| GET/POST/DELETE | `/api/favorites` | Favorites |
| POST/DELETE | `/api/dislike` | Dislike (hate) a track |
| GET/POST/DELETE | `/api/blocked_artists` | Blocked artists |
| GET/POST | `/api/history` | Play history |
| POST | `/api/scrobble` | Submit a listen to ListenBrainz |
| GET | `/api/stats` | ListenBrainz listening stats |
| GET/POST | `/api/settings` | App settings (token masked) |
| GET/POST | `/api/cache/stats`, `/api/cache/clear` | Audio cache management |
| GET | `/api/lb_playlist/{mbid}` | Tracks of a ListenBrainz playlist |

## Project structure

```
.
├── app.py                    # FastAPI app and API endpoints
├── database.py               # SQLite layer (settings, playlists, favorites, history, cache)
├── cascade_music_app.py      # Entrypoint (uvicorn launcher)
├── requirements.txt
├── .env.example
├── services/
│   ├── media.py              # Deezer API + yt-dlp streaming + SSRF guard
│   ├── listenbrainz.py       # Scrobbling, recommendations, feedback, stats
│   ├── library.py            # Local music scanning (mutagen)
│   └── audio_cache.py        # On-disk LRU audio cache
├── static/
│   ├── index.html            # App shell
│   ├── css/style.css         # Theme tokens, components, animations
│   ├── js/app.js             # All frontend logic (player, queue, UI)
│   ├── sw.js                 # Service worker (PWA)
│   └── manifest.json         # Web app manifest
└── music/                    # Local audio files (gitignored)
```

## Notes

- The app is designed for a single user; there is no authentication layer. Bind to `127.0.0.1` (the default) unless you know what you're doing.
- Stream URLs from yt-dlp are validated against an SSRF allowlist (private/loopback/CGNAT/link-local/IPv4-mapped IPv6 blocked) before being proxied.
- The ListenBrainz token is masked in API responses and never returned in plaintext after being stored.
- YouTube stream URLs are cached in SQLite for 4 hours; the on-disk audio cache is separate and managed via LRU.
