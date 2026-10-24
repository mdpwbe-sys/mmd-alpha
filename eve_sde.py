"""First-run CCP SDE installation, outside the executable and user databases.

Only a complete generation is published. No archive members are extracted.
Download/conversion runs on one background worker; callers only start/poll.

When a generation is already ready, each launch fetches the official CCP
manifest. A newer build only proposes an update; download is explicit. A
failed check surfaces as check_error for the UI to alert.
"""
from contextlib import closing
from decimal import Decimal
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import urllib.request
import uuid
import zipfile

MANIFEST_URL = 'https://developers.eveonline.com/static-data/tranquility/latest.jsonl'
SCHEMA_VERSION = 1
OUTPUTS = ('eve.db', 'types.json', 'eve_map.json')
MAX_DOWNLOAD = 512 * 1024 * 1024
MAX_UNPACKED = 3 * 1024 * 1024 * 1024


def cache_root():
    # Same persistent location as the public platform_state, never _MEIPASS.
    base = Path(os.environ.get('APPDATA') or Path.home()) / 'MMD-Trader' if sys.platform == 'win32' else Path.home() / '.mmd-trader'
    return base / 'sde'


@lru_cache(maxsize=4)
def _generation(root):
    try:
        info = json.loads((Path(root) / 'current.json').read_text(encoding='utf-8'))
        name = info['generation']
        if info['schema'] != SCHEMA_VERSION or not isinstance(name, str) or not name.startswith('build-') or Path(name).name != name:
            return None
        folder = Path(root) / name
        if all((folder / file).is_file() and (folder / file).stat().st_size > 0 for file in OUTPUTS):
            return folder
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def data_path(name, fallback=None):
    if name not in OUTPUTS:
        raise ValueError('Unknown converted SDE file')
    folder = _generation(str(cache_root()))
    return folder / name if folder else Path(fallback) if fallback else cache_root() / 'unavailable' / name


class DatabasePath(os.PathLike):
    """Resolve after onboarding as well as before it; supports sqlite/os APIs."""
    def __fspath__(self):
        return str(data_path("eve.db"))

    def __str__(self):
        return self.__fspath__()


def _rows(bundle, name, *, decimal=False):
    # Exact official filenames: never silently substitute a similarly named table.
    with bundle.open(name) as source:
        for line in source:
            if line.strip():
                yield json.loads(line, parse_float=Decimal if decimal else float)


def _name(row, key='name'):
    value = row.get(key, {})
    return value.get('en', '') if isinstance(value, dict) else str(value or '')


