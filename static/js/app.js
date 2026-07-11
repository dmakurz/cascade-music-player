/**
 * Cascade Music Player - v3.0 (Deezer Metadata & Studio Audio Streaming)
 * + Gapless Playback, Crossfade & Smart Preloading
 * + Improved UI, Animations & Karaoke Mode
 */

const state = {
    currentTrack: null,
    playQueue: [],
    queueIndex: -1,
    shuffleMode: false,
    repeatMode: 0,
    favorites: new Set(),
    dislikes: new Set(),
    blockedArtists: new Set(),
    playlists: [],
    settings: { lb_token: '', audio_quality: 'high', equalizer_preset: 'flat', stream_mode: 'proxy' },
    syncedLyrics: [],
    scrobbleSubmitted: false,
    audioContext: null,
    analyser: null,
    eqFilters: [],
    isVisualizerRunning: false,
    
    searchQuery: '', searchFilter: 'songs', searchOffset: 0, searchLimit: 40,
    searchLoading: false, searchHasMore: true,

    trackStartTime: 0, consecutiveErrors: 0, isSwitchingTrack: false,
    
    isCrossfading: false,
    isPreloaded: false,
    preloadedIndex: undefined,
    nextShuffleIndex: undefined,
    
    beatPulse: 0
};

// --- DUAL PLAYER SETUP ---
const player1 = document.getElementById('audio-player');
const player2 = new Audio();
player1.crossOrigin = 'anonymous';
player2.crossOrigin = 'anonymous';
player2.className = 'hidden';

let activePlayer = player1;
let inactivePlayer = player2;
let gain1 = null;
let gain2 = null;

window.audioProxy = new Proxy({}, {
    get: (target, prop) => {
        if (prop === 'muted') return player1.muted;
        const val = activePlayer[prop];
        return typeof val === 'function' ? val.bind(activePlayer) : val;
    },
    set: (target, prop, value) => {
        if (prop === 'muted') {
            player1.muted = value;
            player2.muted = value;
            return true;
        }
        activePlayer[prop] = value;
        return true;
    }
});
window.audio = window.audioProxy;

const volBar = document.getElementById('volume-bar');

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
    flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass_boost: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    electronic: [4, 3, 1, 0, -2, 2, 1, 1, 3, 4],
    rock:       [5, 3, 1, 0, -1, -1, 0, 2, 3, 4],
    pop:        [-1, 2, 3, 4, 3, 0, -1, -1, 2, 3]
};

function escapeHtmlAttr(obj) {
    return JSON.stringify(obj).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    initTheme();
    setupAudioListeners();
    setupInfiniteScrollListener();
    await loadSettings();
    await loadBlacklists();
    await loadFavorites();
    await loadPlaylists();
    switchTab('home');
    initKeyboardShortcuts();
    initGlobalClickAndHoverListeners();
    
    if (volBar) volBar.style.setProperty('--range-fill', `${volBar.value}%`);
});

// Глобальные события для 3D-наклона карточек (throttled через requestAnimationFrame)
function initGlobalClickAndHoverListeners() {
    let tiltRaf = null;
    document.addEventListener('pointermove', (e) => {
        const card = e.target.closest('.music-card');
        if (!card) return;
        if (tiltRaf) return;
        tiltRaf = requestAnimationFrame(() => {
            tiltRaf = null;
            const rect = card.getBoundingClientRect();
            const xPct = (e.clientX - rect.left) / rect.width - 0.5;
            const yPct = (e.clientY - rect.top) / rect.height - 0.5;
            card.style.transform = `perspective(1000px) rotateX(${-yPct * 12}deg) rotateY(${xPct * 12}deg) translateY(-4px) scale(1.02)`;
            card.style.zIndex = '10';
        });
    });
    
    document.addEventListener('pointerout', (e) => {
        const card = e.target.closest('.music-card');
        if (card && !card.contains(e.relatedTarget)) {
            card.style.transition = 'transform 0.5s cubic-bezier(0.2, 0, 0, 1)';
            card.style.transform = '';
            card.style.zIndex = '1';
            setTimeout(() => { card.style.transition = ''; }, 500);
        }
    });
}

function initTheme() { changeTheme(localStorage.getItem('cascade_theme_v3') || 'dark'); }
function changeTheme(themeName) {
    const html = document.documentElement;
    themeName === 'dark' ? html.classList.add('dark') : html.classList.remove('dark');
    localStorage.setItem('cascade_theme_v3', themeName);
    const sel = document.getElementById('select-theme-style');
    if (sel) sel.value = themeName;
    lucide.createIcons();
}
function toggleThemeCycle() {
    changeTheme((localStorage.getItem('cascade_theme_v3') || 'dark') === 'dark' ? 'light' : 'dark');
}

function formatArtistLink(artistStr) {
    if (!artistStr) return 'Неизвестно';
    return artistStr.split(/,\s*|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+/i).filter(Boolean).map(a => {
        const clean = a.trim();
        return `<span class="artist-link font-medium hover:text-primary transition-colors inline-block" onclick="event.stopPropagation(); openArtistByName('${CSS.escape(clean)}')">${escapeHtml(clean)}</span>`;
    }).join('<span class="text-muted text-xs mx-0.5">•</span>');
}

