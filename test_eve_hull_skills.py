import unittest
from eve_hull_skills import requirements,eligible
import test_eve_jump_service as service_tests
from unittest.mock import patch
from mmd_esi_auth import EsiResult

class HullSkillsTests(unittest.TestCase):
    def test_direct_requirements_and_missing_skill(self):
        req=requirements({'dogma_attributes':{'182':{'value':123},'277':{'value':5}}})
        self.assertTrue(eligible(req,{123:5}))
        self.assertFalse(eligible(req,{123:4}))
        self.assertFalse(eligible(req,{}))
        self.assertFalse(eligible(requirements({}),{123:5}))

    def test_active_level_filters_real_service_catalog(self):
        fixture=service_tests.JumpServiceTests();fixture.setUp()
        try:
            fixture.types['900']['dogma_attributes'].update({'182':{'value':123},'277':{'value':5}})
            with patch('mmd_esi_auth.get_json',return_value=EsiResult({'skills':[{'skill_id':123,'active_skill_level':4,'trained_skill_level':5}]})) as fetch:
                self.assertEqual(fixture.service.pilot_ships(42),[])
                fetch.return_value=EsiResult({'skills':[{'skill_id':123,'active_skill_level':5}]})
                self.assertEqual(fixture.service.pilot_ships(42)[0]['id'],900)
        finally: fixture.doCleanups()