def convert_archive(archive, destination, progress=lambda **state: None):
    """Convert a local official JSONL zip; no network or publication here."""
    from tools.build_eve_map import build_dataset, _roman
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        required = ('types.jsonl', 'groups.jsonl', 'categories.jsonl', 'typeDogma.jsonl',
                    'mapRegions.jsonl', 'mapConstellations.jsonl', 'mapSolarSystems.jsonl',
                    'mapStargates.jsonl', 'npcStations.jsonl', 'npcCorporations.jsonl',
                    'stationOperations.jsonl', 'mapMoons.jsonl')
        if not set(required).issubset(bundle.namelist()):
            raise ValueError('Incomplete CCP JSONL SDE archive')
        if sum(i.file_size for i in bundle.infolist()) > MAX_UNPACKED:
            raise ValueError('SDE archive exceeds unpacked size limit')
        progress(phase='converting', message='Types, groups and skill/hull attributes', percent=55)
        groups = {r['_key']: r for r in _rows(bundle, 'groups.jsonl')}
        types = {}
        for row in _rows(bundle, 'types.jsonl'):
            group = groups[row['groupID']]
            types[str(row['_key'])] = {'name': {'en': _name(row)}, 'group_id': row['groupID'],
                'category_id': group['categoryID'], 'published': row.get('published', False),
                'dogma_attributes': {}}
        for row in _rows(bundle, 'typeDogma.jsonl', decimal=True):
            if str(row['_key']) in types:
                types[str(row['_key'])]['dogma_attributes'] = {
                    str(a['attributeID']): {'value': int(a['value']) if a['value'] == int(a['value']) else str(a['value'])}
                    for a in row.get('dogmaAttributes', [])}
        if not types:
            raise ValueError('Empty SDE types table')
        (destination / 'types.json').write_text(json.dumps(types, separators=(',', ':')), encoding='utf-8')
        progress(phase='converting', message='New Eden systems, stargates and NPC stations', percent=70)
        counts = build_dataset(archive, destination / 'eve_map.json')
        dataset = json.loads((destination / 'eve_map.json').read_text(encoding='utf-8'))
        systems = {s['id']: s for s in dataset['systems']}
        if not systems or not dataset['gates']:
            raise ValueError('Empty SDE map/topology')
        corps = {r['_key']: _name(r) for r in _rows(bundle, 'npcCorporations.jsonl')}
        operations = {r['_key']: _name(r, 'operationName') for r in _rows(bundle, 'stationOperations.jsonl')}
        stations = list(_rows(bundle, 'npcStations.jsonl'))
        orbits = {r['orbitID'] for r in stations if 'orbitID' in r}
        moons = {r['_key']: r for r in _rows(bundle, 'mapMoons.jsonl') if r['_key'] in orbits}
        station_rows = []
        for row in stations:
            system = systems[row['solarSystemID']]
            name = _name(row)
            if not name:
                name = system['name']
                if row.get('celestialIndex'):
                    name += ' ' + _roman(row['celestialIndex'])
                moon = moons.get(row.get('orbitID'))
                if moon:
                    name += ' - Moon ' + str(moon['orbitIndex'])
                owner = corps.get(row.get('ownerID'), '')
                if owner:
                    name += ' - ' + owner
                if row.get('useOperationName') and operations.get(row.get('operationID')):
                    name += ' ' + operations[row['operationID']]
            for station in system.get('npc_stations', []):
                if station['id'] == row['_key']:
                    station['name'] = name
            station_rows.append((row['_key'], row['solarSystemID'], system['region_id'], name, row['ownerID']))
        progress(phase='converting', message='Local ID lookup database', percent=90)
        with closing(sqlite3.connect(destination / 'eve.db')) as db, db:
            db.executescript('''
                CREATE TABLE invTypes(typeID INTEGER PRIMARY KEY,typeName TEXT,groupID INTEGER);
                CREATE TABLE invGroups(groupID INTEGER PRIMARY KEY,groupName TEXT,categoryID INTEGER);
                CREATE TABLE invCategories(categoryID INTEGER PRIMARY KEY,categoryName TEXT);
                CREATE TABLE mapRegions(regionID INTEGER PRIMARY KEY,regionName TEXT);
                CREATE TABLE mapConstellations(constellationID INTEGER PRIMARY KEY,constellationName TEXT,regionID INTEGER);
                CREATE TABLE mapSolarSystems(solarSystemID INTEGER PRIMARY KEY,regionID INTEGER,solarSystemName TEXT);
                CREATE TABLE mapSolarSystemJumps(fromSolarSystemID INTEGER,toSolarSystemID INTEGER);
                CREATE TABLE staStations(stationID INTEGER PRIMARY KEY,solarSystemID INTEGER,regionID INTEGER,stationName TEXT,corporationID INTEGER);
                CREATE INDEX jumps_source ON mapSolarSystemJumps(fromSolarSystemID);
                CREATE INDEX types_name ON invTypes(typeName);
            ''')
            db.executemany('INSERT INTO invTypes VALUES (?,?,?)', ((int(k),v['name']['en'],v['group_id']) for k,v in types.items()))
            db.executemany('INSERT INTO invGroups VALUES (?,?,?)', ((k,_name(v),v['categoryID']) for k,v in groups.items()))
            db.executemany('INSERT INTO invCategories VALUES (?,?)', ((r['_key'],_name(r)) for r in _rows(bundle,'categories.jsonl')))
            db.executemany('INSERT INTO mapRegions VALUES (?,?)', ((r['_key'],_name(r)) for r in _rows(bundle,'mapRegions.jsonl')))
            db.executemany('INSERT INTO mapConstellations VALUES (?,?,?)', ((r['_key'],_name(r),r['regionID']) for r in _rows(bundle,'mapConstellations.jsonl')))
            db.executemany('INSERT INTO mapSolarSystems VALUES (?,?,?)', ((s['id'],s['region_id'],s['name']) for s in systems.values()))
            db.executemany('INSERT INTO mapSolarSystemJumps VALUES (?,?)', ((a,b) for g in dataset['gates'] for a,b in ((g['source'],g['target']),(g['target'],g['source']))))
            db.executemany('INSERT INTO staStations VALUES (?,?,?,?,?)', station_rows)
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Invalid converted SDE database')
        (destination / 'eve_map.json').write_text(json.dumps(dataset,separators=(',',':')),encoding='utf-8')
        return {'types':len(types),'systems':counts['systems'],'gates':counts['gates'],'stations':len(station_rows)}


def _pointer_info(root):
    try:
        info = json.loads((Path(root) / 'current.json').read_text(encoding='utf-8'))
        build = info.get('build')
        if type(build) is not int or build <= 0:
            return None
        if _generation(str(root)) is None:
            return None
        return info
    except (OSError, ValueError, KeyError, TypeError):
        return None