async function openArtistByName(artistName) {
    if (!artistName || !artistName.trim()) return;
    showToast(`Загрузка исполнителя: ${artistName}...`);
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(artistName)}&filter=artists&limit=5`);
        const data = await res.json();
        if (data.tracks && data.tracks.length > 0) {
            await openArtist(data.tracks[0].id, artistName);
        } else {
            throw new Error("Artist not found");
        }
    } catch (e) {
        document.getElementById('search-input').value = artistName;
        setSearchFilter('songs');
        switchTab('search');
        performSearch(true);
    }
}

function initAudioContext() {
    if (state.audioContext) return;
    try {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        const source1 = state.audioContext.createMediaElementSource(player1);
        const source2 = state.audioContext.createMediaElementSource(player2);
        
        gain1 = state.audioContext.createGain();
        gain2 = state.audioContext.createGain();
        
        source1.connect(gain1);
        source2.connect(gain2);
        
        state.analyser = state.audioContext.createAnalyser();
        state.analyser.fftSize = 256;
        
        gain1.connect(state.analyser);
        gain2.connect(state.analyser);
        
        let prevNode = state.analyser;
        state.eqFilters = EQ_FREQUENCIES.map((freq, i) => {
            const filter = state.audioContext.createBiquadFilter();
            filter.type = i === 0 ? 'lowshelf' : (i === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking');
            filter.frequency.value = freq;
            filter.gain.value = 0;
            prevNode.connect(filter);
            prevNode = filter;
            return filter;
        });

        prevNode.connect(state.audioContext.destination);

        applyEqPreset(state.settings.equalizer_preset || 'flat');
        startVisualizer();
    } catch (e) { console.error("Web Audio API Error:", e); }
}

function applyEqPreset(presetName) {
    const values = EQ_PRESETS[presetName] || EQ_PRESETS.flat;
    state.eqFilters.forEach((filter, i) => {
        if (filter) filter.gain.value = values[i];
        const slider = document.getElementById(`eq-band-${i}`);
        if (slider) slider.value = values[i];
    });
    const select = document.getElementById('eq-preset-select');
    if (select) select.value = presetName;
}

function onEqSliderChange(index, val) {
    if (state.eqFilters[index]) state.eqFilters[index].gain.value = parseFloat(val);
}

// Экстракция доминирующего цвета обложки
function extractAverageColor(imgElement) {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const w = 8, h = 8;
        canvas.width = w;
        canvas.height = h;
        try {
            ctx.drawImage(imgElement, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            let r = 0, g = 0, b = 0, n = 0;
            for (let i = 0; i < data.length; i += 4) {
                r += data[i]; g += data[i+1]; b += data[i+2]; n++;
            }
            resolve(`rgb(${Math.round(r/n)}, ${Math.round(g/n)}, ${Math.round(b/n)})`);
        } catch(e) {
            resolve('#6b7280');
        }
    });
}

function startVisualizer() {
    if (state.isVisualizerRunning || !state.analyser) return;
    state.isVisualizerRunning = true;
    const canvas = document.getElementById('visualizer-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const bufferLength = state.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const resizeCanvas = () => {
        canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
        canvas.height = window.innerHeight * (window.devicePixelRatio || 1);
    };
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    let smoothedPulse = 0;

    function draw() {
        requestAnimationFrame(draw);
        if (!activePlayer || activePlayer.paused) {
            if(!state.isCrossfading) return; 
        }
        
        state.analyser.getByteFrequencyData(dataArray);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const barWidth = (canvas.width / bufferLength) * 2;
        let x = 0;
        const coverColor = getComputedStyle(document.documentElement).getPropertyValue('--cover-color').trim() || '#6b7280';
        ctx.fillStyle = coverColor;

        let bassSum = 0;
        const bassBins = 4;
        for (let i = 0; i < bufferLength; i++) {
            if (i < bassBins) bassSum += dataArray[i];
            
            const barHeight = (dataArray[i] / 255) * canvas.height * 0.8; 
            ctx.beginPath();
            ctx.roundRect(x, canvas.height - barHeight, barWidth - 4, barHeight, [10, 10, 0, 0]);
            ctx.fill();
            x += barWidth;
        }

        const npModal = document.getElementById('now-playing-modal');
        const npArt = document.getElementById('now-playing-art');
        if (npModal && !npModal.classList.contains('hidden') && npArt) {
            const bass = bassSum / bassBins;
            const rawPulse = bass / 255;
            smoothedPulse = smoothedPulse * 0.85 + rawPulse * 0.15;
            const p = smoothedPulse;
            npArt.style.boxShadow = `0 10px ${30 + p * 50}px ${p * 15}px ${coverColor}`;
            npArt.style.transform = `scale(${1 + p * 0.025})`;
        }
    }
    draw();
}

function preloadNextTrackIntoInactive() {
    if (state.isPreloaded) return;
    
    let nextIdx = state.queueIndex + 1;
    if (state.shuffleMode) {
        state.nextShuffleIndex = Math.floor(Math.random() * state.playQueue.length);
        nextIdx = state.nextShuffleIndex;
    } else if (nextIdx >= state.playQueue.length) {
        if (state.repeatMode === 1) nextIdx = 0;
        else return; 
    }
    
    const nextT = state.playQueue[nextIdx];
    if (!nextT || isBlockedOrDisliked(nextT)) return;
    
    inactivePlayer.src = getStreamUrlForTrack(nextT);
    inactivePlayer.preload = "auto";
    inactivePlayer.load();
    
    state.isPreloaded = true;
    state.preloadedIndex = nextIdx;
}

async function startCrossfade() {
    state.isCrossfading = true;
    
    let nextIdx = state.preloadedIndex !== undefined ? state.preloadedIndex : (state.queueIndex + 1);
    if (state.shuffleMode && state.preloadedIndex === undefined) {
        nextIdx = Math.floor(Math.random() * state.playQueue.length);
    } else if (nextIdx >= state.playQueue.length && state.repeatMode === 1) {
        nextIdx = 0;
    }
    
    const nextT = state.playQueue[nextIdx];
    if (!nextT || isBlockedOrDisliked(nextT)) {
        state.isCrossfading = false;
        return;
    }

    if (!state.isPreloaded) {
        inactivePlayer.src = getStreamUrlForTrack(nextT);
    }
    
    const canCrossfade = state.audioContext && gain1 && gain2;
    if (!canCrossfade) {
        state.isCrossfading = false;
        nextTrack();
        return;
    }
    
    const now = state.audioContext.currentTime;
    const fadeDuration = 2.0; 
    
    const activeGainNode = activePlayer === player1 ? gain1 : gain2;
    const inactiveGainNode = inactivePlayer === player1 ? gain1 : gain2;
    
    activeGainNode.gain.cancelScheduledValues(now);
    inactiveGainNode.gain.cancelScheduledValues(now);
    activeGainNode.gain.setValueAtTime(activeGainNode.gain.value, now);
    inactiveGainNode.gain.setValueAtTime(inactiveGainNode.gain.value, now);
    
    activeGainNode.gain.linearRampToValueAtTime(0.0, now + fadeDuration);
    inactiveGainNode.gain.linearRampToValueAtTime(1.0, now + fadeDuration);
    
    try {
        await inactivePlayer.play();
        
        const oldPlayer = activePlayer;
        activePlayer = inactivePlayer;
        inactivePlayer = oldPlayer;
        
        state.queueIndex = nextIdx;
        state.currentTrack = nextT;
        state.isPreloaded = false;
        state.preloadedIndex = undefined;
        state.scrobbleSubmitted = false;
        
        updateUIForTrack(nextT);
        fetchAndRenderLyrics(nextT);
        fetch('/api/history', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(nextT) }).catch(()=>{});
        
        setTimeout(() => {
            oldPlayer.pause();
            oldPlayer.currentTime = 0;
            state.isCrossfading = false;
        }, fadeDuration * 1000);
        
        if (state.playQueue.length > 0 && state.queueIndex >= state.playQueue.length - 2) {
            appendRadioTracksToQueue(nextT);
        }
        
    } catch(e) {
        state.isCrossfading = false;
        activeGainNode.gain.setValueAtTime(1.0, state.audioContext.currentTime);
        inactiveGainNode.gain.setValueAtTime(0.0, state.audioContext.currentTime);
    }
}

// Перемотка трека кликом по верхней полосе
function seekTopProgressBar(e) {
    if (!activePlayer || !activePlayer.duration) return;
    const container = document.getElementById('top-progress-container');
    const rect = container.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    activePlayer.currentTime = percent * activePlayer.duration;
}

function seekModalProgressBar(e) {
    if (!activePlayer || !activePlayer.duration) return;
    const container = document.getElementById('modal-progress-container');
    const rect = container.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    activePlayer.currentTime = percent * activePlayer.duration;
}

function setupAudioListeners() {
    [player1, player2].forEach(p => {
        p.addEventListener('timeupdate', (e) => {
            if (e.target !== activePlayer) return; 
            
            const current = activePlayer.currentTime;
            const duration = activePlayer.duration;
            
            if (duration && !isNaN(duration)) {
                // Обновление кастомного прогресс-бара сверху панели
                const fill = document.getElementById('top-progress-fill');
                if (fill) fill.style.width = `${(current / duration) * 100}%`;
                const modalFill = document.getElementById('modal-progress-fill');
                if (modalFill) modalFill.style.width = `${(current / duration) * 100}%`;
                
                document.getElementById('time-current').innerText = formatTime(current);
                document.getElementById('time-total').innerText = formatTime(duration);
                
                if (current >= 5) state.consecutiveErrors = 0;
                const durSeconds = duration || (state.currentTrack ? state.currentTrack.duration_seconds : 0) || 0;
                
                if (!state.scrobbleSubmitted && durSeconds > 0 && current >= Math.min(240, durSeconds * 0.5)) {
                    submitScrobble('single');
                    state.scrobbleSubmitted = true;
                }
                updateSyncedLyrics(current);

                if (current >= duration - 15.0 && !state.isPreloaded && state.playQueue.length > 0 && state.queueIndex < state.playQueue.length - 1) {
                    preloadNextTrackIntoInactive();
                }

                const crossfadeTime = 2.0;
                if (current >= duration - crossfadeTime && !state.isCrossfading && state.playQueue.length > 0 && state.queueIndex < state.playQueue.length - 1) {
                    startCrossfade();
                }
            }
        });

        p.addEventListener('playing', (e) => {
            if (e.target !== activePlayer) return;
            updatePlayStateUI(true);
            if (state.audioContext && state.audioContext.state === 'suspended') state.audioContext.resume();
        });

        p.addEventListener('pause', (e) => {
            if (e.target !== activePlayer) return;
            updatePlayStateUI(false);
        });

        p.addEventListener('waiting', (e) => {
            if (e.target !== activePlayer) return;
            document.getElementById('play-btn').innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i>';
            lucide.createIcons();
        });

        p.addEventListener('ended', (e) => {
            if (e.target !== activePlayer) return;
            if (!state.isCrossfading) {
                handleStreamFailure(false);
            }
        });

        p.addEventListener('error', (e) => {
            if (e.target !== activePlayer) return;
            handleStreamFailure(true);
        });
    });

    const handleStreamFailure = (isError = false) => {
        if (state.isSwitchingTrack) return;
        if (isError || (Date.now() - state.trackStartTime) / 1000 < 3) state.consecutiveErrors++;
        else state.consecutiveErrors = 0;

        if (state.consecutiveErrors >= 3) {
            showToast("Слишком много ошибок сети.", "error");
            state.consecutiveErrors = 0;
            updatePlayStateUI(false);
            return;
        }

        setTimeout(() => {
            if (state.repeatMode === 2 && !isError) {
                activePlayer.currentTime = 0;
                activePlayer.play().catch(() => handleStreamFailure(true));
            } else {
                nextTrack();
            }
        }, 800);
    };

    if (volBar) {
        volBar.addEventListener('input', (e) => {
            const vol = e.target.value / 100;
            player1.volume = vol;
            player2.volume = vol;
            updateVolumeIcon(vol);
            e.target.style.setProperty('--range-fill', `${e.target.value}%`);
        });
    }
}

function updateVolumeIcon(vol) {
    const icon = document.getElementById('volume-icon');
    if (!icon) return;
    icon.setAttribute('data-lucide', vol === 0 ? 'volume-x' : (vol < 0.5 ? 'volume-1' : 'volume-2'));
    lucide.createIcons();
}

function updatePlayStateUI(isPlaying) {
    const playBtn = document.getElementById('play-btn');
    const anim = document.getElementById('playing-anim-bar');
    if (!playBtn) return;
    
    if (isPlaying) {
        playBtn.innerHTML = '<i data-lucide="pause" class="w-5 h-5 fill-current"></i>';
        if (anim) anim.classList.remove('hidden');
    } else {
        playBtn.innerHTML = '<i data-lucide="play" class="w-5 h-5 ml-0.5 fill-current"></i>';
        if (anim) anim.classList.add('hidden');
    }
    lucide.createIcons();
}

function updateUIForTrack(track) {
    renderQueueList();
    document.getElementById('player-title').innerText = track.title;
    document.getElementById('player-artist').innerHTML = formatArtistLink(track.artist);
    
    const coverUrl = track.cover_url || getFallbackCover(track.artist, track.title);
    document.getElementById('player-art').style.backgroundImage = `url("${coverUrl}")`;
    document.getElementById('now-playing-title').innerText = track.title;
    document.getElementById('now-playing-artist').innerHTML = formatArtistLink(track.artist);
    
    const npArt = document.getElementById('now-playing-art');
    if (npArt) {
        npArt.src = coverUrl;
        
        const proxiedUrl = coverUrl.startsWith('/') || coverUrl.startsWith(window.location.origin)
            ? coverUrl
            : `/api/cover_proxy?url=${encodeURIComponent(coverUrl)}`;
        const imgForColor = new Image();
        imgForColor.crossOrigin = "Anonymous";
        imgForColor.src = proxiedUrl;
        imgForColor.onload = async () => {
            const color = await extractAverageColor(imgForColor);
            document.documentElement.style.setProperty('--cover-color', color);
        };
        imgForColor.onerror = () => {
            document.documentElement.style.setProperty('--cover-color', '#6b7280');
        };
    }
    
    updatePlayerBarActionIcons(track);

    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i>';
        lucide.createIcons();
    }
}

async function playTrack(track, queue = null, index = -1) {
    if (!track || state.isSwitchingTrack) return;
    state.isSwitchingTrack = true;
    
    if (isBlockedOrDisliked(track)) {
        state.isSwitchingTrack = false;
        setTimeout(() => nextTrack(), 200);
        return;
    }

    try {
        initAudioContext();
        state.trackStartTime = Date.now();

        if (queue) {
            state.playQueue = queue.filter(t => !isBlockedOrDisliked(t));
            state.queueIndex = index !== -1 ? index : state.playQueue.findIndex(t => t.title === track.title && t.artist === track.artist);
        } else if (index !== -1) {
            state.queueIndex = index;
        }

        state.currentTrack = track;
        state.scrobbleSubmitted = false;
        state.isPreloaded = false;
        state.preloadedIndex = undefined;
        state.isCrossfading = false;
        
        if (state.audioContext) {
            const now = state.audioContext.currentTime;
            const activeGainNode = activePlayer === player1 ? gain1 : gain2;
            if (activeGainNode) {
                activeGainNode.gain.cancelScheduledValues(now);
                activeGainNode.gain.setValueAtTime(1.0, now);
            }
            const inactiveGainNode = inactivePlayer === player1 ? gain1 : gain2;
            if (inactiveGainNode) {
                inactiveGainNode.gain.cancelScheduledValues(now);
                inactiveGainNode.gain.setValueAtTime(0.0, now);
            }
        }
        
        inactivePlayer.pause();
        updateUIForTrack(track);

        activePlayer.src = getStreamUrlForTrack(track);
        
        try {
            await activePlayer.play();
        } catch (e) {
            state.consecutiveErrors++;
            if (state.consecutiveErrors < 3) setTimeout(() => nextTrack(), 1000);
            return;
        }

        fetch('/api/history', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(track) }).catch(()=>{});
        submitScrobble('playing_now');
        fetchAndRenderLyrics(track);

        if (state.playQueue.length > 0 && state.queueIndex >= state.playQueue.length - 2) {
            appendRadioTracksToQueue(track);
        }
    } finally {
        setTimeout(() => state.isSwitchingTrack = false, 500);
    }
}

async function appendRadioTracksToQueue(track) {
    try {
        const res = await fetch(`/api/radio?artist=${encodeURIComponent(track.artist)}&title=${encodeURIComponent(track.title)}`);
        const data = await res.json();
        if (data.tracks && data.tracks.length > 0) {
            const newTracks = data.tracks.filter(t => !isBlockedOrDisliked(t) && !state.playQueue.some(q => q.title === t.title && q.artist === t.artist));
            state.playQueue.push(...newTracks);
        }
    } catch (e) {}
}

function togglePlay() {
    if (!activePlayer.src || !state.currentTrack) {
        if (state.playQueue.length > 0) playTrack(state.playQueue[0], null, 0);
        return;
    }
    activePlayer.paused ? activePlayer.play() : activePlayer.pause();
}

function nextTrack() {
    if (state.isSwitchingTrack || state.playQueue.length === 0) return;
    let nextIdx = state.queueIndex + 1;
    if (state.shuffleMode) {
        nextIdx = Math.floor(Math.random() * state.playQueue.length);
    } else if (nextIdx >= state.playQueue.length) {
        if (state.repeatMode === 1) nextIdx = 0;
        else return;
    }
    playTrack(state.playQueue[nextIdx], null, nextIdx);
}

function prevTrack() {
    if (state.isSwitchingTrack) return;
    if (activePlayer.currentTime > 3) { activePlayer.currentTime = 0; return; }
    if (state.playQueue.length === 0 || state.queueIndex <= 0) return;
    playTrack(state.playQueue[state.queueIndex - 1], null, state.queueIndex - 1);
}

function toggleShuffle() {
    state.shuffleMode = !state.shuffleMode;
    const btn = document.getElementById('shuffle-btn');
    if (btn) {
        btn.classList.toggle('text-primary', state.shuffleMode);
        btn.classList.toggle('text-muted', !state.shuffleMode);
    }
}

function toggleRepeat() {
    state.repeatMode = (state.repeatMode + 1) % 3;
    const btn = document.getElementById('repeat-btn');
    if (!btn) return;
    
    btn.className = state.repeatMode === 0 ? "text-muted hover:text-main transition-colors p-1 active:scale-95" : "text-primary hover:text-main transition-colors p-1 active:scale-95";
    btn.innerHTML = state.repeatMode === 2 ? '<i data-lucide="repeat-1" class="w-4 h-4"></i>' : '<i data-lucide="repeat" class="w-4 h-4"></i>';
    lucide.createIcons();
}

async function loadFavorites() {
    try {
        const res = await fetch('/api/favorites');
        const data = await res.json();
        state.favorites = new Set(data.tracks.map(t => getTrackKey(t.artist, t.title)));
    } catch (e) {}
}

async function loadBlacklists() {
    try {
        const [resDis, resBlk] = await Promise.all([fetch('/api/dislikes'), fetch('/api/blocked_artists')]);
        const dataDis = await resDis.json();
        const dataBlk = await resBlk.json();
        state.dislikes = new Set((dataDis.tracks || []).map(t => getTrackKey(t.artist, t.title)));
        state.blockedArtists = new Set((dataBlk.artists || []).map(a => a.artist.toLowerCase().trim()));
    } catch (e) {}
}

function getTrackKey(artist, title) { return `${(artist || '').toLowerCase().trim()}|${(title || '').toLowerCase().trim()}`; }
function isFavorite(track) { return track && state.favorites.has(getTrackKey(track.artist, track.title)); }
function isDisliked(track) { return track && state.dislikes.has(getTrackKey(track.artist, track.title)); }

function isBlockedOrDisliked(track) {
    if (!track) return false;
    if (isDisliked(track)) return true;
    const artLower = (track.artist || '').toLowerCase().trim();
    for (let blocked of state.blockedArtists) {
        if (artLower === blocked) return true;
    }
    return false;
}

function updatePlayerBarActionIcons(track) {
    const favBtn = document.getElementById('player-fav-btn-icon');
    const disBtn = document.getElementById('player-dis-btn-icon');
    if (favBtn) favBtn.className = `w-5 h-5 ${isFavorite(track) ? 'fill-primary text-primary' : 'text-muted'} transition-colors`;
    if (disBtn) disBtn.className = `w-5 h-5 ${isDisliked(track) ? 'text-red-500' : 'text-muted'} transition-colors`;
}

function updateTrackItemFavIcon(artist, title) {
    const key = getTrackKey(artist, title);
    const isFav = state.favorites.has(key);
    document.querySelectorAll(`.fav-icon[data-key="${CSS.escape(key)}"]`).forEach(icon => {
        icon.className = `w-4 h-4 fav-icon transition-colors ${isFav ? 'fill-primary text-primary' : 'text-muted'}`;
    });
}

async function toggleCurrentFavorite() {
    if (!state.currentTrack) return;
    await toggleFavorite(state.currentTrack);
    updatePlayerBarActionIcons(state.currentTrack);
}

async function toggleDislikeTrack(track) {
    if (!track) track = state.currentTrack;
    if (!track) return;
    const key = getTrackKey(track.artist, track.title);
    await fetch('/api/dislike', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(track) });
    state.dislikes.add(key);
    state.favorites.delete(key);
    showToast("Трек скрыт и дизлайкнут", "info");
    
    if (state.currentTrack && getTrackKey(state.currentTrack.artist, state.currentTrack.title) === key) nextTrack();
    state.playQueue = state.playQueue.filter(t => !isBlockedOrDisliked(t));
    renderQueueList();
    
    document.querySelectorAll('.track-row, .music-card').forEach(el => {
        if (`${el.dataset.artist?.toLowerCase().trim()}|${el.dataset.title?.toLowerCase().trim()}` === key) el.remove();
    });
}

async function toggleFavorite(track) {
    const key = getTrackKey(track.artist, track.title);
    if (state.favorites.has(key)) {
        state.favorites.delete(key);
        await fetch(`/api/favorites?artist=${encodeURIComponent(track.artist)}&title=${encodeURIComponent(track.title)}`, { method: 'DELETE' });
        showToast("Удалено из избранного");
    } else {
        state.favorites.add(key);
        state.dislikes.delete(key);
        await fetch('/api/favorites', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(track) });
        showToast("Добавлено в избранное");
    }
    updateTrackItemFavIcon(track.artist, track.title);
}

async function submitScrobble(listenType) {
    if (!state.currentTrack || !state.settings.lb_token) return;
    try {
        await fetch('/api/scrobble', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                artist: state.currentTrack.artist, title: state.currentTrack.title,
                album: state.currentTrack.album || '',
                duration: Math.floor(activePlayer.duration || state.currentTrack.duration_seconds || 0),
                listen_type: listenType
            })
        });
    } catch (e) {}
}

async function fetchAndRenderLyrics(track) {
    const container = document.getElementById('lyrics-container');
    if (!container) return;
    container.innerHTML = `<div class="flex items-center justify-center h-48 text-white/50 text-sm mt-[30vh]"><i data-lucide="loader-2" class="w-5 h-5 animate-spin mr-2"></i> Загрузка текста...</div>`;
    lucide.createIcons();
    state.syncedLyrics = [];

    try {
        const res = await fetch(`/api/lyrics?artist=${encodeURIComponent(track.artist)}&title=${encodeURIComponent(track.title)}`);
        const data = await res.json();

        if (data.type === 'synced') {
            state.syncedLyrics = parseSyncedLyrics(data.lyrics);
            renderSyncedLyrics(container);
        } else if (data.type === 'plain') {
            container.innerHTML = `<div class="whitespace-pre-wrap text-lg leading-relaxed text-white py-4 mt-20 text-center">${data.lyrics}</div>`;
        } else {
            container.innerHTML = `<div class="text-center mt-[30vh] text-white/50 text-sm">Текст не найден :\\</div>`;
        }
    } catch (e) {
        container.innerHTML = `<div class="text-center mt-[30vh] text-white/50 text-sm">Ошибка загрузки текста</div>`;
    }
}

function parseSyncedLyrics(lrcString) {
    const lines = lrcString.split('\n');
    const parsed = [];
    const timeReg = /\[(\d{2}):(\d{2}\.\d{2,3})\]/;
    lines.forEach(line => {
        const match = timeReg.exec(line);
        if (match) {
            const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
            const text = line.replace(timeReg, '').trim();
            if (text) parsed.push({ time, text });
        }
    });
    return parsed;
}

function renderSyncedLyrics(container) {
    container.innerHTML = `
        ${state.syncedLyrics.map((item, idx) => `
            <div id="lyric-idx-${idx}" class="lyric-line" onclick="window.audioProxy.currentTime = ${item.time}">${item.text}</div>
        `).join('')}
    `;
}

function updateSyncedLyrics(currentTime) {
    if (!state.syncedLyrics.length) return;
    
    let activeIdx = -1;
    for (let i = 0; i < state.syncedLyrics.length; i++) {
        if (currentTime >= state.syncedLyrics[i].time - 0.2) activeIdx = i;
        else break;
    }
    
    if (activeIdx !== -1) {
        const lines = document.querySelectorAll('.lyric-line');
        lines.forEach((el, idx) => {
            if (idx === activeIdx && !el.classList.contains('active')) {
                el.classList.add('active');
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (idx !== activeIdx && el.classList.contains('active')) {
                el.classList.remove('active');
            }
        });
    }
}

function toggleQueueModal() {
    const modal = document.getElementById('queue-modal');
    const overlay = document.getElementById('queue-overlay');
    if (!modal) return;
    
    modal.classList.toggle('hidden');
    if (overlay) overlay.classList.toggle('hidden');
    
    if (!modal.classList.contains('hidden')) renderQueueList();
}

function renderQueueList() {
    const list = document.getElementById('queue-list-container');
    if (!list) return;
    if (state.playQueue.length === 0) { list.innerHTML = `<p class="text-center py-6 text-muted text-sm">Очередь пуста</p>`; return; }
    list.innerHTML = state.playQueue.map((t, idx) => `
        <div class="flex items-center justify-between p-2 rounded-lg ${idx === state.queueIndex ? 'bg-surface-hover text-primary' : 'hover:bg-surface-hover'} cursor-pointer transition-colors" onclick='playTrack(${escapeHtmlAttr(t)}, null, ${idx})'>
            <div class="flex items-center gap-2 min-w-0">
                <span class="text-xs w-4 text-center text-muted">${idx === state.queueIndex ? '▶' : idx + 1}</span>
                <div class="min-w-0">
                    <h4 class="text-sm font-medium truncate ${idx === state.queueIndex ? 'text-primary' : 'text-main'}">${escapeHtml(t.title)}</h4>
                    <p class="text-xs text-muted truncate">${formatArtistLink(t.artist)}</p>
                </div>
            </div>
            <button onclick="event.stopPropagation(); removeFromQueue(${idx})" class="text-muted hover:text-main p-1"><i data-lucide="x" class="w-3 h-3"></i></button>
        </div>
    `).join('');
    lucide.createIcons();
}

function removeFromQueue(idx) { state.playQueue.splice(idx, 1); if (idx < state.queueIndex) state.queueIndex--; renderQueueList(); }
function clearQueue() { state.playQueue = []; state.queueIndex = -1; renderQueueList(); }

function toggleEqualizerModal() { document.getElementById('equalizer-modal')?.classList.toggle('hidden'); }
function toggleNowPlayingModal() {
    const modal = document.getElementById('now-playing-modal');
    if (!modal) return;
    modal.classList.toggle('hidden');
    const playerBar = document.getElementById('player-bar');
    const isHidden = modal.classList.contains('hidden');
    if (playerBar) playerBar.style.display = isHidden ? '' : 'none';
    if (!isHidden) { startVisualizer(); updateSyncedLyrics(activePlayer ? activePlayer.currentTime : 0); }
}

let activeModalTrack = null;
function openAddToPlaylistModal(track) {
    activeModalTrack = track;
    const select = document.getElementById('modal-playlist-select');
    if (!select) return;
    select.innerHTML = state.playlists.length > 0 ? state.playlists.map(p => `<option value="${p.id}">${p.name}</option>`).join('') : `<option value="">Нет созданных плейлистов</option>`;
    document.getElementById('add-playlist-modal')?.classList.remove('hidden');
}
function closeAddToPlaylistModal() { document.getElementById('add-playlist-modal')?.classList.add('hidden'); activeModalTrack = null; }

async function confirmAddToPlaylist() {
    const plId = parseInt(document.getElementById('modal-playlist-select').value);
    if (!plId || !activeModalTrack) return;
    await fetch(`/api/playlists/${plId}/tracks`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(activeModalTrack) });
    closeAddToPlaylistModal(); showToast("Добавлено в плейлист"); loadPlaylists();
}
function openCreatePlaylistModal() {
    const name = prompt("Название нового плейлиста:");
    if (name) createPlaylist(name, "");
}

function renderTrackCards(container, tracks, queue) {
    container.innerHTML = tracks.map((t, idx) => `
        <div class="music-card p-3 cursor-pointer group" onclick='playTrack(${escapeHtmlAttr(t)}, ${escapeHtmlAttr(queue)}, ${idx})'>
            <div class="relative w-full aspect-square rounded-xl mb-3 overflow-hidden bg-surface-hover shadow-sm">
                <img src="${t.cover_url || getFallbackCover(t.artist, t.title)}" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy">
                <div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"><i data-lucide="play" class="w-8 h-8 text-white fill-white ml-1"></i></div>
            </div>
            <h4 class="font-medium text-sm text-main truncate transition-colors">${escapeHtml(t.title)}</h4>
            <p class="text-xs text-muted truncate mt-0.5 transition-colors" data-artist="${CSS.escape(t.artist)}">${formatArtistLink(t.artist)}</p>
        </div>
    `).join('');
    lucide.createIcons();
}

function renderTrackList(container, tracks, queue, showTrackNum = false, playlistId = null, wrap = true) {
    const html = tracks.map((t, idx) => {
        const isFav = state.favorites.has(getTrackKey(t.artist, t.title));
        return `
        <div class="flex items-center justify-between px-3 py-2 track-row cursor-pointer group" onclick='playTrack(${escapeHtmlAttr(t)}, ${escapeHtmlAttr(queue)}, ${idx})' data-artist="${escapeHtmlAttr(t.artist)}" data-title="${escapeHtmlAttr(t.title)}">
            <div class="flex items-center gap-3 min-w-0">
                ${showTrackNum ? `<span class="w-6 text-center text-xs font-medium text-muted">${idx + 1}</span>` : `<div class="w-10 h-10 rounded-md overflow-hidden relative flex-shrink-0 bg-surface-hover border border-border-color"><img src="${t.cover_url || getFallbackCover(t.artist, t.title)}" class="w-full h-full object-cover transition-transform group-hover:scale-105"></div>`}
                <div class="min-w-0">
                    <h4 class="font-medium text-sm text-main truncate group-hover:text-primary transition-colors">${escapeHtml(t.title)}</h4>
                    <p class="text-xs text-muted truncate">${formatArtistLink(t.artist)} ${t.album ? '• ' + escapeHtml(t.album) : ''}</p>
                </div>
            </div>
            <div class="flex items-center gap-1 text-muted flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick='event.stopPropagation(); toggleFavorite(${escapeHtmlAttr(t)})' class="p-1.5 hover:text-primary transition-colors rounded hover:bg-bg-card"><i data-lucide="heart" class="w-4 h-4 fav-icon transition-colors ${isFav ? 'fill-primary text-primary' : ''}" data-key="${CSS.escape(getTrackKey(t.artist, t.title))}"></i></button>
                <button onclick='event.stopPropagation(); toggleDislikeTrack(${escapeHtmlAttr(t)})' class="p-1.5 hover:text-red-500 transition-colors rounded hover:bg-bg-card" title="Не нравится"><i data-lucide="heart-crack" class="w-4 h-4"></i></button>
                <button onclick='event.stopPropagation(); openAddToPlaylistModal(${escapeHtmlAttr(t)})' class="p-1.5 hover:text-main transition-colors rounded hover:bg-bg-card"><i data-lucide="plus" class="w-4 h-4"></i></button>
                <button onclick='event.stopPropagation(); openRadio(${escapeHtmlAttr(t)})' class="p-1.5 hover:text-main transition-colors rounded hover:bg-bg-card hidden sm:block"><i data-lucide="radio" class="w-4 h-4"></i></button>
                ${playlistId ? `<button onclick="event.stopPropagation(); removeTrackFromPlaylist(${playlistId}, ${t.id})" class="p-1.5 hover:text-main transition-colors rounded hover:bg-bg-card"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
            </div>
        </div>
    `}).join('');
    wrap ? (container.innerHTML = `<div class="space-y-0.5 track-list-wrapper">${html}</div>`) : (container.innerHTML = html);
    lucide.createIcons();
}

