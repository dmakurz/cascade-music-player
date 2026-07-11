import os
import sqlite3
import time
import logging
from contextlib import contextmanager
from typing import List, Dict, Any, Optional, Set, Union

logger = logging.getLogger("CascadeDatabase")
DB_PATH = "music_app.db"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

@contextmanager
def db_connection():
    conn = get_db()
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = get_db()
    c = conn.cursor()
    
    c.execute('''CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, 
        value TEXT
    )''')
    
    # Плейлисты
    c.execute('''CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        cover_url TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS playlist_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER,
        track_artist TEXT,
        track_title TEXT,
        track_album TEXT,
        track_duration INTEGER DEFAULT 0,
        video_id TEXT,
        cover_url TEXT,
        position INTEGER DEFAULT 0,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    )''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT,
        title TEXT,
        album TEXT,
        duration INTEGER DEFAULT 0,
        video_id TEXT,
        cover_url TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(artist, title)
    )''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS disliked_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT,
        title TEXT,
        video_id TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(artist, title)
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS blocked_artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT UNIQUE,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT,
        title TEXT,
        album TEXT,
        duration INTEGER DEFAULT 0,
        video_id TEXT,
        cover_url TEXT,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS stream_cache (
        query_key TEXT PRIMARY KEY,
        stream_url TEXT,
        expires_at INTEGER
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS local_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT,
        title TEXT,
        album TEXT,
        duration INTEGER DEFAULT 0,
        path TEXT UNIQUE,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    conn.commit()
    conn.close()

# Инициализация при импорте модуля (один раз)
try:
    init_db()
except Exception as e:
    logger.warning(f"Auto init_db note: {e}")

# --- HELPERS ---
def parse_duration_seconds(val: Any) -> int:
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        return int(val)
    if isinstance(val, str):
        val = val.strip()
        if ":" in val:
            parts = val.split(":")
            try:
                if len(parts) == 2:
                    return int(parts[0]) * 60 + int(parts[1])
                elif len(parts) == 3:
                    return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
            except:
                pass
        elif val.isdigit():
            return int(val)
    return 0

def format_track_duration(dur: Any) -> str:
    if isinstance(dur, str) and ":" in dur:
        return dur
    sec = parse_duration_seconds(dur)
    if sec <= 0:
        return ""
    return f"{sec // 60}:{sec % 60:02d}"

def _enrich_track(d: Dict[str, Any], dur_field: str = "duration") -> Dict[str, Any]:
    sec = parse_duration_seconds(d.get(dur_field, 0))
    d["duration_seconds"] = sec
    d["duration"] = format_track_duration(sec)
    return d

# --- SETTINGS ---
def get_setting(key: str, default: Any = None) -> Optional[str]:
    with db_connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default

def set_setting(key: str, value: str):
    with db_connection() as conn:
        conn.execute("REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
        conn.commit()

def get_all_settings() -> Dict[str, str]:
    with db_connection() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {row["key"]: row["value"] for row in rows}

# --- STREAM CACHE ---
def get_stream_cache(query_key: str) -> Optional[str]:
    now = int(time.time())
    with db_connection() as conn:
        row = conn.execute("SELECT stream_url FROM stream_cache WHERE query_key=? AND expires_at > ?", (query_key, now)).fetchone()
    return row["stream_url"] if row else None

def set_stream_cache(query_key: str, stream_url: str, ttl_seconds: int = 14400):
    expires_at = int(time.time()) + ttl_seconds
    with db_connection() as conn:
        conn.execute("REPLACE INTO stream_cache (query_key, stream_url, expires_at) VALUES (?, ?, ?)",
                     (query_key, stream_url, expires_at))
        conn.commit()

def delete_stream_cache(query_key: str):
    with db_connection() as conn:
        conn.execute("DELETE FROM stream_cache WHERE query_key=?", (query_key,))
        conn.commit()

# --- FAVORITES ---
def add_to_favorites(artist: str, title: str, album: str = "", duration: Any = 0, video_id: str = "", cover_url: str = "") -> bool:
    remove_disliked_track(artist, title)
    dur_int = parse_duration_seconds(duration)
    try:
        with db_connection() as conn:
            conn.execute('''INSERT OR IGNORE INTO favorites (artist, title, album, duration, video_id, cover_url, added_at) 
                     VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))''',
                      (artist, title, album, dur_int, video_id, cover_url))
            conn.commit()
        return True
    except Exception as e:
        logger.error(f"Error adding favorite: {e}")
        return False

def remove_from_favorites(artist: str, title: str) -> bool:
    with db_connection() as conn:
        conn.execute("DELETE FROM favorites WHERE artist=? AND title=?", (artist, title))
        conn.commit()
    return True

def is_favorite(artist: str, title: str) -> bool:
    with db_connection() as conn:
        row = conn.execute("SELECT id FROM favorites WHERE artist=? AND title=?", (artist, title)).fetchone()
    return row is not None

def get_favorites(limit: int = 200, offset: int = 0) -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM favorites ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    items = []
    for row in rows:
        d = dict(row)
        _enrich_track(d)
        items.append(d)
    return filter_blocked_tracks(items)

# --- DISLIKED TRACKS (💔) ---
def add_disliked_track(artist: str, title: str, video_id: str = "") -> bool:
    remove_from_favorites(artist, title)
    try:
        with db_connection() as conn:
            conn.execute('''INSERT OR IGNORE INTO disliked_tracks (artist, title, video_id, added_at) 
                     VALUES (?, ?, ?, datetime('now', 'localtime'))''', (artist, title, video_id))
            conn.commit()
        return True
    except Exception as e:
        logger.error(f"Error adding dislike: {e}")
        return False

def remove_disliked_track(artist: str, title: str):
    with db_connection() as conn:
        conn.execute("DELETE FROM disliked_tracks WHERE artist=? AND title=?", (artist, title))
        conn.commit()

def get_disliked_tracks() -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM disliked_tracks ORDER BY id DESC").fetchall()
    return [dict(row) for row in rows]

def get_disliked_keys() -> Set[str]:
    tracks = get_disliked_tracks()
    return {f"{t['artist'].lower().strip()}|{t['title'].lower().strip()}" for t in tracks}

# --- BLOCKED ARTISTS (🚫) ---
def block_artist(artist: str) -> bool:
    if not artist or not artist.strip():
        return False
    try:
        with db_connection() as conn:
            conn.execute("INSERT OR IGNORE INTO blocked_artists (artist, added_at) VALUES (?, datetime('now', 'localtime'))",
                          (artist.strip(),))
            conn.commit()
        return True
    except Exception as e:
        logger.error(f"Error blocking artist: {e}")
        return False

def unblock_artist(artist: str):
    with db_connection() as conn:
        conn.execute("DELETE FROM blocked_artists WHERE LOWER(artist)=?", (artist.lower().strip(),))
        conn.commit()

def get_blocked_artists() -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM blocked_artists ORDER BY artist ASC").fetchall()
    return [dict(row) for row in rows]

def get_blocked_artists_set() -> Set[str]:
    artists = get_blocked_artists()
    return {a["artist"].lower().strip() for a in artists}

# --- FILTER BLOCKED HELPERS ---
def filter_blocked_tracks(tracks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not tracks:
        return []
    blocked_artists = get_blocked_artists_set()
    disliked_keys = get_disliked_keys()
    
    filtered = []
    for t in tracks:
        artist_str = t.get("artist", "").lower().strip()
        title_str = t.get("title", "").lower().strip()
        
        is_blocked = False
        for b_art in blocked_artists:
            # Точное совпадение имени исполнителя (без подстрок, чтобы не блокировать лишнее)
            if artist_str == b_art:
                is_blocked = True
                break
        if is_blocked:
            continue
            
        if f"{artist_str}|{title_str}" in disliked_keys:
            continue
            
        filtered.append(t)
    return filtered

# --- HISTORY ---
def log_history(artist: str, title: str, album: str = "", duration: Any = 0, video_id: str = "", cover_url: str = ""):
    if not filter_blocked_tracks([{"artist": artist, "title": title}]):
        return
    dur_int = parse_duration_seconds(duration)
    with db_connection() as conn:
        conn.execute('''INSERT INTO history (artist, title, album, duration, video_id, cover_url, played_at)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))''',
               (artist, title, album, dur_int, video_id, cover_url))
        conn.execute("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 200)")
        conn.commit()

def get_history(limit: int = 50) -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM history ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    items = []
    for row in rows:
        d = dict(row)
        _enrich_track(d)
        items.append(d)
    return filter_blocked_tracks(items)

# --- PLAYLISTS ---
def create_playlist(name: str, description: str = "", cover_url: str = "") -> int:
    with db_connection() as conn:
        cur = conn.execute("INSERT INTO playlists (name, description, cover_url) VALUES (?, ?, ?)",
                           (name, description, cover_url))
        playlist_id = cur.lastrowid
        conn.commit()
    return playlist_id

def delete_playlist(playlist_id: int):
    with db_connection() as conn:
        conn.execute("DELETE FROM playlists WHERE id=?", (playlist_id,))
        conn.commit()

def get_playlists() -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute('''SELECT p.*, COUNT(pt.id) as track_count 
                 FROM playlists p 
                 LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id 
                 GROUP BY p.id ORDER BY p.id DESC''').fetchall()
    return [dict(row) for row in rows]

def get_playlist_tracks(playlist_id: int) -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM playlist_tracks WHERE playlist_id=? ORDER BY position ASC, id ASC", (playlist_id,)).fetchall()
    items = []
    for row in rows:
        d = dict(row)
        _enrich_track(d, dur_field="track_duration")
        items.append(d)
    return filter_blocked_tracks(items)

def add_track_to_playlist(playlist_id: int, artist: str, title: str, album: str = "", duration: Any = 0, video_id: str = "", cover_url: str = "") -> int:
    dur_int = parse_duration_seconds(duration)
    with db_connection() as conn:
        row = conn.execute("SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id=?", (playlist_id,)).fetchone()
        next_pos = (row["max_pos"] or 0) + 1
        cur = conn.execute('''INSERT INTO playlist_tracks (playlist_id, track_artist, track_title, track_album, track_duration, video_id, cover_url, position)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                 (playlist_id, artist, title, album, dur_int, video_id, cover_url, next_pos))
        track_id = cur.lastrowid
        if cover_url:
            conn.execute("UPDATE playlists SET cover_url=? WHERE id=? AND (cover_url='' OR cover_url IS NULL)", (cover_url, playlist_id))
        conn.commit()
    return track_id