class SdeInstaller:
    def __init__(self, root=None, opener=urllib.request.urlopen, converter=convert_archive):
        self.root = Path(root) if root is not None else cache_root()
        self.opener, self.converter = opener, converter
        self._lock = threading.RLock()
        self._thread = None
        local = _pointer_info(self.root)
        if local:
            self._state = {'phase': 'ready', 'percent': 100, 'build': local['build']}
        else:
            self._state = {'phase': 'missing', 'percent': 0}

    def status(self):
        with self._lock:
            return dict(self._state)

    def _update(self, **values):
        with self._lock:
            self._state.update(values)

    def start(self):
        with self._lock:
            phase = self._state['phase']
            if self._thread and self._thread.is_alive():
                return dict(self._state)
            if phase == 'ready':
                return dict(self._state)
            if phase not in ('missing', 'error', 'update_available'):
                return dict(self._state)
            self._state = {'phase':'downloading','percent':0,'message':'Looking up official CCP SDE'}
            self._thread = threading.Thread(target=self._run, name='mmd-sde-install', daemon=True)
            self._thread.start()
            return dict(self._state)

    def maybe_check_update(self):
        """Each launch: fetch CCP build; never auto-download."""
        with self._lock:
            if self._state['phase'] not in ('ready', 'check_error'):
                return dict(self._state)
            if self._thread and self._thread.is_alive():
                return dict(self._state)
            build = self._state.get('build')
            self._state = {'phase': 'checking', 'percent': 0, 'build': build,
                           'message': 'Checking for EVE data updates'}
            self._thread = threading.Thread(target=self._check_run, name='mmd-sde-check', daemon=True)
            self._thread.start()
            return dict(self._state)

    def defer_update(self):
        with self._lock:
            if self._state['phase'] in ('update_available', 'check_error'):
                build = self._state.get('local_build') or self._state.get('build')
                self._state = {'phase': 'ready', 'percent': 100,
                               'message': 'Local EVE data ready', 'build': build}
            return dict(self._state)

    def _open(self, url):
        return self.opener(urllib.request.Request(url,headers={'User-Agent':'MMD-Trader/0.1 SDE Bootstrap'}), timeout=30)

    def _remote_build(self):
        with self._open(MANIFEST_URL) as response:
            lines = response.read(65537)
            if len(lines) > 65536:
                raise ValueError('Invalid SDE manifest size')
            entries = [json.loads(line) for line in lines.splitlines() if line.strip()]
            build = next(r['buildNumber'] for r in entries if r.get('_key') == 'sde')
            if type(build) is not int or build <= 0:
                raise ValueError('Invalid SDE build number')
            return build

    def _check_run(self):
        local = _pointer_info(self.root)
        local_build = local['build'] if local else None
        try:
            remote = self._remote_build()
            if local_build is not None and remote != local_build:
                self._update(phase='update_available', percent=0, build=local_build,
                             local_build=local_build, remote_build=remote,
                             message=f'EVE static data build {remote} available (installed: {local_build})')
            else:
                self._update(phase='ready', percent=100, build=local_build,
                             message='Local EVE data ready')
        except Exception as error:
            self._update(phase='check_error', percent=0, build=local_build,
                         message=f'Could not check for EVE data updates: {error}')

    def _run(self):
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            build = self._remote_build()
            url = f'https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-{build}-jsonl.zip'
            # Own temporary directory only: failed/partial downloads never become active.
            with tempfile.TemporaryDirectory(prefix='install-',dir=self.root) as temp:
                archive = Path(temp) / 'sde.zip'
                digest, received = hashlib.sha256(), 0
                with self._open(url) as response, archive.open('wb') as output:
                    total = int(response.headers.get('Content-Length',0))
                    if total > MAX_DOWNLOAD:
                        raise ValueError('SDE download exceeds size limit')
                    metadata = {k:response.headers.get(k) for k in ('ETag','Last-Modified','Expires')}
                    while chunk := response.read(1024*1024):
                        received += len(chunk)
                        if received > MAX_DOWNLOAD:
                            raise ValueError('SDE download exceeds size limit')
                        output.write(chunk)
                        digest.update(chunk)
                        self._update(bytes_downloaded=received,bytes_total=total,
                                     percent=min(50,int(received/total*50)) if total else 0,
                                     message='Downloading official CCP SDE')
                    if total and total != received:
                        raise ValueError('Incomplete SDE download')
                generated = Path(temp) / 'converted'
                counts = self.converter(archive, generated, self._update)
                if not all((generated / name).is_file() and (generated / name).stat().st_size for name in OUTPUTS):
                    raise ValueError('Incomplete SDE conversion')
                name = f'build-{build}-{uuid.uuid4().hex}'
                os.replace(generated, self.root / name)
                info = {'schema':SCHEMA_VERSION,'generation':name,'build':build,'source':url,
                        'sha256':digest.hexdigest(),'headers':metadata,'counts':counts}
                pointer = Path(temp) / 'current.json'
                pointer.write_text(json.dumps(info),encoding='utf-8')
                os.replace(pointer,self.root / 'current.json')
            _generation.cache_clear()
            self._update(phase='ready',percent=100,message='Local EVE data ready',
                         counts=counts,build=build)
        except Exception as error:
            self._update(phase='error',message=f'SDE setup failed: {error}')


_installer = None
_installer_lock = threading.Lock()


def installer():
    global _installer
    with _installer_lock:
        if _installer is None:
            _installer = SdeInstaller()
        return _installer