function getFallbackCover(artist = '', title = '') { return `https://picsum.photos/seed/${encodeURIComponent((artist + title).trim() || 'cascade')}/1000/1000`; }
function isLocalTrack(t) { return !!(t && (t.type === 'local' || t.isLocal)); }
function getStreamUrlForTrack(track) {
    if (isLocalTrack(track) && track.id) return `/api/library/track/${track.id}/stream`;
    return `/api/stream?artist=${encodeURIComponent(track.artist)}&title=${encodeURIComponent(track.title)}`;
}
function formatTime(seconds) {
    if (isNaN(seconds) || seconds <= 0) return "0:00";
    return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}
function getLoaderHTML() { return `<div class="flex flex-col items-center justify-center py-16 text-muted col-span-full"><i data-lucide="loader-2" class="w-6 h-6 animate-spin mb-3"></i><p class="text-sm fade-in">Загрузка...</p></div>`; }
function showToast(msg, type = "info") {
    let toast = document.getElementById('cascade-toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'cascade-toast'; document.body.appendChild(toast); }
    toast.className = `fixed bottom-36 md:bottom-24 right-6 z-[60] px-4 py-2.5 rounded-lg text-sm font-medium transition-all transform translate-y-0 opacity-100 flex items-center gap-2 shadow-lg bg-[#1f1f1f] border border-[#333] text-white fade-in`;
    toast.innerHTML = `<span class="${type === 'error' ? 'text-red-500' : 'text-primary'} font-bold">${type === 'error' ? '!' : '✓'}</span> <span>${msg}</span>`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)'; }, 3000);
}

