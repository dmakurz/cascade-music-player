import os
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional, Union
from pydantic import BaseModel

# Загрузка .env (опционально)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse, RedirectResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import httpx

import database as db
from services.listenbrainz import lb_service
from services.media import media_service
from services.library import library_service
from services import audio_cache

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("CascadeApp")
logging.getLogger("httpx").setLevel(logging.WARNING)
if os.environ.get("DEBUG"):
    logger.setLevel(logging.DEBUG)

# Конфигурация из окружения
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(",")

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Запуск сервера Cascade Music v3...")
    db.init_db()
    yield
    logger.info("Остановка сервера Cascade Music v3...")

app = FastAPI(
    title="Cascade Music Player",
    description="Плеер с метаданными Deezer и студийным аудио (YT Music/Topic)",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_credentials=False, allow_methods=["*"], allow_headers=["*"],
)

@app.get("/healthz")
async def healthz():
    try:
        with db.db_connection() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"status": "ok", "db": "up"}
    except Exception as e:
        return JSONResponse(status_code=503, content={"status": "degraded", "db": "down", "error": str(e)})

@app.get("/api/cache/stats")
async def api_cache_stats():
    import os
    total = 0
    count = 0
    d = audio_cache.CACHE_DIR
    if os.path.isdir(d):
        for name in os.listdir(d):
            if name.endswith(".bin"):
                try:
                    total += os.path.getsize(os.path.join(d, name))
                    count += 1
                except OSError:
                    pass
    return {"tracks": count, "size_bytes": total, "size_mb": round(total / (1024 * 1024), 2)}

@app.post("/api/cache/clear")
async def api_cache_clear():
    d = audio_cache.CACHE_DIR
    import os
    removed = 0
    if os.path.isdir(d):
        for name in os.listdir(d):
            if name.endswith(".bin") or name.endswith(".meta") or name.endswith(".tmp"):
                try:
                    os.remove(os.path.join(d, name))
                    removed += 1
                except OSError:
                    pass
    return {"status": "success", "removed": removed}

