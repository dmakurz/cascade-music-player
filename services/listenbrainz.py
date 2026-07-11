import logging
import time
import httpx
from typing import List, Dict, Any, Optional
import database as db

logger = logging.getLogger("ListenBrainzService")
BASE_URL = "https://api.listenbrainz.org/1"

class ListenBrainzService:
    def __init__(self):
        self.timeout = 15.0
        self._cached_user = None
        self._cached_user_token = None

    async def validate_token(self, token: str) -> Optional[str]:
        if not token:
            return None
        if self._cached_user and self._cached_user_token == token:
            return self._cached_user
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            try:
                resp = await client.get(
                    f"{BASE_URL}/validate-token", 
                    headers={"Authorization": f"Token {token}"}
                )
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("valid"):
                        self._cached_user = data.get("user_name")
                        self._cached_user_token = token
                        return self._cached_user
                elif resp.status_code == 401:
                    logger.warning("ListenBrainz: невалидный токен (401)")
                    return None
                else:
                    logger.warning(f"ListenBrainz validate-token: HTTP {resp.status_code}")
            except Exception as e:
                logger.error(f"Ошибка валидации токена ListenBrainz: {repr(e)}")
        return None

    async def get_user_recommendations(self, token: str, username: str, count: int = 40) -> List[Dict[str, Any]]:
        if not token or not username:
            return []
        
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            try:
                url = f"{BASE_URL}/recommendation/user/{username}/recordings"
                resp = await client.get(
                    url, 
                    headers={"Authorization": f"Token {token}"},
                    params={"count": count}
                )
                if resp.status_code == 404:
                    logger.info(f"Рекомендации LB недоступны для '{username}' (нужно больше слушаний)")
                    return []
                resp.raise_for_status()
                data = resp.json()
                tracks = []
                for item in data.get("payload", {}).get("recordings", []):
                    tracks.append({
                        "artist": item.get("artist_name", "Unknown Artist"),
                        "title": item.get("recording_name", "Unknown Title"),
                        "album": item.get("release_name", ""),
                        "mbid": item.get("recording_mbid", ""),
                        "source": "listenbrainz"
                    })
                return db.filter_blocked_tracks(tracks)
            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP ошибка получения рекомендаций LB: {e.response.status_code} - {e.response.text}")
            except httpx.RequestError as e:
                logger.error(f"Сетевая ошибка получения рекомендаций LB: {repr(e)}")
            except Exception as e:
                logger.error(f"Неожиданная ошибка получения рекомендаций LB: {repr(e)}")
        return []

    async def get_user_playlists(self, token: str, username: str) -> List[Dict[str, Any]]:
        if not token or not username:
            return []
            
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            try:
                url = f"{BASE_URL}/user/{username}/playlists/createdfor"
                resp = await client.get(url, headers={"Authorization": f"Token {token}"})
                if resp.status_code == 200:
                    data = resp.json()
                    playlists = []
                    for pl in data.get("playlists", []):
                        pl_data = pl.get("playlist", {})
                        playlists.append({
                            "id": pl_data.get("identifier"),
                            "name": pl_data.get("title", "ListenBrainz Playlist"),
                            "description": pl_data.get("annotation", ""),
                            "creator": pl_data.get("creator", username),
                            "track_count": len(pl_data.get("track", []))
                        })
                    return playlists
            except Exception as e:
                logger.error(f"Ошибка получения плейлистов LB: {repr(e)}")
        return []

    async def get_playlist_tracks(self, token: str, playlist_mbid: str) -> List[Dict[str, Any]]:
        if not token or not playlist_mbid:
            return []
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            try:
                resp = await client.get(
                    f"{BASE_URL}/playlist/{playlist_mbid}",
                    headers={"Authorization": f"Token {token}"}
                )
                if resp.status_code == 200:
                    data = resp.json()
                    tracks = []
                    for item in data.get("playlist", {}).get("track", []):
                        title_field = item.get("title", "")
                        artist, title = title_field, title_field
                        if " - " in title_field:
                            artist, title = title_field.split(" - ", 1)
                        tracks.append({
                            "artist": artist.strip() or "Unknown",
                            "title": title.strip() or "Unknown",
                            "album": "",
                            "mbid": item.get("identifier", ""),
                            "cover_url": "",
                            "source": "listenbrainz"
                        })
                    return tracks
            except Exception as e:
                logger.error(f"Ошибка получения треков плейлиста LB: {repr(e)}")
        return []

    async def get_user_stats(self, token: str, username: str) -> Dict[str, Any]:
        if not token or not username:
            return {}
            
        stats = {"top_artists": [], "total_listens": 0, "recent_listens": []}
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            headers = {"Authorization": f"Token {token}"}
            try:
                resp_artists = await client.get(
                    f"{BASE_URL}/stats/user/{username}/artists",
                    headers=headers,
                    params={"range": "week", "count": 15}
                )
                if resp_artists.status_code == 200:
                    data = resp_artists.json()
                    for item in data.get("payload", {}).get("artists", []):
                        stats["top_artists"].append({
                            "artist": item.get("artist_name"),
                            "listen_count": item.get("listen_count", 0)
                        })

                resp_recent = await client.get(
                    f"{BASE_URL}/user/{username}/listens",
                    headers=headers,
                    params={"count": 20}
                )
                if resp_recent.status_code == 200:
                    data = resp_recent.json()
                    for item in data.get("payload", {}).get("listens", []):
                        meta = item.get("track_metadata", {})
                        stats["recent_listens"].append({
                            "artist": meta.get("artist_name", "Unknown"),
                            "title": meta.get("track_name", "Unknown"),
                            "album": meta.get("release_name", ""),
                            "listened_at": item.get("listened_at", 0)
                        })
                stats["recent_listens"] = db.filter_blocked_tracks(stats["recent_listens"])
            except Exception as e:
                logger.error(f"Ошибка получения статистики LB: {repr(e)}")
                
        return stats

    async def submit_listen(self, token: str, artist: str, title: str, album: str = "", listen_type: str = "playing_now", duration: int = 0) -> bool:
        if not token:
            return False
            
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            try:
                track_metadata = {
                    "artist_name": artist,
                    "track_name": title,
                }
                if album:
                    track_metadata["release_name"] = album
                if duration > 0:
                    track_metadata["additional_info"] = {"duration_ms": duration * 1000}

                payload_item = {"track_metadata": track_metadata}
                if listen_type == "single":
                    payload_item["listened_at"] = int(time.time())

                body = {
                    "listen_type": listen_type,
                    "payload": [payload_item]
                }
                
                resp = await client.post(
                    f"{BASE_URL}/submit-listens",
                    headers={
                        "Authorization": f"Token {token}",
                        "Content-Type": "application/json"
                    },
                    json=body
                )
                if resp.status_code == 200:
                    logger.info(f"Скроббл ({listen_type}) успешно отправлен: {artist} - {title} (длительность {duration}с)")
                    return True
            except Exception as e:
                logger.error(f"Ошибка отправки скроббла в LB: {repr(e)}")
        return False

    async def submit_feedback(self, token: str, recording_mbid: str, score: int) -> bool:
        if not token or not recording_mbid:
            return False
            
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            try:
                resp = await client.post(
                    f"{BASE_URL}/feedback/recording-feedback",
                    headers={
                        "Authorization": f"Token {token}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "recording_mbid": recording_mbid,
                        "score": score
                    }
                )
                if resp.status_code == 200:
                    logger.info(f"Оценка LB ({score}) успешно сохранена для MBID: {recording_mbid}")
                    return True
            except Exception as e:
                logger.error(f"Ошибка отправки feedback в LB: {repr(e)}")
        return False

    async def submit_feedback_by_metadata(self, token: str, artist: str, title: str, score: int, mbid: str = "") -> bool:
        """Отправка оценки в ListenBrainz (score=1 для лайка, -1 для дизлайка). 
        Если mbid не указан, автоматически ищет его через ListenBrainz Lookup или MusicBrainz API."""
        if not token:
            return False
            
        target_mbid = mbid
        if not target_mbid:
            async with httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers={"User-Agent": "CascadeMusicPlayer/2.5 (cascade@example.com)"}) as client:
                try:
                    # 1. Попытка через ListenBrainz Lookup
                    resp = await client.get(
                        f"{BASE_URL}/metadata/lookup/",
                        params={"artist_name": artist, "recording_name": title},
                        headers={"Authorization": f"Token {token}"}
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        target_mbid = data.get("recording_mbid")
                        if target_mbid:
                            logger.info(f"Найдено MBID через LB Lookup для '{artist} - {title}': {target_mbid}")
                except Exception as e:
                    logger.debug(f"LB lookup error: {e}")

                if not target_mbid:
                    try:
                        # 2. Попытка через MusicBrainz API
                        resp = await client.get(
                            "https://musicbrainz.org/ws/2/recording/",
                            params={"query": f'artist:"{artist}" AND recording:"{title}"', "fmt": "json", "limit": 1}
                        )
                        if resp.status_code == 200:
                            recs = resp.json().get("recordings", [])
                            if recs:
                                target_mbid = recs[0].get("id")
                                logger.info(f"Найдено MBID через MusicBrainz для '{artist} - {title}': {target_mbid}")
                    except Exception as e:
                        logger.debug(f"MB lookup error: {e}")

        if not target_mbid:
            logger.warning(f"Невозможно отправить оценку в LB для '{artist} - {title}': MBID не найден.")
            return False

        return await self.submit_feedback(token, recording_mbid=target_mbid, score=score)

lb_service = ListenBrainzService()
