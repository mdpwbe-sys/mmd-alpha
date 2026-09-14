import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

import eve_sde as sde


def archive_bytes():
    tables = {
        'types': [{'_key':1,'name':{'en':'Hull'},'groupID':9,'published':True},
                  {'_key':2,'name':{'en':'Isotope'},'groupID':9,'published':True}],
        'groups':[{'_key':9,'categoryID':6,'name':{'en':'Ships'}}],
        'categories':[{'_key':6,'name':{'en':'Ship'}}],
        'typeDogma':[{'_key':1,'dogmaAttributes':[{'attributeID':866,'value':2},
                     {'attributeID':867,'value':5.25},{'attributeID':868,'value':1000},
                     {'attributeID':182,'value':3456},{'attributeID':277,'value':5}]}],
        'mapRegions':[{'_key':10,'name':{'en':'Region'}}],
        'mapConstellations':[{'_key':20,'name':{'en':'Constellation'},'regionID':10}],
        'mapSolarSystems':[{'_key':i,'name':{'en':n},'constellationID':20,'regionID':10,
                           'position':{'x':i,'y':0,'z':0}} for i,n in [(30,'Jita'),(31,'Perimeter')]],
        'mapStargates':[{'_key':50,'solarSystemID':30,'destination':{'stargateID':51}},
                       {'_key':51,'solarSystemID':31,'destination':{'stargateID':50}}],
        'npcStations':[{'_key':60,'solarSystemID':30,'ownerID':70,'operationID':80,
                        'celestialIndex':4,'orbitID':90,'useOperationName':True}],
        'npcCorporations':[{'_key':70,'name':{'en':'Caldari Navy'}}],
        'stationOperations':[{'_key':80,'operationName':{'en':'Assembly Plant'}}],
        'mapMoons':[{'_key':90,'orbitIndex':4}],
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output,'w') as z:
        for name,rows in tables.items():
            z.writestr(name+'.jsonl','\n'.join(json.dumps(row) for row in rows))
        z.writestr('../../do-not-extract','not a table')
    return output.getvalue()


class Response(io.BytesIO):
    def __init__(self,data):
        super().__init__(data)
        self.headers = {'Content-Length':str(len(data)),'ETag':'test-version'}


class SdeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        sde._generation.cache_clear()
        self.addCleanup(sde._generation.cache_clear)
        self.data = archive_bytes()
        self.requests = []

    def opener(self,request,timeout):
        self.requests.append(request.full_url)
        self.assertEqual(timeout,30)
        if request.full_url == sde.MANIFEST_URL:
            return Response(b'{"_key":"unrelated","buildNumber":1}\n{"_key":"sde","buildNumber":42}')
        self.assertIn('-42-jsonl.zip',request.full_url)
        return Response(self.data)

    def install(self):
        worker = sde.SdeInstaller(self.root,self.opener)
        worker.start()
        worker._thread.join(5)
        self.assertEqual(worker.status()['phase'],'ready',worker.status())
        return worker

    def test_conversion_ids_names_dogma_and_bidirectional_gates(self):
        self.install()
        folder = sde._generation(str(self.root))
        with sqlite3.connect(folder/'eve.db') as db:
            self.assertEqual(db.execute('select count(*) from invTypes').fetchone()[0],2)
            self.assertEqual(db.execute('select stationName from staStations').fetchone()[0],
                             'Jita IV - Moon 4 - Caldari Navy Assembly Plant')
            self.assertEqual(set(db.execute('select * from mapSolarSystemJumps')), {(30,31),(31,30)})
        db.close()
        types = json.loads((folder/'types.json').read_text())
        from eve_jump_math import hull_stats_from_sde
        self.assertEqual(str(hull_stats_from_sde(types['1']).base_range_ly),'5.25')
        self.assertEqual(types['1']['dogma_attributes']['182']['value'],3456)
        from eve_hull_skills import requirements
        self.assertEqual(requirements(types['1']),{3456:5})
        self.assertFalse((self.root/'do-not-extract').exists())

    def test_restart_is_offline_and_idempotent(self):
        worker = self.install()
        count = len(self.requests)
        worker.start()
        restarted = sde.SdeInstaller(self.root,self.opener)
        self.assertEqual(restarted.start()['phase'],'ready')
        self.assertEqual(len(self.requests),count)

    def test_dynamic_path_available_after_install(self):
        with patch.object(sde,'cache_root',return_value=self.root):
            path = sde.DatabasePath()
            before = str(path)
            self.install()
            self.assertNotEqual(str(path),before)
            self.assertTrue(Path(path).is_file())

    def test_network_failure_retry(self):
        worker = sde.SdeInstaller(self.root,opener=lambda *a,**k: (_ for _ in ()).throw(OSError('offline')))
        worker.start(); worker._thread.join(5)
        self.assertEqual(worker.status()['phase'],'error')
        self.assertFalse((self.root/'current.json').exists())
        worker.opener = self.opener
        worker.start(); worker._thread.join(5)
        self.assertEqual(worker.status()['phase'],'ready')

    def test_corrupt_archive_does_not_publish(self):
        self.data = b'not zip'
        worker = sde.SdeInstaller(self.root,self.opener)
        worker.start(); worker._thread.join(5)
        self.assertEqual(worker.status()['phase'],'error')
        self.assertFalse((self.root/'current.json').exists())
        self.assertFalse(list(self.root.glob('install-*')))

    def test_missing_table_rejected(self):
        archive = self.root/'bad.zip'
        with zipfile.ZipFile(archive,'w') as z:
            z.writestr('types.jsonl','{}')
        with self.assertRaisesRegex(ValueError,'Incomplete'):
            sde.convert_archive(archive,self.root/'output')

    def test_start_nonblocking_single_worker(self):
        entered, release = threading.Event(), threading.Event()
        def blocked(request,timeout):
            entered.set()
            release.wait(5)
            return self.opener(request,timeout)
        worker = sde.SdeInstaller(self.root,blocked)
        try:
            self.assertEqual(worker.start()['phase'],'downloading')
            self.assertTrue(entered.wait(1))
            thread = worker._thread
            worker.start()
            self.assertIs(thread,worker._thread)
        finally:
            release.set(); worker._thread.join(5)

    def test_invalid_pointer_not_trusted(self):
        (self.root/'current.json').write_text('{"schema":1,"generation":"../outside"}')
        self.assertIsNone(sde._generation(str(self.root)))


if __name__ == '__main__':
    unittest.main()
