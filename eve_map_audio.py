"""Native Windows soundtrack control for the optional New Eden music.

Audio only receives already-validated IntelAlert events from the GUI bridge.
It never reads R2Z2, ESI, or map topology itself.
"""
from __future__ import annotations

import os
import queue
import random
import threading
import time
from pathlib import Path


# WMP owns one native decoder, so this is a short sequential fade rather than
# two tracks overlapping.  It still avoids the abrupt stop/start hand-off.
TRACK_CHANGE_FADE_OUT_MS = 450
TRACK_CHANGE_FADE_IN_MS = 900


class EveMapMusic:
    """Windows Media Player COM session with fades and proximity ducking."""

    def __init__(self, source=None, *, player_factory=None, clock=time.monotonic, start_delay_ms=1800, monitor_interval=.5):
        self.source = Path(source) if source else None
        self._player_factory = player_factory
        self._clock = clock
        self._start_delay_ms = max(0, int(start_delay_ms))
        self._monitor_interval = max(.1, float(monitor_interval))
        self._lock = threading.RLock()
        self._worker_start_lock = threading.Lock()
        self._prepare_lock = threading.Lock()
        self._commands = queue.Queue()
        self._worker = None
        self._player_ready = threading.Event()
        self._player_error = None
        self._playing = self._visible = self._manually_paused = False
        self._volume = .30
        self._output_volume = 0.0
        self._duck_multiplier = 1.0
        self._duck_until = 0.0
        self._fade_generation = self._duck_generation = 0
        self._start_generation = self._monitor_generation = 0
        self._starting = False
        self._shuffle = False
        self._tracks: list[Path] = []
        self._track_index = 0
        self._error = None

    @property
    def available(self):
        return bool(os.name == "nt" and self.source and self.source.is_file())

    @staticmethod
    def duck_multiplier(distance_jumps):
        distance = max(0, int(distance_jumps or 0))
        return .15 if distance <= 1 else .35 if distance <= 3 else .60

    def state(self):
        with self._lock:
            return {"ok": self.available and not self._error, "available": self.available, "playing": self._playing,
                    "visible": self._visible, "manually_paused": self._manually_paused, "volume": self._volume,
                    "duck_multiplier": self._duck_multiplier, "shuffle": self._shuffle, "starting": self._starting,
                    "track": self._current_track_locked().name if self._tracks else None,
                    "playlist_count": len(self._tracks), "track_index": self._track_index,
                    # The UI gets display names only: a private local path is never exposed.
                    "playlist": [track.name for track in self._tracks], "error": self._error}

    def set_visible(self, visible):
        with self._lock:
            self._visible = bool(visible)
            if self._visible and not self._manually_paused: self._start_locked(2500)
            elif not self._visible:
                self._start_generation += 1
                self._monitor_generation += 1
                self._starting = False
                self._fade_locked(0, 600, pause_after=True)
            return self.state()

    def toggle(self):
        with self._lock:
            self._start_generation += 1
            if self._playing or self._starting:
                self._manually_paused = True
                # The fade remains audible for 180 ms, but the returned bridge
                # state must immediately flip the UI to the play icon.
                self._playing = False
                self._starting = False
                self._fade_locked(0, 180, pause_after=True)
            else:
                self._manually_paused = False
                # Manual play is also the first audio bridge call in the
                # temporary A/B mode where opening New Eden does not touch WMP.
                self._visible = True
                self._start_locked(2500)
            return self.state()

    def set_shuffle(self, enabled):
        with self._lock:
            self._shuffle = bool(enabled)
            return self.state()

    def set_volume(self, value):
        with self._lock:
            self._volume = max(0.0, min(1.0, float(value)))
            if self._playing: self._fade_locked(self._effective_volume_locked(), 120)
            return self.state()

    def duck(self, distance_jumps):
        """Called once by the bridge after its proximity validation."""
        with self._lock:
            if not self.available: return self.state()
            self._duck_multiplier = min(self._duck_multiplier, self.duck_multiplier(distance_jumps))
            self._duck_until = max(self._duck_until, self._clock() + 3.0)
            if self._playing: self._fade_locked(self._effective_volume_locked(), 250)
            self._duck_generation += 1
            threading.Thread(target=self._restore_duck, args=(self._duck_generation,), name="mmd-music-duck", daemon=True).start()
            return self.state()

    def _start_locked(self, fade_ms):
        if not self.available: return False
        if self._playing and not self._starting:
            self._fade_locked(self._effective_volume_locked(), fade_ms)
            return True
        self._start_generation += 1
        self._starting, self._playing = True, False
        threading.Thread(target=self._prepare_and_start, args=(self._start_generation, fade_ms), name="mmd-music-prepare", daemon=True).start()
        return True

    def _start_is_current(self, generation):
        with self._lock:
            return generation == self._start_generation and self._visible and not self._manually_paused


    def _prepare_and_start(self, generation, fade_ms, start_delay_ms=None):
        # Player construction, COM waits, media readiness and grace delay all
        # live here. The bridge only flips inexpensive state and returns.
        with self._prepare_lock:
            if not self._start_is_current(generation): return
            with self._lock:
                # Folder enumeration belongs to the background preparation
                # path too: a large private playlist must not stall pywebview.
                self._refresh_tracks_locked()
            if not self._ensure_player() or not self._start_is_current(generation):
                with self._lock:
                    if generation == self._start_generation: self._starting = False
                return
            # WMP does not reliably publish wmposMediaOpen (13) for local MP3
            # files on every Windows build.  The existing worker-only grace
            # delay below is sufficient; do not reject playable media on that
            # advisory open-state signal.
            delay_ms = self._start_delay_ms if start_delay_ms is None else max(0, int(start_delay_ms))
            deadline = self._clock() + delay_ms / 1000
            while self._clock() < deadline:
                if not self._start_is_current(generation): return
                time.sleep(min(.10, deadline - self._clock()))
            if not self._start_is_current(generation) or not self._invoke("play"):
                with self._lock:
                    if generation == self._start_generation: self._starting = False
                return
            with self._lock:
                if generation != self._start_generation or not self._visible or self._manually_paused:
                    return
                self._starting, self._playing = False, True
                self._fade_locked(self._effective_volume_locked(), fade_ms)
                self._start_playback_monitor_locked()

    def _refresh_tracks_locked(self):
        if not self.source:
            self._tracks, self._track_index = [], 0
            return
        previous = self._current_track_locked() if self._tracks else self.source
        allowed = {".mp3", ".m4a", ".wma", ".wav", ".aac"}
        try:
            tracks = sorted((path for path in self.source.parent.iterdir() if path.is_file() and path.suffix.casefold() in allowed), key=lambda path: path.name.casefold())
        except OSError:
            tracks = []
        if self.source.is_file() and self.source not in tracks:
            tracks.append(self.source)
            tracks.sort(key=lambda path: path.name.casefold())
        self._tracks = tracks
        self._track_index = self._tracks.index(previous) if previous in self._tracks else (self._tracks.index(self.source) if self.source in self._tracks else 0)

    def _current_track_locked(self) -> Path:
        if self._tracks:
            return self._tracks[max(0, min(self._track_index, len(self._tracks) - 1))]
        return self.source

    def _select_next_track_locked(self):
        self._refresh_tracks_locked()
        if not self._tracks:
            return None
        if self._shuffle and len(self._tracks) > 1:
            choices = [index for index in range(len(self._tracks)) if index != self._track_index]
            self._track_index = random.choice(choices)
        else:
            self._track_index = (self._track_index + 1) % len(self._tracks)
        return self._current_track_locked()

    def _select_previous_track_locked(self):
        self._refresh_tracks_locked()
        if not self._tracks:
            return None
        self._track_index = (self._track_index - 1) % len(self._tracks)
        return self._current_track_locked()

    def _start_selected_track_locked(self, fade_ms, thread_name, *, fade_current=False):
        if not self._visible or not self.available:
            return False
        self._manually_paused = False
        self._start_generation += 1
        generation = self._start_generation
        fade_current = bool(fade_current and self._playing and not self._starting and self._worker is not None)
        self._starting, self._playing = True, False
        if fade_current:
            threading.Thread(
                target=self._fade_then_start_track,
                args=(generation, fade_ms),
                name=thread_name,
                daemon=True,
            ).start()
        else:
            threading.Thread(target=self._prepare_and_start, args=(generation, fade_ms), name=thread_name, daemon=True).start()
        return True

    def _fade_then_start_track(self, generation, fade_ms):
        """Quietly hand a playing WMP track to the next selected entry.

        This runs off the pywebview thread.  WMP has a single media channel,
        so it deliberately does not claim to be a two-deck crossfade.
        """
        with self._lock:
            self._fade_generation += 1
            fade_generation = self._fade_generation
            start_volume = self._output_volume
        steps = max(1, int(TRACK_CHANGE_FADE_OUT_MS / 50))
        for step in range(steps + 1):
            with self._lock:
                if generation != self._start_generation or fade_generation != self._fade_generation:
                    return
            self._set_output_volume(start_volume * (1 - step / steps))
            if step < steps:
                time.sleep(TRACK_CHANGE_FADE_OUT_MS / steps / 1000)
        if not self._start_is_current(generation):
            return
        self._invoke("pause")
        self._prepare_and_start(generation, fade_ms, start_delay_ms=0)

    def select_track(self, index):
        """Select a discovered local playlist entry and play it when visible."""
        with self._lock:
            self._refresh_tracks_locked()
            try:
                index = int(index)
            except (TypeError, ValueError):
                return self.state()
            if not 0 <= index < len(self._tracks):
                return self.state()
            self._track_index = index
            self._start_selected_track_locked(TRACK_CHANGE_FADE_IN_MS, "mmd-music-select", fade_current=True)
            return self.state()
    def next_track(self):
        """Select and play the next local track; Intel sound is unaffected."""
        with self._lock:
            if self._select_next_track_locked() is None:
                return self.state()
            self._start_selected_track_locked(TRACK_CHANGE_FADE_IN_MS, "mmd-music-next", fade_current=True)
            return self.state()

    def previous_track(self):
        """Select and play the previous local track, looping at the start."""
        with self._lock:
            if self._select_previous_track_locked() is None:
                return self.state()
            self._start_selected_track_locked(TRACK_CHANGE_FADE_IN_MS, "mmd-music-previous", fade_current=True)
            return self.state()

    def advance_after_track_end(self):
        """Advance/restart after a native media-ended notification or poll."""
        with self._lock:
            if not self._visible or self._manually_paused or not self.available:
                return False
            if self._select_next_track_locked() is None:
                return False
            return self._start_selected_track_locked(TRACK_CHANGE_FADE_IN_MS, "mmd-music-next")

    def _ensure_player(self):
        # This function intentionally runs only on mmd-music-prepare, never
        # from an exposed pywebview API method.
        with self._worker_start_lock:
            if self._worker is None:
                self._worker = threading.Thread(target=self._player_worker, name="mmd-new-eden-music", daemon=True)
                self._worker.start()
        self._player_ready.wait(.8)
        if self._player_error:
            self._error = self._player_error; return False
        with self._lock:
            path = str(self._current_track_locked())
        return self._invoke("load", path=path)

    def _start_playback_monitor_locked(self):
        self._monitor_generation += 1
        threading.Thread(target=self._monitor_playback, args=(self._monitor_generation,), name="mmd-music-monitor", daemon=True).start()

    def _monitor_playback(self, generation):
        while True:
            time.sleep(self._monitor_interval)
            with self._lock:
                if generation != self._monitor_generation or not self._visible or not self._playing or self._starting:
                    return
            state = self._status()
            if state == 8:  # Windows Media Player: media ended
                self.advance_after_track_end()
                return

    def _player_worker(self):
        pythoncom = None
        try:
            if self._player_factory: player = self._player_factory()
            else:
                import pythoncom
                from win32com.client import Dispatch
                pythoncom.CoInitialize()
                player = Dispatch("WMPlayer.OCX")
                player.settings.autoStart = False
                player.settings.mute = False
                player.settings.balance = 0
            self._player_ready.set()
        except Exception as exc:
            self._player_error = f"Windows audio unavailable: {exc}"; self._player_ready.set(); return
        while True:
            try:
                action, event, result = self._commands.get(timeout=.02)
            except queue.Empty:
                if pythoncom is not None:
                    pythoncom.PumpWaitingMessages()
                continue
            try:
                if action == "load":
                    player.URL = result["path"]
                    # WMP.URL may ignore autoStart=False on some Windows builds.
                    player.controls.stop()
                elif action == "play": player.controls.play()
                elif action == "pause": player.controls.pause()
                elif action == "volume": player.settings.volume = int(result["volume"])
                elif action == "status":
                    result["play_state"] = int(player.playState)
                    result["player_volume"] = int(player.settings.volume)
                elif action == "ready":
                    # A fake/test player has no openState; real WMP exposes
                    # wmposMediaOpen (13) once URL media can safely play.
                    open_state = getattr(player, "openState", None)
                    result["ready"] = open_state is None or int(open_state) == 13
                elif action == "close": player.close(); result["ok"] = True; event.set(); return
                result["ok"] = True
            except Exception as exc:
                result["error"] = str(exc)
            event.set()
            if pythoncom is not None:
                pythoncom.PumpWaitingMessages()

    def _invoke(self, action, *, volume=None, path=None):
        event, result = threading.Event(), {"volume": volume, "path": path}
        self._commands.put((action, event, result))
        if not event.wait(.8): self._error = "Windows audio timed out"; return False
        if not result.get("ok"):
            self._error = f"Windows audio unavailable: {result.get('error', 'unknown error')}"; return False
        self._error = None; return True

    def _status(self):
        event, result = threading.Event(), {}
        self._commands.put(("status", event, result))
        if not event.wait(.8) or not result.get("ok"):
            return None
        return result.get("play_state")

    def _media_ready(self):
        event, result = threading.Event(), {}
        self._commands.put(("ready", event, result))
        if not event.wait(.8) or not result.get("ok"):
            return False
        return bool(result.get("ready"))

    def _effective_volume_locked(self): return self._volume * self._duck_multiplier

    def _set_output_volume(self, volume):
        with self._lock:
            self._output_volume = max(0.0, min(1.0, volume))
            output = self._output_volume
        self._invoke("volume", volume=round(output * 100))

    def _fade_locked(self, target, duration_ms, pause_after=False):
        if self._worker is None: return
        self._fade_generation += 1
        threading.Thread(target=self._fade, args=(self._fade_generation, self._output_volume, max(0, min(1, target)), max(1, int(duration_ms)), pause_after), name="mmd-music-fade", daemon=True).start()

    def _fade(self, generation, start, target, duration_ms, pause_after):
        steps = max(1, int(duration_ms / 50))
        for step in range(steps + 1):
            with self._lock:
                if generation != self._fade_generation: return
            self._set_output_volume(start + (target - start) * step / steps)
            if step < steps: time.sleep(duration_ms / steps / 1000)
        with self._lock:
            should_pause = generation == self._fade_generation and pause_after
        if should_pause:
            self._invoke("pause")
            with self._lock:
                if generation == self._fade_generation: self._playing = False

    def _restore_duck(self, generation):
        while True:
            with self._lock: remaining = self._duck_until - self._clock()
            if remaining <= 0: break
            time.sleep(min(remaining, .25))
        with self._lock:
            if generation == self._duck_generation and self._clock() >= self._duck_until:
                self._duck_multiplier = 1.0
                if self._playing: self._fade_locked(self._effective_volume_locked(), 2000)
