"""
Cascade Music Player - Polished Enterprise Edition
==================================================
Главный файл запуска приложения.
Запуск: python cascade_music_app.py
"""

import os
import uvicorn
from app import app

if __name__ == "__main__":
    print("\n" + "="*65)
    print(" 🚀 CASCADE MUSIC v3.0 — ПОЛНОФУНКЦИОНАЛЬНЫЙ МУЗЫКАЛЬНЫЙ СЕРВИС ")
    print("    Интеграция ListenBrainz • YouTube Music • Web Audio API Eq   ")
    print("="*65)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    print(f" 👉 Откройте браузер по адресу: http://{host}:{port}")
    print("="*65 + "\n")
    uvicorn.run("app:app", host=host, port=port, reload=False, log_level="info")
