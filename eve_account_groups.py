"""User-declared EVE accounts, never inferred from SSO or owner hashes.

Availability means account compatibility only, not online/cyno capability.
Multiple characters with any unassigned account are conservatively unavailable.
"""
import json
import os
from pathlib import Path
import threading

_lock = threading.RLock()


def _id(value):
    if isinstance(value, bool) or not str(value).isdigit() or int(value) <= 0:
        raise ValueError('Invalid character/account ID')
    return str(int(value))


class AccountGroups:
    def __init__(self, path=None):
        root = Path(os.environ.get('APPDATA', Path.home() / 'AppData' / 'Roaming'))
        self.path = Path(path) if path is not None else root / 'MMD-Trader' / 'account_groups.json'

    def _read(self):
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {}
        if not isinstance(data, dict):
            raise ValueError('Invalid account groups file')
        return {_id(cid): _id(group) for cid, group in data.items()}

    def characters(self, characters):
        with _lock:
            groups = self._read()
        return [dict(row, account_group_id=groups.get(_id(row['id']))) for row in characters]

    def assign(self, character_id, account_group_id):
        cid = _id(character_id)
        group = None if account_group_id is None else _id(account_group_id)
        with _lock:
            groups = self._read()
            if group is None:
                groups.pop(cid, None)
            else:
                groups[cid] = group
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps(groups, sort_keys=True), encoding='utf-8')
            temporary.replace(self.path)
        return group

    def characters_simultaneously_available(self, character_ids):
        ids = [_id(cid) for cid in character_ids]
        if len(ids) != len(set(ids)):
            return False
        if len(ids) <= 1:
            return True
        with _lock:
            groups = self._read()
        assigned = [groups.get(cid) for cid in ids]
        return None not in assigned and len(assigned) == len(set(assigned))


def characters_simultaneously_available(character_ids):
    return AccountGroups().characters_simultaneously_available(character_ids)