os.makedirs("static", exist_ok=True)
os.makedirs("music", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- МОДЕЛИ ---
class PlaylistCreate(BaseModel): name: str; description: Optional[str] = ""; cover_url: Optional[str] = ""
class PlaylistTrackAdd(BaseModel): artist: str; title: str; album: Optional[str] = ""; duration: Optional[Union[int, str]] = 0; track_id: Optional[str] = ""; cover_url: Optional[str] = ""
class FavoriteTrack(BaseModel): artist: str; title: str; album: Optional[str] = ""; duration: Optional[Union[int, str]] = 0; track_id: Optional[str] = ""; cover_url: Optional[str] = ""; mbid: Optional[str] = ""
class BlockArtistRequest(BaseModel): artist: str
class ScrobbleRequest(BaseModel): artist: str; title: str; album: Optional[str] = ""; duration: Optional[Union[int, str]] = 0; listen_type: str = "playing_now"
class SettingsUpdate(BaseModel): lb_token: Optional[str] = ""; audio_quality: Optional[str] = "high"; equalizer_preset: Optional[str] = "flat"; stream_mode: Optional[str] = "proxy"

# --- API ---
@app.get("/api/recommendations")
async def api_get_recommendations():
    token = db.get_setting("lb_token", "")
    username = await lb_service.validate_token(token) if token else None
    
    if token and username:
        tracks = await lb_service.get_user_recommendations(token, username, count=40)
        playlists = await lb_service.get_user_playlists(token, username)
        if len(tracks) < 5:
            charts = await media_service.get_charts(limit=20)
            tracks.extend(charts)
        return {"source": f"ListenBrainz ({username})", "tracks": db.filter_blocked_tracks(tracks), "playlists": playlists}
    
    charts = await media_service.get_charts(limit=40)
    return {"source": "Deezer Global Charts", "tracks": charts, "playlists": []}

@app.get("/api/explore")
async def api_explore(country: str = "US"):
    charts = await media_service.get_charts(limit=40, country=country)
    return {"tracks": charts}

@app.get("/api/search")
async def api_search(q: str = Query(...), filter: str = Query("songs"), limit: int = Query(40), offset: int = Query(0)):
    results = await media_service.search(query=q, filter_type=filter, limit=limit, offset=offset)
    return {"tracks": results, "offset": offset, "limit": limit}

@app.get("/api/artist/{artist_id}")
async def api_artist_details(artist_id: str):
    details = await media_service.get_artist_details(artist_id)
    if not details: raise HTTPException(status_code=404, detail="Артист не найден")
    return details

@app.get("/api/album/{album_id}")
async def api_album_details(album_id: str):
    details = await media_service.get_album_details(album_id)
    if not details: raise HTTPException(status_code=404, detail="Альбом не найден")
    return details

@app.get("/api/radio")
async def api_track_radio(track_id: str = "", artist: str = "", title: str = ""):
    tracks = await media_service.get_track_radio(track_id=track_id, artist=artist, title=title)
    return {"tracks": tracks}

@app.get("/api/lb_playlist/{mbid}")
async def api_lb_playlist_tracks(mbid: str):
    token = db.get_setting("lb_token", "")
    if not token:
        raise HTTPException(status_code=401, detail="ListenBrainz token не задан")
    tracks = await lb_service.get_playlist_tracks(token, mbid)
    return {"tracks": db.filter_blocked_tracks(tracks)}

@app.get("/api/lyrics")
async def api_get_lyrics(artist: str = "", title: str = "", track_id: str = ""):
    return await media_service.get_lyrics(artist=artist, title=title, track_id=track_id)

@app.get("/api/cover_proxy")
async def api_cover_proxy(url: str = ""):
    if not url or not media_service.verify_stream_url(url):
        raise HTTPException(status_code=400, detail="Невалидный URL обложки")
    try:
        fetch_headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"}
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
        if "googleusercontent.com" in host or "ytimg.com" in host or "ggpht.com" in host:
            fetch_headers["Referer"] = "https://www.youtube.com/"
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=fetch_headers) as client:
            resp = await client.get(url)
            if resp.status_code != 200 or not resp.content:
                raise HTTPException(status_code=502, detail=f"Ошибка загрузки обложки (HTTP {resp.status_code})")
            content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0]
            if not content_type.startswith("image/"):
                content_type = "image/jpeg"
            return Response(
                content=resp.content,
                media_type=content_type,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=86400",
                    "Content-Length": str(len(resp.content)),
                },
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Cover proxy error: {repr(e)}")
        raise HTTPException(status_code=502, detail="Ошибка проксирования обложки")

