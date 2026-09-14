"""Shared solar-system position cache. No network calls on a kill event."""
from dataclasses import asdict, dataclass
import threading
import time


@dataclass(frozen=True)
class TrackedCharacterPosition:
    character_id: int
    character_name: str
    system_id: int
    system_name: str
    source: str
    observed_at: float
    session_source: str = ''
    session_started: float = 0

    def payload(self, now):
        return {**asdict(self), 'name': self.character_name,
                'local_confirmed': self.source == 'LOCAL_CHATLOG' and 0 <= now - self.observed_at <= 30}


class TrackedPositions:
    """Local observations win for 30s; ESI supplies other/stale characters."""
    def __init__(self, *, map_service, characters, fetch_location, now=time.time):
        self.map_service, self.characters, self.fetch_location = map_service, characters, fetch_location
        self.now = now
        self._lock = threading.RLock()
        self._local, self._esi, self._attempts = {}, {}, {}
        self._inflight = set()
        self._listeners = []
        self._published = None
        self._names = None

    def subscribe(self, listener):
        with self._lock:
            if listener not in self._listeners:
                self._listeners.append(listener)

    def system_by_name(self, name):
        if self._names is None:
            self._names = {s['name'].casefold(): s for s in self.map_service.get_map_data()['systems']}
        return self._names.get(str(name).strip().casefold())

    def observe_local(self, *, character_id, character_name, system_name, observed_at,
                      session_source, session_started):
        system = self.system_by_name(system_name)
        now = self.now()
        if not system or not character_name or not 0 < int(character_id) or not 0 <= now - observed_at <= 30:
            return False
        # The filename ID and Listener must agree with a known SSO identity.
        # A Chatlog from an untracked client must not create a synthetic
        # tracked position just because it names a valid system.
        known = list(self.characters())
        matched = False
        for char in known:
            if (int(char['id']) == int(character_id) or char['name'].casefold() == character_name.casefold()):
                if int(char['id']) != int(character_id) or char['name'].casefold() != character_name.casefold():
                    return False
                matched = True
        if known and not matched:
            return False
        row = TrackedCharacterPosition(int(character_id), character_name, int(system['id']),
            system['name'], 'LOCAL_CHATLOG', observed_at, str(session_source), session_started)
        with self._lock:
            old = self._local.get(row.character_id)
            if old and (session_started < old.session_started or observed_at < old.observed_at):
                return False
            self._local[row.character_id] = row
        self.publish()
        return True

    def _effective(self):
        now = self.now()
        rows = []
        for cid in sorted(set(self._local) | set(self._esi)):
            local, esi = self._local.get(cid), self._esi.get(cid)
            if local and 0 <= now - local.observed_at <= 30:
                row = local
            elif esi and now - esi.observed_at <= 30:
                row = esi
            else:
                last = max((p for p in (local, esi) if p), key=lambda p: p.observed_at)
                if now - last.observed_at > 300:
                    continue
                row = TrackedCharacterPosition(last.character_id, last.character_name,
                    last.system_id, last.system_name, 'CACHE', last.observed_at)
            rows.append(row.payload(now))
        return {'ok': bool(rows), 'positions': rows, 'state': 'live' if rows else 'unavailable'}

    def snapshot(self):
        with self._lock:
            return self._effective()

    def publish(self):
        with self._lock:
            response = self._effective()
            key = tuple((r['character_id'], r['system_id'], r['source'], r['local_confirmed'])
                        for r in response['positions'])
            if key == self._published:
                return
            self._published = key
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(response)
            except Exception:
                import logging
                logging.getLogger(__name__).exception('PositionUpdate subscriber failed')

    def refresh(self):
        # A late ESI response is timestamped at request start and cannot replace
        # a newer Local observation. No cache lock is held during the request.
        errors = []
        for char in self.characters():
            cid, now = int(char['id']), self.now()
            with self._lock:
                local = self._local.get(cid)
                if local and 0 <= now - local.observed_at <= 30:
                    continue
                if cid in self._inflight or now - self._attempts.get(cid, -float('inf')) < 15:
                    continue
                self._inflight.add(cid)
                self._attempts[cid] = now
            try:
                system_id = self.fetch_location(cid)
                system = self.map_service.get_system(system_id) if system_id else None
                if system:
                    row = TrackedCharacterPosition(cid, char['name'], int(system['id']), system['name'], 'ESI', now)
                    with self._lock:
                        self._esi[cid] = row
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                with self._lock:
                    self._inflight.discard(cid)
        self.publish()
        return {**self.snapshot(), 'errors': errors}
