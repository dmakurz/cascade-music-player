import os
import time
import hashlib
import logging
from typing import Optional

logger = logging.getLogger("AudioCache")

CACHE_DIR = os.environ.get("AUDIO_CACHE_DIR", "audio_cache")
MAX_CACHE_BYTES = int(os.environ.get("AUDIO_CACHE_MAX_MB", "500")) * 1024 * 1024


def _ensure_dir():
    os.makedirs(CACHE_DIR, exist_ok=True)


def _key_hash(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


def _meta_path(h: str) -> str:
    return os.path.join(CACHE_DIR, f"{h}.meta")


def _data_path(h: str) -> str:
    return os.path.join(CACHE_DIR, f"{h}.bin")


def build_key(artist: str, title: str, quality: str = "") -> str:
    return f"{artist.lower().strip()}|{title.lower().strip()}|{quality or 'high'}"


def get_cached(artist: str, title: str, quality: str = "") -> Optional[dict]:
    _ensure_dir()
    h = _key_hash(build_key(artist, title, quality))
    data = _data_path(h)
    meta = _meta_path(h)
    if not (os.path.isfile(data) and os.path.isfile(meta)):
        return None
    try:
        with open(meta, "r", encoding="utf-8") as f:
            content_type = f.read().strip() or "audio/webm"
    except Exception:
        content_type = "audio/webm"
    os.utime(data, None)
    return {"path": data, "content_type": content_type, "size": os.path.getsize(data)}


def prune_cache(max_bytes: int = MAX_CACHE_BYTES):
    try:
        files = []
        for name in os.listdir(CACHE_DIR):
            if not name.endswith(".bin"):
                continue
            p = os.path.join(CACHE_DIR, name)
            try:
                st = os.stat(p)
                files.append((p, st.st_mtime, st.st_size))
            except OSError:
                continue
        total = sum(f[2] for f in files)
        if total <= max_bytes:
            return
        files.sort(key=lambda x: x[1])
        for path, _, size in files:
            if total <= max_bytes:
                break
            try:
                os.remove(path)
                meta = path[:-4] + ".meta"
                if os.path.isfile(meta):
                    os.remove(meta)
                total -= size
            except OSError:
                continue
    except Exception as e:
        logger.debug(f"prune error: {e}")


class DiskTeeWriter:
    def __init__(self, key: str, content_type: str):
        self.h = _key_hash(key)
        self.content_type = content_type or "audio/webm"
        self.tmp_path = os.path.join(CACHE_DIR, f"{self.h}.tmp")
        self.data_path = _data_path(self.h)
        self.meta_path = _meta_path(self.h)
        self.fh = None
        self.bytes_written = 0
        self.aborted = False

    def open(self):
        _ensure_dir()
        self.fh = open(self.tmp_path, "wb")

    def write(self, chunk: bytes):
        if self.aborted or self.fh is None:
            return
        try:
            self.fh.write(chunk)
            self.bytes_written += len(chunk)
        except Exception:
            self.aborted = True

    def commit(self):
        if self.fh is None:
            return
        try:
            self.fh.close()
        except Exception:
            pass
        self.fh = None
        if self.aborted or self.bytes_written == 0:
            try:
                os.remove(self.tmp_path)
            except OSError:
                pass
            return
        try:
            os.replace(self.tmp_path, self.data_path)
            with open(self.meta_path, "w", encoding="utf-8") as m:
                m.write(self.content_type)
            os.utime(self.data_path, None)
            prune_cache()
        except Exception as e:
            logger.debug(f"commit error: {e}")
            try:
                os.remove(self.tmp_path)
            except OSError:
                pass

    def cancel(self):
        self.aborted = True
        if self.fh is not None:
            try:
                self.fh.close()
            except Exception:
                pass
            self.fh = None
        try:
            os.remove(self.tmp_path)
        except OSError:
            pass