@app.get("/api/stream")
async def api_stream_audio(request: Request, artist: str = "", title: str = ""):
    if not artist or not title:
        raise HTTPException(status_code=400, detail="Нужны параметры artist и title")

    quality = db.get_setting("audio_quality", "high")
    cached = audio_cache.get_cached(artist, title, quality)
    if cached:
        file_size = cached["size"]
        range_header = request.headers.get("range", "")
        if range_header:
            range_spec = range_header.strip().lower()
            if range_spec.startswith("bytes="):
                range_val = range_spec[6:].split("-")
                start = int(range_val[0]) if range_val[0] else 0
                end = int(range_val[1]) if len(range_val) > 1 and range_val[1] else file_size - 1
                end = min(end, file_size - 1)
                content_length = end - start + 1

                async def iter_file_range():
                    with open(cached["path"], "rb") as f:
                        f.seek(start)
                        remaining = content_length
                        while remaining > 0:
                            chunk = f.read(min(131072, remaining))
                            if not chunk:
                                break
                            remaining -= len(chunk)
                            yield chunk

                return StreamingResponse(
                    iter_file_range(),
                    status_code=206,
                    media_type=cached["content_type"],
                    headers={
                        "Content-Range": f"bytes {start}-{end}/{file_size}",
                        "Content-Length": str(content_length),
                        "Accept-Ranges": "bytes",
                    },
                )
        return FileResponse(cached["path"], media_type=cached["content_type"], headers={"Accept-Ranges": "bytes"})

    stream_url = await media_service.resolve_stream_url(artist=artist, title=title, force_refresh=False)
    if not stream_url: raise HTTPException(status_code=404, detail="Аудиопоток не найден")

    stream_mode = db.get_setting("stream_mode", "proxy")
    if stream_mode == "direct": return RedirectResponse(url=stream_url, status_code=302)

    req_headers = {"User-Agent": request.headers.get("user-agent", "Mozilla/5.0"), "Accept": "*/*"}
    has_range = "range" in request.headers
    if has_range: req_headers["Range"] = request.headers["range"]

    query_key = f"{artist.lower().strip()}|{title.lower().strip()}"
    client = httpx.AsyncClient(timeout=15.0, follow_redirects=True)
    
    try:
        req = client.build_request("GET", stream_url, headers=req_headers)
        resp = await client.send(req, stream=True)
        if resp.status_code in (403, 404, 410):
            await resp.aclose()
            db.delete_stream_cache(query_key)
            stream_url = await media_service.resolve_stream_url(artist=artist, title=title, force_refresh=True)
            if not stream_url: raise HTTPException(status_code=404)
            req = client.build_request("GET", stream_url, headers=req_headers)
            resp = await client.send(req, stream=True)
    except HTTPException:
        await client.aclose()
        raise
    except Exception as e:
        logger.error(f"Stream error for {artist} - {title}: {repr(e)}")
        await client.aclose()
        raise HTTPException(status_code=502, detail="Ошибка соединения")

    content_type = resp.headers.get("content-type", "audio/webm")
    resp_headers = {"Accept-Ranges": "bytes", "Content-Type": content_type}
    if "content-range" in resp.headers: resp_headers["Content-Range"] = resp.headers["content-range"]
    if "content-length" in resp.headers: resp_headers["Content-Length"] = resp.headers["content-length"]

    tee = None
    if not has_range and resp.status_code == 200:
        tee = audio_cache.DiskTeeWriter(audio_cache.build_key(artist, title, quality), content_type)
        try:
            tee.open()
        except Exception:
            tee = None

    async def iter_bytes():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=131072):
                if tee is not None:
                    tee.write(chunk)
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()
            if tee is not None:
                tee.commit()

    return StreamingResponse(iter_bytes(), status_code=resp.status_code, headers=resp_headers, media_type=content_type)

# --- LOCAL LIBRARY ---
@app.get("/api/library/scan")
async def api_scan_local_library():
    count = await library_service.scan_local_music()
    return {"status": "success", "count": count}

@app.get("/api/library/tracks")
async def api_get_local_tracks(limit: int = 500, offset: int = 0):
    return {"tracks": db.get_local_tracks(limit=limit, offset=offset)}

@app.get("/api/library/track/{track_id}/stream")
async def api_stream_local_track(track_id: int):
    track = library_service.get_local_track_by_id(track_id)
    if not track or not track.get("path") or not os.path.isfile(track["path"]):
        raise HTTPException(status_code=404, detail="Локальный трек не найден")
    return FileResponse(track["path"], media_type="audio/*")

# --- PLAYLISTS & FAVORITES ---
@app.get("/api/playlists")
async def api_get_playlists(): return {"playlists": db.get_playlists()}
@app.post("/api/playlists")
async def api_create_playlist(pl: PlaylistCreate): return {"id": db.create_playlist(pl.name, pl.description, pl.cover_url)}
@app.delete("/api/playlists/{pl_id}")
async def api_delete_playlist(pl_id: int): db.delete_playlist(pl_id); return {"status": "success"}
@app.get("/api/playlists/{pl_id}/tracks")
async def api_get_playlist_tracks(pl_id: int): return {"tracks": db.get_playlist_tracks(pl_id)}
@app.post("/api/playlists/{pl_id}/tracks")
async def api_add_track_to_playlist(pl_id: int, track: PlaylistTrackAdd): return {"track_id": db.add_track_to_playlist(pl_id, track.artist, track.title, track.album, track.duration, track.track_id, track.cover_url)}
@app.delete("/api/playlists/{pl_id}/tracks/{track_id}")
async def api_remove_track_from_playlist(pl_id: int, track_id: int): db.remove_track_from_playlist(pl_id, track_id); return {"status": "success"}