function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
        
        if (e.key === 'Escape') {
            document.querySelectorAll('.fixed.inset-0:not(.hidden)').forEach(modal => {
                if (modal.id === 'now-playing-modal') toggleNowPlayingModal();
                else if (modal.id === 'equalizer-modal') toggleEqualizerModal();
                else if (modal.id === 'add-playlist-modal') closeAddToPlaylistModal();
            });
            const queue = document.getElementById('queue-modal');
            if (queue && !queue.classList.contains('hidden')) toggleQueueModal();
        }
        else if ((e.altKey && (e.code === 'KeyT' || e.code === 'KeyS')) || (e.shiftKey && e.code === 'KeyT')) { e.preventDefault(); toggleThemeCycle(); }
        else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        else if (e.code === 'ArrowRight') { e.preventDefault(); e.shiftKey ? nextTrack() : (activePlayer.currentTime = Math.min(activePlayer.duration || 0, activePlayer.currentTime + 5)); }
        else if (e.code === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? prevTrack() : (activePlayer.currentTime = Math.max(0, activePlayer.currentTime - 5)); }
        else if (e.code === 'KeyM') { window.audioProxy.muted = !window.audioProxy.muted; }
        else if (e.code === 'KeyF') toggleNowPlayingModal();
        else if (e.code === 'KeyL') toggleCurrentFavorite();
    });
}

