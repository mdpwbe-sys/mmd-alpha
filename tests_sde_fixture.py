"""Small synthetic station database: tests never require an Evernus install."""
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch
import mmd_stations as stations

def install(test):
    directory=tempfile.TemporaryDirectory()
    test.addCleanup(directory.cleanup)
    path=Path(directory.name)/'eve.db'
    with sqlite3.connect(path) as db:
        db.executescript('''
        CREATE TABLE mapSolarSystems(solarSystemID INTEGER, regionID INTEGER, solarSystemName TEXT);
        CREATE TABLE staStations(stationID INTEGER, solarSystemID INTEGER, regionID INTEGER, stationName TEXT, corporationID INTEGER);
        CREATE TABLE mapSolarSystemJumps(fromSolarSystemID INTEGER,toSolarSystemID INTEGER);
        ''')
        db.executemany('INSERT INTO mapSolarSystems VALUES (?,?,?)',[(30000142,10000002,'Jita'),(30000144,10000002,'Perimeter'),(30002187,10000043,'Amarr'),(30002510,10000030,'Rens')])
        db.executemany('INSERT INTO staStations VALUES (?,?,?,?,?)',[
            (60003760,30000142,10000002,'Jita IV - Moon 4 - Caldari Navy Assembly Plant',1000035),
            (60008494,30002187,10000043,'Amarr VIII (Oris) - Emperor Family Academy',1000060),
            (60004588,30002510,10000030,'Rens VI - Moon 8 - Brutor Tribe Treasury',1000049)])
        db.execute('INSERT INTO mapSolarSystemJumps VALUES (?,?)',(30000142,30000144))
    db.close()
    for name,value in [('EVE_DB',str(path)),('ENV',str(Path(directory.name)/'missing.env')),('_sys_cache',{}),('_region_cache',{}),('_runtime_structures',{}),('_ENV_STATIONS',None),('_jumps',None)]:
        test.enterContext(patch.object(stations,name,value))
