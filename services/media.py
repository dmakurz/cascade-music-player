import logging
import asyncio
import re
import ipaddress
import httpx
from typing import List, Dict, Any, Optional
import yt_dlp
import database as db

logger = logging.getLogger("MediaService")

_SSRF_BLOCKED_NETS = (
    ipaddress.ip_network("100.64.0.0/10"),
)


class MediaService:
    def __init__(self):
        self.deezer_api = "https://api.deezer.com"
        self.ydl_opts = {
            "format": "bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
            "socket_timeout": 15,
            "nocheckcertificate": True,
            "ignoreerrors": False,
            "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
        }

    def _ydl_opts_for_quality(self):
        """Возвращает опции yt-dlp с учётом настройки качества"""
        quality = db.get_setting("audio_quality", "high")
        opts = dict(self.ydl_opts)
        if quality == "medium":
            # 128 kbps аудио для экономии трафика
            opts["format"] = "bestaudio[abr<=128]/bestaudio/best"
        else:
            opts["format"] = "bestaudio/best"
        return opts

    @staticmethod
    def _fmt_duration(sec) -> str:
        try:
            sec = int(sec or 0)
        except (TypeError, ValueError):
            sec = 0
        if sec <= 0:
            return "0:00"
        return f"{sec // 60}:{sec % 60:02d}"

    async def _fetch_deezer(self, endpoint: str, params: dict = None) -> dict:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True,
                                     headers={"User-Agent": "CascadeMusicPlayer/3.0"}) as client:
            for attempt in range(2):
                try:
                    resp = await client.get(f"{self.deezer_api}{endpoint}", params=params)
                    if resp.status_code == 200:
                        return resp.json()
                    logger.warning(f"Deezer API {endpoint}: HTTP {resp.status_code}")
                    if resp.status_code != 429:
                        break
                except Exception as e:
                    logger.error(f"Deezer API ошибка ({endpoint}): {repr(e)}")
                    if attempt == 0:
                        await asyncio.sleep(0.5)
        return {}

    async def get_charts(self, limit: int = 40, country: str = "") -> List[Dict[str, Any]]:
        endpoint = f"/chart/{country}/tracks" if country and country != "US" else "/chart/0/tracks"
        data = await self._fetch_deezer(endpoint, {"limit": limit})
        tracks = []
        for t in data.get("data", []):
            dur = t.get("duration", 0)
            tracks.append(
                {
                    "id": str(t.get("id")),
                    "title": t.get("title", "Unknown"),
                    "artist": t.get("artist", {}).get("name", "Unknown"),
                    "album": t.get("album", {}).get("title", ""),
                    "cover_url": t.get("album", {}).get("cover_xl", ""),
                    "duration_seconds": dur,
                    "duration": self._fmt_duration(dur),
                    "type": "track",
                }
            )
        return db.filter_blocked_tracks(tracks)

    async def search(
        self, query: str, filter_type: str = "songs", limit: int = 40, offset: int = 0
    ) -> List[Dict[str, Any]]:
        if not query.strip():
            return []

        endpoint = "/search"
        if filter_type == "artists":
            endpoint = "/search/artist"
        elif filter_type == "albums":
            endpoint = "/search/album"
        elif filter_type == "playlists":
            endpoint = "/search/playlist"

        data = await self._fetch_deezer(
            endpoint, {"q": query, "limit": limit, "index": offset}
        )
        items = []

        for item in data.get("data", []):
            if filter_type == "songs":
                dur = item.get("duration", 0)
                items.append(
                    {
                        "id": str(item.get("id")),
                        "title": item.get("title", "Unknown"),
                        "artist": item.get("artist", {}).get("name", "Unknown"),
                        "album": item.get("album", {}).get("title", ""),
                        "cover_url": item.get("album", {}).get("cover_xl", ""),
                        "duration_seconds": dur,
                        "duration": self._fmt_duration(dur),
                        "type": "track",
                    }
                )
            elif filter_type == "artists":
                items.append(
                    {
                        "id": str(item.get("id")),
                        "title": item.get("name", "Unknown"),
                        "subscribers": f"{item.get('nb_fan', 0):,} фанатов",
                        "cover_url": item.get("picture_xl", ""),
                        "type": "artist",
                    }
                )
            elif filter_type == "albums":
                items.append(
                    {
                        "id": str(item.get("id")),
                        "title": item.get("title", "Unknown"),
                        "artist": item.get("artist", {}).get("name", "Unknown"),
                        "cover_url": item.get("cover_xl", ""),
                        "type": "album",
                    }
                )

        if filter_type == "songs":
            return db.filter_blocked_tracks(items)
        return items

    async def get_artist_details(self, artist_id: str) -> Dict[str, Any]:
        artist_task = self._fetch_deezer(f"/artist/{artist_id}")
        top_task = self._fetch_deezer(f"/artist/{artist_id}/top", {"limit": 25})
        albums_task = self._fetch_deezer(f"/artist/{artist_id}/albums", {"limit": 20})

        artist, top, albums_data = await asyncio.gather(
            artist_task, top_task, albums_task
        )
        if "error" in artist or not artist:
            return {}

        top_tracks = [
            {
                "id": str(t["id"]),
                "title": t["title"],
                "artist": artist["name"],
                "album": t["album"]["title"],
                "cover_url": t["album"]["cover_xl"],
                "duration_seconds": t["duration"],
                "duration": self._fmt_duration(t["duration"]),
            }
            for t in top.get("data", [])
        ]

        albums = [
            {
                "id": str(a["id"]),
                "title": a["title"],
                "year": a.get("release_date", "")[:4],
                "cover_url": a.get("cover_xl", ""),
            }
            for a in albums_data.get("data", [])
        ]

        return {
            "name": artist.get("name", "Unknown"),
            "description": f"{artist.get('nb_fan', 0):,} фанатов на Deezer",
            "cover_url": artist.get("picture_xl", ""),
            "top_tracks": db.filter_blocked_tracks(top_tracks),
            "albums": albums,
            "singles": [],
        }

    async def get_album_details(self, album_id: str) -> Dict[str, Any]:
        album = await self._fetch_deezer(f"/album/{album_id}")
        if not album:
            return {}

        cover_url = album.get("cover_xl", "")
        artist_name = album.get("artist", {}).get("name", "Unknown")

        tracks = [
            {
                "id": str(t["id"]),
                "title": t["title"],
                "artist": t.get("artist", {}).get("name", artist_name),
                "album": album["title"],
                "cover_url": cover_url,
                "duration_seconds": t["duration"],
                "duration": self._fmt_duration(t["duration"]),
            }
            for t in album.get("tracks", {}).get("data", [])
        ]

        return {
            "title": album.get("title", "Unknown"),
            "artist": artist_name,
            "year": album.get("release_date", "")[:4],
            "cover_url": cover_url,
            "track_count": album.get("nb_tracks", 0),
            "tracks": db.filter_blocked_tracks(tracks),
        }

    async def get_track_radio(
        self, track_id: str = "", artist: str = "", title: str = ""
    ) -> List[Dict[str, Any]]:
        if not artist and track_id:
            track_info = await self._fetch_deezer(f"/track/{track_id}")
            artist = track_info.get("artist", {}).get("name", "")

        if artist:
            search = await self._fetch_deezer(
                "/search/artist", {"q": artist, "limit": 1}
            )
            if search.get("data"):
                a_id = search["data"][0]["id"]
                radio = await self._fetch_deezer(f"/artist/{a_id}/radio")
                tracks = [
                    {
                        "id": str(t["id"]),
                        "title": t["title"],
                        "artist": t.get("artist", {}).get("name", "Unknown"),
                        "album": t.get("album", {}).get("title", ""),
                        "cover_url": t.get("album", {}).get("cover_xl", ""),
                        "duration_seconds": t["duration"],
                        "duration": self._fmt_duration(t["duration"]),
                    }
                    for t in radio.get("data", [])
                ]
                return db.filter_blocked_tracks(tracks)
        return []

    async def get_lyrics(
        self, artist: str, title: str, track_id: str = ""
    ) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=8.0) as client:
            try:
                # Добавлен обязательный заголовок User-Agent для избежания 403 Forbidden от LRCLIB
                headers = {"User-Agent": "CascadeMusicPlayer/3.0 (cascade@example.com)"}
                resp = await client.get(
                    "https://lrclib.net/api/get",
                    params={"artist_name": artist, "track_name": title},
                    headers=headers
                )
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("syncedLyrics"):
                        return {"type": "synced", "lyrics": data["syncedLyrics"]}
                    if data.get("plainLyrics"):
                        return {"type": "plain", "lyrics": data["plainLyrics"]}
            except Exception as e:
                logger.debug(f"LRCLIB не нашел текст: {e}")
        return {"type": "none", "lyrics": "Текст песни не найден :(", "source": ""}

    def _is_valid_match(
        self, req_artist: str, req_title: str, yt_title: str, yt_uploader: str
    ) -> bool:
        if not req_artist and not req_title:
            return True

        def clean(s):
            return re.sub(r"[^a-zа-я0-9]", "", str(s).lower())

        c_req_tit = clean(req_title)
        c_yt_tit = clean(yt_title)
        c_yt_up = clean(yt_uploader)

        has_artist = False
        if req_artist:
            artist_parts = re.split(
                r"[,&]|feat\.?|ft\.?|vs\.?", str(req_artist), flags=re.IGNORECASE
            )
            artist_parts = [clean(p) for p in artist_parts if len(clean(p)) > 1]

            if artist_parts:
                for part in artist_parts:
                    if part in c_yt_tit or part in c_yt_up:
                        has_artist = True
                        break
            else:
                has_artist = True
        else:
            has_artist = True

        has_title = False
        if c_req_tit:
            if c_req_tit in c_yt_tit:
                has_title = True
            else:
                tit_words = [
                    clean(w) for w in str(req_title).split() if len(clean(w)) > 2
                ]
                if tit_words:
                    matches = sum(1 for w in tit_words if w in c_yt_tit)
                    has_title = (matches >= len(tit_words) / 2) or (
                        matches > 0 and len(tit_words) < 3
                    )
                else:
                    has_title = True
        else:
            has_title = True

        return has_artist and has_title

    async def resolve_stream_url(
        self, artist: str, title: str, force_refresh: bool = False
    ) -> Optional[str]:
        query_key = f"{artist.lower().strip()}|{title.lower().strip()}"

        if not force_refresh:
            cached_url = db.get_stream_cache(query_key)
            if cached_url:
                return cached_url
        else:
            db.delete_stream_cache(query_key)

        def _extract_stream():
            url = None
            clean_query = f"{artist} {title}".replace('"', "").strip()
            ydl_opts = self._ydl_opts_for_quality()

            # Все 3 варианта поиска запускаются последовательно, но с ранним выходом при успехе
            search_variants = [f"ytsearch5:{clean_query} song", f"ytsearch5:{clean_query} Topic", f"ytsearch5:{clean_query} audio"]
            for target_url in search_variants:
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(target_url, download=False)
                        for entry in info.get("entries", []):
                            if entry and self._is_valid_match(
                                artist,
                                title,
                                entry.get("title"),
                                entry.get("uploader") or entry.get("channel"),
                            ):
                                url = entry.get("url")
                                break
                    if url:
                        break
                except Exception as e:
                    logger.warning(f"Ошибка поиска YT ({target_url}): {e}")

            if url:
                if not self.verify_stream_url(url):
                    logger.warning(f"Невалидный/небезопасный URL стрима отклонён: {url}")
                    return None
                db.set_stream_cache(query_key, url, ttl_seconds=14400)
                return url

            return None

        return await asyncio.to_thread(_extract_stream)

    def verify_stream_url(self, url: str) -> bool:
        if not url or not url.startswith(("http://", "https://")):
            return False
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            host = parsed.hostname or ""
            if not host:
                return False
            try:
                ip = ipaddress.ip_address(host)
                if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                    return False
                if any(ip in net for net in _SSRF_BLOCKED_NETS):
                    return False
                mapped = getattr(ip, "ipv4_mapped", None)
                if mapped is not None:
                    if mapped.is_private or mapped.is_loopback or mapped.is_link_local or mapped.is_reserved or mapped.is_multicast or mapped.is_unspecified:
                        return False
                    if any(mapped in net for net in _SSRF_BLOCKED_NETS):
                        return False
            except ValueError:
                lowered = host.lower().strip(".")
                if lowered in ("localhost",) or lowered.endswith(".localhost"):
                    return False
            return True
        except Exception:
            return False

media_service = MediaService()