// --- ТАБЫ И НАВИГАЦИЯ ---
function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    const tab = document.getElementById(`tab-${tabName}`);
    if (tab) tab.classList.remove('hidden');
    
    // Подсветка активного пункта меню
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('bg-surface-hover', 'text-primary');
        n.classList.add('text-muted');
    });
    const navMap = { home: 'nav-home', search: 'nav-search', stats: 'nav-stats', settings: 'nav-settings' };
    const navEl = document.getElementById(navMap[tabName]);
    if (navEl) { navEl.classList.add('bg-surface-hover', 'text-primary'); navEl.classList.remove('text-muted'); }
    
    // Мобильная навигация
    document.querySelectorAll('nav.md\\:hidden button[data-tab]').forEach(b => {
        if (b.dataset.tab === tabName) { b.classList.add('text-primary'); b.classList.remove('text-muted'); }
        else { b.classList.remove('text-primary'); b.classList.add('text-muted'); }
    });

    if (tabName === 'home') loadHome();
    if (tabName === 'stats') loadStats();
    if (tabName === 'settings') loadSettingsIntoUI();
    
    const scrollContainer = document.getElementById('main-scroll-container');
    if (scrollContainer) scrollContainer.scrollTop = 0;
}

// --- ГЛАВНАЯ ---
async function loadHome() {
    const recGrid = document.getElementById('grid-recommendations');
    const chartsGrid = document.getElementById('grid-charts');
    if (!recGrid || !chartsGrid) return;
    recGrid.innerHTML = chartsGrid.innerHTML = getLoaderHTML();
    lucide.createIcons();
    
    try {
        const res = await fetch('/api/recommendations');
        const data = await res.json();
        
        const chartsTracks = await (await fetch('/api/explore')).json();
        
        if (data.tracks && data.tracks.length) {
            renderTrackCards(recGrid, data.tracks, data.tracks);
        } else {
            recGrid.innerHTML = `<p class="text-muted text-sm col-span-full text-center py-8">Нет рекомендаций</p>`;
        }
        if (chartsTracks.tracks && chartsTracks.tracks.length) {
            renderTrackCards(chartsGrid, chartsTracks.tracks, chartsTracks.tracks);
        }
        
        // Автоплейлисты ListenBrainz
        const lbSection = document.getElementById('section-lb-playlists');
        const lbGrid = document.getElementById('grid-lb-playlists');
        if (data.playlists && data.playlists.length && lbSection && lbGrid) {
            lbSection.classList.remove('hidden');
            lbGrid.innerHTML = data.playlists.map(pl => `
                <div class="music-card p-3 cursor-pointer group" onclick="openListenBrainzPlaylist('${pl.id}', '${escapeHtml(pl.name||'').replace(/'/g,"\\'")}')">
                    <div class="w-full aspect-square rounded-xl mb-3 overflow-hidden bg-surface-hover flex items-center justify-center">
                        <i data-lucide="list-music" class="w-10 h-10 text-primary"></i>
                    </div>
                    <h4 class="font-medium text-sm text-main truncate">${escapeHtml(pl.name || 'Playlist')}</h4>
                    <p class="text-xs text-muted truncate mt-0.5">${pl.track_count || 0} треков</p>
                </div>
            `).join('');
            lucide.createIcons();
        } else if (lbSection) {
            lbSection.classList.add('hidden');
        }
    } catch (e) {
        recGrid.innerHTML = `<p class="text-muted text-sm col-span-full text-center py-8">Ошибка загрузки</p>`;
        showToast("Ошибка загрузки главной", "error");
    }
}