@app.get("/api/favorites")
async def api_get_favorites(): return {"tracks": db.get_favorites()}
@app.post("/api/favorites")
async def api_add_favorite(track: FavoriteTrack):
    db.add_to_favorites(track.artist, track.title, track.album, track.duration, track.track_id, track.cover_url)
    if token := db.get_setting("lb_token", ""): asyncio.create_task(lb_service.submit_feedback_by_metadata(token, track.artist, track.title, 1, track.mbid))
    return {"status": "success"}
@app.delete("/api/favorites")
async def api_remove_favorite(artist: str = Query(...), title: str = Query(...)): db.remove_from_favorites(artist, title); return {"status": "success"}

@app.get("/api/dislikes")
async def api_get_dislikes(): return {"tracks": db.get_disliked_tracks()}
@app.post("/api/dislike")
async def api_add_dislike(track: FavoriteTrack):
    db.add_disliked_track(track.artist, track.title, track.track_id or "")
    if token := db.get_setting("lb_token", ""): asyncio.create_task(lb_service.submit_feedback_by_metadata(token, track.artist, track.title, -1, track.mbid))
    return {"status": "success"}
@app.delete("/api/dislike")
async def api_remove_dislike(artist: str = Query(...), title: str = Query(...)): db.remove_disliked_track(artist, title); return {"status": "success"}

@app.get("/api/blocked_artists")
async def api_get_blocked_artists(): return {"artists": db.get_blocked_artists()}
@app.post("/api/block_artist")
async def api_block_artist(req: BlockArtistRequest): db.block_artist(req.artist); return {"status": "success"}
@app.delete("/api/block_artist")
async def api_unblock_artist(artist: str = Query(...)): db.unblock_artist(artist); return {"status": "success"}

@app.get("/api/history")
async def api_get_history(): return {"tracks": db.get_history()}
@app.post("/api/history")
async def api_log_history(track: FavoriteTrack): db.log_history(track.artist, track.title, track.album, track.duration, track.track_id, track.cover_url); return {"status": "success"}

@app.post("/api/scrobble")
async def api_scrobble(req: ScrobbleRequest):
    if token := db.get_setting("lb_token", ""): await lb_service.submit_listen(token, req.artist, req.title, req.album, req.listen_type, db.parse_duration_seconds(req.duration))
    return {"status": "success"}

@app.get("/api/stats")
async def api_get_stats():
    token = db.get_setting("lb_token", "")
    if not token: return {"status": "no_token"}
    username = await lb_service.validate_token(token)
    if not username: return {"status": "invalid_token"}
    return {"status": "success", "username": username, "stats": await lb_service.get_user_stats(token, username)}

@app.get("/api/settings")
async def api_get_settings():
    settings = db.get_all_settings()
    # Маскируем токен для фронтенда (показываем только наличие и последние 4 символа)
    token = settings.get("lb_token", "")
    if token:
        settings["lb_token"] = f"{'*' * (len(token) - 4)}{token[-4:]}" if len(token) > 4 else "****"
        settings["lb_token_set"] = True
    else:
        settings["lb_token_set"] = False
    return settings
@app.post("/api/settings")
async def api_save_settings(update: SettingsUpdate):
    for k, v in update.model_dump(exclude_unset=True).items():
        if k == "lb_token" and v and v.startswith("*"):
            continue
        db.set_setting(k, v)
        if k == "lb_token" and v and not v.startswith("*"):
            lb_service._cached_user = None
            lb_service._cached_user_token = None
    return {"status": "success"}

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    with open("static/index.html", "r", encoding="utf-8") as f: return HTMLResponse(content=f.read())