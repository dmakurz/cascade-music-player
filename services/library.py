import os
import logging
import asyncio
from mutagen.easyid3 import EasyID3
from mutagen.mp3 import MP3
from mutagen.flac import FLAC
from mutagen import File as MutagenFile
import database as db

logger = logging.getLogger("LibraryService")
MUSIC_DIR = "./music"

class LibraryService:
    def __init__(self):
        os.makedirs(MUSIC_DIR, exist_ok=True)

    async def scan_local_music(self) -> int:
        """Асинхронное сканирование локальной директории и индексация треков в базе данных"""
        def _scan():
            db.clear_local_tracks()
            count = 0
            for root, _, files in os.walk(MUSIC_DIR):
                for file in files:
                    if file.lower().endswith((".mp3", ".flac", ".ogg", ".m4a", ".wav")):
                        path = os.path.join(root, file)
                        try:
                            audio = MutagenFile(path, easy=True)
                            if audio is None:
                                continue
                            
                            artist = audio.get('artist', ['Unknown Artist'])[0]
                            title = audio.get('title', [os.path.splitext(file)[0]])[0]
                            album = audio.get('album', ['Local Album'])[0]
                            
                            # Попытка узнать длительность
                            duration = 0
                            if hasattr(audio, 'info') and hasattr(audio.info, 'length'):
                                duration = int(audio.info.length)
                            elif isinstance(audio, MP3) and audio.info:
                                duration = int(audio.info.length)

                            db.save_local_track(
                                artist=artist,
                                title=title,
                                album=album,
                                duration=duration,
                                path=path
                            )
                            count += 1
                        except Exception as e:
                            logger.debug(f"Не удалось распарсить метаданные {file}: {e}")
            logger.info(f"Сканирование завершено. Найдено локальных треков: {count}")
            return count

        return await asyncio.to_thread(_scan)

    def get_local_track_by_id(self, track_id: int):
        return db.get_local_track_by_id(track_id)

library_service = LibraryService()