def remove_track_from_playlist(playlist_id: int, track_id: int):
    with db_connection() as conn:
        conn.execute("DELETE FROM playlist_tracks WHERE id=? AND playlist_id=?", (track_id, playlist_id))
        conn.commit()

# --- LOCAL TRACKS ---
def clear_local_tracks():
    with db_connection() as conn:
        conn.execute("DELETE FROM local_tracks")
        conn.commit()

def save_local_track(artist: str, title: str, album: str = "", duration: int = 0, path: str = "") -> int:
    with db_connection() as conn:
        cur = conn.execute('''INSERT OR REPLACE INTO local_tracks (artist, title, album, duration, path)
                 VALUES (?, ?, ?, ?, ?)''', (artist, title, album, int(duration), path))
        track_id = cur.lastrowid
        conn.commit()
    return track_id

def get_local_tracks(limit: int = 500, offset: int = 0) -> List[Dict[str, Any]]:
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM local_tracks ORDER BY artist ASC, title ASC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    items = []
    for row in rows:
        d = dict(row)
        _enrich_track(d)
        d["type"] = "local"
        items.append(d)
    return items

def get_local_track_by_id(track_id: int) -> Optional[Dict[str, Any]]:
    with db_connection() as conn:
        row = conn.execute("SELECT * FROM local_tracks WHERE id=?", (track_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    _enrich_track(d)
    d["type"] = "local"
    return d