async function openListenBrainzPlaylist(plId, name) {
    if (!plId) { showToast("Плейлист недоступен", "error"); return; }
    switchTab('playlist-view');
    const container = document.getElementById('tab-playlist-view');
    container.innerHTML = getLoaderHTML();
    lucide.createIcons();
    try {
        const res = await fetch(`/api/lb_playlist/${encodeURIComponent(plId)}`);
        if (res.status === 401) { container.innerHTML = `<div class="text-center py-20 text-muted text-sm">Нужен токен ListenBrainz (Настройки)</div>`; return; }
        const data = await res.json();
        const tracks = data.tracks || [];
        container.innerHTML = `
            <div class="flex flex-col md:flex-row gap-6 mb-8">
                <div class="w-48 h-48 rounded-2xl bg-surface-hover flex items-center justify-center flex-shrink-0">
                    <i data-lucide="list-music" class="w-16 h-16 text-primary"></i>
                </div>
                <div class="flex flex-col justify-end">
                    <span class="text-xs text-muted uppercase tracking-wider mb-1">Плейлист ListenBrainz</span>
                    <h2 class="text-4xl font-bold text-main mb-2">${escapeHtml(name || 'Плейлист')}</h2>
                    <p class="text-muted text-sm">${tracks.length} треков</p>
                </div>
            </div>
            <div id="lb-playlist-tracks-container"></div>
        `;
        const tracksContainer = document.getElementById('lb-playlist-tracks-container');
        if (tracksContainer && tracks.length) {
            renderTrackList(tracksContainer, tracks, tracks, true);
        } else {
            tracksContainer.innerHTML = `<p class="text-center py-12 text-muted text-sm">Плейлист пуст</p>`;
        }
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p class="text-center py-20 text-muted text-sm">Ошибка загрузки плейлиста</p>`;
    }
}

// --- ПОИСК ---
function setSearchFilter(filter, btn) {
    state.searchFilter = filter;
    document.querySelectorAll('.search-filter-btn').forEach(b => {
        b.className = 'search-filter-btn px-4 py-1.5 rounded-full text-sm font-medium transition-colors bg-transparent border border-border-color text-muted hover:bg-surface-hover';
    });
    if (btn) btn.className = 'search-filter-btn px-4 py-1.5 rounded-full text-sm font-medium transition-colors bg-primary text-black';
    if (state.searchQuery) performSearch(true);
}

async function performSearch(clear = false) {
    const input = document.getElementById('search-input');
    if (!input) return;
    const q = input.value.trim();
    if (!q) return;
    
    if (clear) { state.searchOffset = 0; state.searchHasMore = true; }
    if (!state.searchHasMore) return;
    
    state.searchQuery = q;
    state.searchLoading = true;
    const results = document.getElementById('search-results');
    if (clear) results.innerHTML = getLoaderHTML();
    lucide.createIcons();
    
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&filter=${state.searchFilter}&limit=${state.searchLimit}&offset=${state.searchOffset}`);
        const data = await res.json();
        
        if (clear) results.innerHTML = '';
        
        if (!data.tracks || data.tracks.length === 0) {
            if (clear) results.innerHTML = `<div class="text-center py-20 text-muted"><p class="text-sm">Ничего не найдено</p></div>`;
            state.searchHasMore = false;
            return;
        }
        
        const queue = data.tracks;
        if (state.searchFilter === 'songs') {
            const wrapper = document.createElement('div');
            wrapper.className = 'space-y-0.5';
            if (clear) results.appendChild(wrapper);
            else results.querySelector('.space-y-0\\.5')?.appendChild(wrapper) || results.appendChild(wrapper);
            renderTrackList(wrapper, data.tracks, [...(window._searchAllTracks||[]), ...data.tracks], false, null, false);
            window._searchAllTracks = clear ? [...data.tracks] : [...(window._searchAllTracks||[]), ...data.tracks];
        } else if (state.searchFilter === 'artists') {
            renderArtistCards(results, data.tracks, clear);
        } else if (state.searchFilter === 'albums') {
            renderAlbumCards(results, data.tracks, clear);
        } else if (state.searchFilter === 'playlists') {
            renderPlaylistSearchCards(results, data.tracks, clear);
        }
        
        state.searchOffset += data.tracks.length;
        state.searchHasMore = data.tracks.length >= state.searchLimit;
    } catch (e) {
        showToast("Ошибка поиска", "error");
        if (clear) results.innerHTML = `<div class="text-center py-20 text-muted"><p class="text-sm">Ошибка поиска</p></div>`;
    } finally {
        state.searchLoading = false;
    }
}

function renderArtistCards(container, artists, clear) {
    const html = artists.map(a => `
        <div class="music-card p-3 cursor-pointer group" onclick="openArtist('${a.id}', '${escapeHtml(a.title).replace(/'/g,"\\'")}')">
            <div class="w-full aspect-square rounded-xl mb-3 overflow-hidden bg-surface-hover">
                ${a.cover_url ? `<img src="${a.cover_url}" class="w-full h-full object-cover transition-transform group-hover:scale-105">` : `<div class="w-full h-full flex items-center justify-center"><i data-lucide="user" class="w-10 h-10 text-muted"></i></div>`}
            </div>
            <h4 class="font-medium text-sm text-main truncate">${escapeHtml(a.title)}</h4>
            <p class="text-xs text-muted truncate mt-0.5">${escapeHtml(a.subscribers || '')}</p>
        </div>
    `).join('');
    injectSearchHTML(container, html, clear);
}

function renderAlbumCards(container, albums, clear) {
    const html = albums.map(a => `
        <div class="music-card p-3 cursor-pointer group" onclick="openAlbum('${a.id}', '${escapeHtml(a.title).replace(/'/g,"\\'")}')">
            <div class="w-full aspect-square rounded-xl mb-3 overflow-hidden bg-surface-hover">
                ${a.cover_url ? `<img src="${a.cover_url}" class="w-full h-full object-cover transition-transform group-hover:scale-105">` : `<div class="w-full h-full flex items-center justify-center"><i data-lucide="disc" class="w-10 h-10 text-muted"></i></div>`}
            </div>
            <h4 class="font-medium text-sm text-main truncate">${escapeHtml(a.title)}</h4>
            <p class="text-xs text-muted truncate mt-0.5">${escapeHtml(a.artist || '')}</p>
        </div>
    `).join('');
    injectSearchHTML(container, html, clear);
}

function renderPlaylistSearchCards(container, playlists, clear) {
    const html = playlists.map(p => `
        <div class="music-card p-3 cursor-pointer group">
            <div class="w-full aspect-square rounded-xl mb-3 overflow-hidden bg-surface-hover flex items-center justify-center">
                <i data-lucide="list-music" class="w-10 h-10 text-primary"></i>
            </div>
            <h4 class="font-medium text-sm text-main truncate">${escapeHtml(p.title)}</h4>
            <p class="text-xs text-muted truncate mt-0.5">Плейлист Deezer</p>
        </div>
    `).join('');
    injectSearchHTML(container, html, clear);
}

function injectSearchHTML(container, html, clear) {
    if (clear) {
        container.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">${html}</div>`;
    } else {
        const grid = container.querySelector('.grid');
        if (grid) grid.insertAdjacentHTML('beforeend', html);
    }
    lucide.createIcons();
}

function setupInfiniteScrollListener() {
    const container = document.getElementById('main-scroll-container');
    if (!container) return;
    container.addEventListener('scroll', () => {
        if (state.searchLoading || !state.searchHasMore || !state.searchQuery) return;
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 200) {
            performSearch(false);
        }
    });
}

// --- СТРАНИЦА ИСПОЛНИТЕЛЯ ---
async function openArtist(artistId, artistName = '') {
    switchTab('artist-view');
    const container = document.getElementById('tab-artist-view');
    container.innerHTML = getLoaderHTML();
    lucide.createIcons();
    
    try {
        const res = await fetch(`/api/artist/${artistId}`);
        const data = await res.json();
        if (!data.name) throw new Error("Not found");
        
        container.innerHTML = `
            <div class="flex flex-col md:flex-row gap-6 mb-8">
                <img src="${data.cover_url || getFallbackCover(data.name, '')}" class="w-48 h-48 rounded-2xl object-cover shadow-lg">
                <div class="flex flex-col justify-end">
                    <h2 class="text-4xl font-bold text-main mb-2">${escapeHtml(data.name)}</h2>
                    <p class="text-muted text-sm">${escapeHtml(data.description || '')}</p>
                </div>
            </div>
            <h3 class="text-xl font-semibold mb-4 text-main">Популярные треки</h3>
            <div id="artist-top-tracks" class="mb-8"></div>
            <h3 class="text-xl font-semibold mb-4 text-main">Альбомы</h3>
            <div id="artist-albums" class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4"></div>
        `;
        
        const topTracks = data.top_tracks || [];
        const topContainer = document.getElementById('artist-top-tracks');
        if (topContainer && topTracks.length) {
            renderTrackList(topContainer, topTracks, topTracks, true);
        }
        
        const albumsGrid = document.getElementById('artist-albums');
        if (albumsGrid && data.albums && data.albums.length) {
            albumsGrid.innerHTML = data.albums.map(a => `
                <div class="music-card p-3 cursor-pointer group" onclick="openAlbum('${a.id}', '${escapeHtml(a.title).replace(/'/g,"\\'")}')">
                    <div class="w-full aspect-square rounded-xl mb-3 overflow-hidden bg-surface-hover">
                        ${a.cover_url ? `<img src="${a.cover_url}" class="w-full h-full object-cover transition-transform group-hover:scale-105">` : ''}
                    </div>
                    <h4 class="font-medium text-sm text-main truncate">${escapeHtml(a.title)}</h4>
                    <p class="text-xs text-muted truncate mt-0.5">${escapeHtml(a.year || '')}</p>
                </div>
            `).join('');
        }
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<div class="text-center py-20 text-muted"><p class="text-sm">Исполнитель не найден</p></div>`;
    }
}

// --- СТРАНИЦА АЛЬБОМА ---
async function openAlbum(albumId, albumName = '') {
    switchTab('album-view');
    const container = document.getElementById('tab-album-view');
    container.innerHTML = getLoaderHTML();
    lucide.createIcons();
    
    try {
        const res = await fetch(`/api/album/${albumId}`);
        const data = await res.json();
        if (!data.title) throw new Error("Not found");
        
        container.innerHTML = `
            <div class="flex flex-col md:flex-row gap-6 mb-8">
                <img src="${data.cover_url || getFallbackCover(data.artist, data.title)}" class="w-48 h-48 rounded-2xl object-cover shadow-lg">
                <div class="flex flex-col justify-end">
                    <span class="text-xs text-muted uppercase tracking-wider mb-1">Альбом</span>
                    <h2 class="text-4xl font-bold text-main mb-2">${escapeHtml(data.title)}</h2>
                    <p class="text-muted text-sm">${escapeHtml(data.artist)} • ${escapeHtml(data.year || '')} • ${data.track_count || 0} треков</p>
                </div>
            </div>
            <div id="album-tracks"></div>
        `;
        
        const tracks = data.tracks || [];
        const tracksContainer = document.getElementById('album-tracks');
        if (tracksContainer && tracks.length) {
            renderTrackList(tracksContainer, tracks, tracks, true);
        }
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<div class="text-center py-20 text-muted"><p class="text-sm">Альбом не найден</p></div>`;
    }
}

// --- РАДИО ---
async function openRadio(track = null, title = 'Радио', cover = '') {
    switchTab('home');
    showToast(`Загрузка радио: ${title}...`);
    
    let tracks = [];
    try {
        if (track) {
            const params = `?track_id=${encodeURIComponent(track.id||'')}&artist=${encodeURIComponent(track.artist||'')}&title=${encodeURIComponent(track.title||'')}`;
            const res = await fetch(`/api/radio${params}`);
            const data = await res.json();
            tracks = data.tracks || [];
        } else {
            const res = await fetch('/api/explore');
            const data = await res.json();
            tracks = data.tracks || [];
        }
    } catch (e) {
        showToast("Ошибка загрузки радио", "error");
        return;
    }
    
    if (tracks.length === 0) {
        showToast("Радио недоступно", "error");
        return;
    }
    
    playTrack(tracks[0], tracks, 0);
}

// --- МЕДИАТЕКА ---
async function loadLibrary(type) {
    const content = document.getElementById('library-content');
    if (!content) return;
    
    document.querySelectorAll('.lib-tab-btn').forEach(b => {
        b.classList.remove('bg-primary', 'text-black');
        b.classList.add('text-muted');
    });
    const btnMap = { favorites: 'lib-btn-favorites', playlists: 'lib-btn-playlists', history: 'lib-btn-history', local: 'lib-btn-local' };
    const btn = document.getElementById(btnMap[type]);
    if (btn) { btn.classList.add('bg-primary', 'text-black'); btn.classList.remove('text-muted'); }
    
    content.innerHTML = getLoaderHTML();
    lucide.createIcons();
    
    try {
        if (type === 'favorites') {
            const res = await fetch('/api/favorites');
            const data = await res.json();
            if (data.tracks && data.tracks.length) {
                renderTrackList(content, data.tracks, data.tracks, false);
            } else {
                content.innerHTML = `<p class="text-center py-12 text-muted text-sm">Избранное пусто</p>`;
            }
        } else if (type === 'playlists') {
            await loadPlaylists();
            renderPlaylistsList(content);
        } else if (type === 'history') {
            const res = await fetch('/api/history');
            const data = await res.json();
            if (data.tracks && data.tracks.length) {
                renderTrackList(content, data.tracks, data.tracks, false);
            } else {
                content.innerHTML = `<p class="text-center py-12 text-muted text-sm">История пуста</p>`;
            }
        } else if (type === 'local') {
            await loadLibraryTracks();
        }
    } catch (e) {
        content.innerHTML = `<p class="text-center py-12 text-muted text-sm">Ошибка загрузки</p>`;
        showToast("Ошибка загрузки медиатеки", "error");
    }
}

// --- ПЛЕЙЛИСТЫ ---
async function loadPlaylists() {
    try {
        const res = await fetch('/api/playlists');
        const data = await res.json();
        state.playlists = data.playlists || [];
    } catch (e) {}
}

function renderPlaylistsList(container) {
    if (!state.playlists || state.playlists.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12">
                <p class="text-muted text-sm mb-4">У вас нет плейлистов</p>
                <button onclick="openCreatePlaylistModal()" class="px-5 py-2.5 rounded-xl bg-primary text-black font-medium text-sm hover:bg-primary-hover transition-colors">Создать плейлист</button>
            </div>`;
        return;
    }
    container.innerHTML = `
        <div class="flex justify-between items-center mb-4">
            <button onclick="openCreatePlaylistModal()" class="px-4 py-2 rounded-lg bg-surface-hover text-primary text-sm font-medium hover:bg-border-color transition-colors">+ Создать</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            ${state.playlists.map(p => `
                <div class="flex items-center gap-3 p-3 track-row cursor-pointer" onclick="openPlaylist(${p.id})">
                    <div class="w-12 h-12 rounded-md overflow-hidden bg-surface-hover flex items-center justify-center flex-shrink-0">
                        ${p.cover_url ? `<img src="${p.cover_url}" class="w-full h-full object-cover">` : `<i data-lucide="list-music" class="w-5 h-5 text-primary"></i>`}
                    </div>
                    <div class="min-w-0 flex-1">
                        <h4 class="font-medium text-sm text-main truncate">${escapeHtml(p.name)}</h4>
                        <p class="text-xs text-muted">${p.track_count || 0} треков</p>
                    </div>
                    <button onclick="event.stopPropagation(); deletePlaylist(${p.id})" class="p-2 text-muted hover:text-red-500 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                </div>
            `).join('')}
        </div>`;
    lucide.createIcons();
}

async function openPlaylist(plId) {
    switchTab('playlist-view');
    const container = document.getElementById('tab-playlist-view');
    container.innerHTML = getLoaderHTML();
    lucide.createIcons();
    
    try {
        const res = await fetch(`/api/playlists/${plId}/tracks`);
        const data = await res.json();
        const pl = state.playlists.find(p => p.id === plId);
        
        container.innerHTML = `
            <div class="flex flex-col md:flex-row gap-6 mb-8">
                <div class="w-48 h-48 rounded-2xl bg-surface-hover flex items-center justify-center flex-shrink-0">
                    ${pl && pl.cover_url ? `<img src="${pl.cover_url}" class="w-full h-full object-cover rounded-2xl">` : `<i data-lucide="list-music" class="w-16 h-16 text-primary"></i>`}
                </div>
                <div class="flex flex-col justify-end">
                    <span class="text-xs text-muted uppercase tracking-wider mb-1">Плейлист</span>
                    <h2 class="text-4xl font-bold text-main mb-2">${escapeHtml(pl ? pl.name : 'Плейлист')}</h2>
                    <p class="text-muted text-sm">${(data.tracks||[]).length} треков</p>
                </div>
            </div>
            <div id="playlist-tracks-container"></div>
        `;
        
        const tracks = data.tracks || [];
        const tracksContainer = document.getElementById('playlist-tracks-container');
        if (tracksContainer && tracks.length) {
            renderTrackList(tracksContainer, tracks, tracks, true, plId);
        } else {
            tracksContainer.innerHTML = `<p class="text-center py-12 text-muted text-sm">Плейлист пуст</p>`;
        }
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p class="text-center py-20 text-muted text-sm">Ошибка загрузки плейлиста</p>`;
    }
}

async function createPlaylist(name, description = "") {
    try {
        await fetch('/api/playlists', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name, description }) });
        showToast("Плейлист создан");
        await loadPlaylists();
        loadLibrary('playlists');
    } catch (e) {
        showToast("Ошибка создания плейлиста", "error");
    }
}

async function deletePlaylist(plId) {
    if (!confirm("Удалить плейлист?")) return;
    try {
        await fetch(`/api/playlists/${plId}`, { method: 'DELETE' });
        showToast("Плейлист удалён");
        await loadPlaylists();
        loadLibrary('playlists');
    } catch (e) {
        showToast("Ошибка удаления", "error");
    }
}

async function removeTrackFromPlaylist(playlistId, trackId) {
    try {
        await fetch(`/api/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' });
        showToast("Трек удалён из плейлиста");
        openPlaylist(playlistId);
    } catch (e) {
        showToast("Ошибка удаления трека", "error");
    }
}

// --- НАСТРОЙКИ ---
async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        state.settings = { ...state.settings, ...data };
        loadSettingsIntoUI();
    } catch (e) {}
}

function loadSettingsIntoUI() {
    const tokenInput = document.getElementById('input-lb-token');
    if (tokenInput) {
        tokenInput.value = state.settings.lb_token_set ? state.settings.lb_token : '';
        tokenInput.placeholder = state.settings.lb_token_set ? 'Токен сохранён (введите новый для замены)' : '1234abcd-...';
    }
    const qSel = document.getElementById('select-audio-quality');
    if (qSel) qSel.value = state.settings.audio_quality || 'high';
    const eqSel = document.getElementById('select-eq-preset');
    if (eqSel) eqSel.value = state.settings.equalizer_preset || 'flat';
    const smSel = document.getElementById('select-stream-mode');
    if (smSel) smSel.value = state.settings.stream_mode || 'proxy';
    const themeSel = document.getElementById('select-theme-style');
    if (themeSel) themeSel.value = localStorage.getItem('cascade_theme_v3') || 'dark';
    renderBlacklistSettings();
}

function renderBlacklistSettings() {
    const container = document.getElementById('settings-blacklist-container');
    if (!container) return;
    const blocked = Array.from(state.blockedArtists);
    container.innerHTML = `
        <div class="flex gap-2 mb-4">
            <input type="text" id="input-block-artist" class="flex-1 p-3 rounded-lg bg-surface-hover text-main border border-transparent outline-none text-sm" placeholder="Имя исполнителя для блокировки">
            <button onclick="blockArtistFromInput()" class="bg-primary text-black px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors">Блокировать</button>
        </div>
        ${blocked.length === 0 ? '<p class="text-muted text-sm">Список пуст</p>' : `
            <div class="space-y-1">
                ${blocked.map(a => `
                    <div class="flex items-center justify-between p-2 rounded-lg bg-surface-hover">
                        <span class="text-sm text-main">${escapeHtml(a)}</span>
                        <button onclick="unblockArtist('${escapeHtml(a).replace(/'/g,"\\'")}')" class="text-muted hover:text-red-500 p-1"><i data-lucide="x" class="w-4 h-4"></i></button>
                    </div>
                `).join('')}
            </div>
        `}
    `;
    lucide.createIcons();
}

async function blockArtistFromInput() {
    const input = document.getElementById('input-block-artist');
    if (!input || !input.value.trim()) return;
    try {
        await fetch('/api/block_artist', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ artist: input.value.trim() }) });
        state.blockedArtists.add(input.value.trim().toLowerCase());
        input.value = '';
        showToast("Исполнитель заблокирован");
        renderBlacklistSettings();
    } catch (e) {
        showToast("Ошибка блокировки", "error");
    }
}

async function unblockArtist(artist) {
    try {
        await fetch(`/api/block_artist?artist=${encodeURIComponent(artist)}`, { method: 'DELETE' });
        state.blockedArtists.delete(artist.toLowerCase().trim());
        showToast("Исполнитель разблокирован");
        renderBlacklistSettings();
    } catch (e) {
        showToast("Ошибка разблокировки", "error");
    }
}

async function saveSettings() {
    const tokenInput = document.getElementById('input-lb-token');
    const qSel = document.getElementById('select-audio-quality');
    const eqSel = document.getElementById('select-eq-preset');
    const smSel = document.getElementById('select-stream-mode');
    
    const payload = {};
    // Отправляем токен только если пользователь ввёл новый (не маску и не пустой)
    if (tokenInput && tokenInput.value.trim() && !tokenInput.value.startsWith('*')) {
        payload.lb_token = tokenInput.value.trim();
    }
    if (qSel) payload.audio_quality = qSel.value;
    if (eqSel) payload.equalizer_preset = eqSel.value;
    if (smSel) payload.stream_mode = smSel.value;
    
    try {
        await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
        showToast("Настройки сохранены");
        await loadSettings();
        applyEqPreset(payload.equalizer_preset || state.settings.equalizer_preset || 'flat');
    } catch (e) {
        showToast("Ошибка сохранения настроек", "error");
    }
}

// --- СТАТИСТИКА ---
async function loadStats() {
    const container = document.getElementById('stats-content');
    if (!container) return;
    container.innerHTML = getLoaderHTML();
    lucide.createIcons();
    
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        
        if (data.status === 'no_token') {
            container.innerHTML = `<div class="bg-card p-8 rounded-2xl border border-border-color text-center"><p class="text-muted text-sm mb-4">Для статистики нужен ListenBrainz токен</p><button onclick="switchTab('settings')" class="px-5 py-2.5 rounded-xl bg-primary text-black font-medium text-sm">Открыть настройки</button></div>`;
            return;
        }
        if (data.status === 'invalid_token') {
            container.innerHTML = `<p class="text-center py-12 text-muted text-sm">Неверный токен ListenBrainz</p>`;
            return;
        }
        
        const stats = data.stats || {};
        const topArtists = stats.top_artists || [];
        const recent = stats.recent_listens || [];
        
        container.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div class="bg-card p-6 rounded-2xl border border-border-color">
                    <h3 class="text-lg font-medium mb-4 text-main">Топ исполнителей (неделя)</h3>
                    ${topArtists.length ? topArtists.map((a, i) => `
                        <div class="flex items-center justify-between py-2 border-b border-border-color last:border-0">
                            <span class="text-sm text-main"><span class="text-muted mr-2">${i+1}.</span>${escapeHtml(a.artist)}</span>
                            <span class="text-xs text-muted">${a.listen_count} прослушиваний</span>
                        </div>
                    `).join('') : '<p class="text-muted text-sm">Нет данных</p>'}
                </div>
                <div class="bg-card p-6 rounded-2xl border border-border-color">
                    <h3 class="text-lg font-medium mb-4 text-main">Недавно прослушанное</h3>
                    ${recent.length ? recent.slice(0, 10).map(t => `
                        <div class="flex items-center gap-3 py-2 border-b border-border-color last:border-0">
                            <div class="min-w-0">
                                <h4 class="text-sm font-medium text-main truncate">${escapeHtml(t.title)}</h4>
                                <p class="text-xs text-muted truncate">${escapeHtml(t.artist)}</p>
                            </div>
                        </div>
                    `).join('') : '<p class="text-muted text-sm">Нет данных</p>'}
                </div>
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<p class="text-center py-12 text-muted text-sm">Ошибка загрузки статистики</p>`;
    }
}

// --- ТАЙМЕР СНА (Sleep Timer) ---
state.sleepTimer = null;
state.sleepTimerEnd = 0;

function setSleepTimer(minutes) {
    if (state.sleepTimer) { clearTimeout(state.sleepTimer); state.sleepTimer = null; }
    if (minutes <= 0) { showToast("Таймер сна отключён"); return; }
    state.sleepTimerEnd = Date.now() + minutes * 60000;
    state.sleepTimer = setTimeout(() => {
        if (activePlayer && !activePlayer.paused) activePlayer.pause();
        showToast("Таймер сна сработал — воспроизведение остановлено");
        state.sleepTimer = null;
    }, minutes * 60000);
    showToast(`Таймер сна установлен на ${minutes} мин`);
}

// --- ЛОКАЛЬНАЯ МЕДИАТЕКА ---
async function scanLocalLibrary() {
    showToast("Сканирование локальной музыки...");
    try {
        const res = await fetch('/api/library/scan');
        const data = await res.json();
        showToast(`Найдено ${data.count} треков`);
        switchTab('library');
        loadLibrary('local');
    } catch (e) {
        showToast("Ошибка сканирования", "error");
    }
}

async function loadLibraryTracks() {
    const content = document.getElementById('library-content');
    if (!content) return;
    content.innerHTML = getLoaderHTML();
    lucide.createIcons();
    try {
        const res = await fetch('/api/library/tracks');
        const data = await res.json();
        const tracks = (data.tracks || []).map(t => ({...t, isLocal: true}));
        if (tracks.length) {
            renderTrackList(content, tracks, tracks, false);
        } else {
            content.innerHTML = `<div class="text-center py-12"><p class="text-muted text-sm mb-4">Локальная медиатека пуста</p><button onclick="scanLocalLibrary()" class="px-5 py-2.5 rounded-xl bg-primary text-black font-medium text-sm hover:bg-primary-hover transition-colors">Сканировать</button></div>`;
        }
    } catch (e) {
        content.innerHTML = `<p class="text-center py-12 text-muted text-sm">Ошибка</p>`;
    }
}