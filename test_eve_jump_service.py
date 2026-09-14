import ast
from dataclasses import replace
from decimal import Decimal as D
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from eve_account_groups import AccountGroups
from eve_character_jump_profile import CharacterJumpProfile
from mmd_esi_auth import EsiResult, failure
from eve_jump_service import JumpService, is_jump_destination_allowed
from eve_jump_math import METERS_PER_LY


class JumpServiceTests(unittest.TestCase):
    def test_partial_danger_visible_in_every_mode_without_inventing_unknown_scores(self):
        for mode in ('FEWEST_JUMPS','LEAST_FUEL','SAFER','SAFEST'):
            self.request.update(mode=mode,danger_snapshot={'state':'live','systems':{'2':{'score':18,'band':'normal'}}})
            summary=self.service.calculate(self.request)['danger_summary']
            self.assertEqual(summary['peak'],{'score':18,'band':'normal'})
            self.assertEqual(summary['total'],18)
            self.assertTrue(summary['partial'])
            self.assertEqual(summary['unknown_systems'],1)
            self.assertEqual(summary['known_systems'],1)

    def test_sde_station_and_map_snapshot_pass_through(self):
        self.rows[1]['npc_station_count']=2
        self.request.update(mode='SAFEST',danger_snapshot={'systems':{
            '2':{'score':18,'band':'normal'},'3':{'score':63,'band':'orange'}},'state':'live','observed_at':999})
        result=self.service.calculate(self.request)
        self.assertTrue(result['midpoints'][0]['npc_station'])
        self.assertEqual(result['route']['legs'][0]['danger'],{'score':18,'band':'normal'})
        self.assertEqual(result['danger_summary']['total'],81)
        self.assertEqual(result['danger_summary']['peak'],{'score':63,'band':'orange'})

    def test_safest_unknown_not_zero_risk(self):
        self.request['mode']='SAFEST'
        result=self.service.calculate(self.request)
        self.assertEqual(result['route']['systems'],[1,2,3])
        self.assertIsNone(result['danger_summary']['total'])
        self.assertIsNone(result['danger_summary']['peak'])

    def setUp(self):
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.accounts=AccountGroups(Path(self.temp.name)/'accounts.json')
        self.accounts.assign(42,1);self.accounts.assign(43,2)
        self.rows=[dict(id=i+1,name=f'S{i+1}',region_id=10000002,security=.1,
                        position_m=dict(x=D(i*3)*METERS_PER_LY,y=0,z=0)) for i in range(3)]
        self.types={'900':{'category_id':6,'published':True,'group_id':902,'name':{'en':'Test hull'},
             'dogma_attributes':{str(k):{'value':v} for k,v in [(866,10),(867,3),(868,100)]}},
             '10':{'name':{'en':'Test isotope'}}}
        self.positions=[dict(character_id=42,system_id=1,source='ESI',observed_at=995),
                        dict(character_id=43,system_id=2,source='LOCAL_CHATLOG',observed_at=999)]
        self.profiles=Mock(side_effect=lambda cid:EsiResult(CharacterJumpProfile(cid,
                            jump_drive_operation=4,jump_fuel_conservation=5,cynosural_field_theory=1,jump_freighters=5)))
        self.service=JumpService(systems=lambda:self.rows,types=lambda:self.types,
            characters=lambda:[dict(id=42,name='Capital'),dict(id=43,name='Cyno')],
            positions=lambda:{'positions':self.positions},profiles=self.profiles,accounts=self.accounts,now=lambda:1000)
        self.request=dict(pilot_id=42,ship_id=900,origin_id=1,destination_id=3,mode='FEWEST_JUMPS')

    def test_options_hulls_and_fresh_origin(self):
        options=self.service.options()
        self.assertEqual(options['ships'][0]['ship_class'],'JUMP_FREIGHTER')
        self.assertEqual(options['pilots'][0]['origin_system_id'],1)
        self.profiles.assert_not_called()

    def test_actual_router_exact_summary_legs_and_profile(self):
        result=self.service.calculate(self.request)
        self.assertEqual(result['route']['systems'],[1,2,3])
        self.assertEqual(D(result['route']['total_fuel_raw']),150)
        self.assertEqual(D(result['route']['total_distance_ly']),6)
        self.assertEqual(result['route']['legs'][0]['source_name'],'S1')
        self.assertEqual(D(result['route']['legs'][0]['fuel_raw']),75)
        self.assertEqual(result['isotope_type_id'],10)
        self.assertEqual(result['profile']['character_id'],42)
        self.assertEqual(result['profile']['jump_drive_operation'],4)
        self.assertEqual(D(result['max_jump_range']),3)

    def test_other_account_positioned_and_timestamp(self):
        result=self.service.calculate(self.request)
        self.assertEqual(result['cynos'][0]['character_id'],43)
        self.assertEqual(result['cynos'][0]['observed_at'],999)
        self.assertEqual(result['cynos'][0]['status'],'CYNO_POSITIONED')
        self.assertEqual(result['midpoints'][0]['cyno_candidates'][0]['character_id'],43)
        self.assertEqual(result['cyno_coverage'],{'positioned':1,'required':2})

    def test_same_account_rejected_without_fetching_its_skills(self):
        self.accounts.assign(43,1)
        result=self.service.calculate(self.request)
        self.assertEqual(result['cynos'],[])
        self.assertEqual(result['cyno_candidates'][0]['status'],'UNAVAILABLE')
        self.profiles.assert_called_once_with(42)

    def test_stale_cyno_is_not_current(self):
        self.positions[1]['observed_at']=900
        result=self.service.calculate(self.request)
        self.assertEqual(result['cynos'],[])
        self.assertEqual(result['cyno_candidates'][0]['status'],'STALE')
        self.assertFalse(result['cyno_candidates'][0]['position_fresh'])
        self.assertEqual(result['midpoints'][0]['cyno_candidates'],[])

    def test_unknown_position_but_skilled(self):
        self.positions.pop()
        result=self.service.calculate(self.request)
        self.assertEqual(result['cyno_candidates'][0]['status'],'CYNO_SKILLED')
        self.assertEqual(result['cynos'],[])

    def test_auto_origin_rechecks_snapshot(self):
        self.positions[0]['system_id']=2
        result=self.service.calculate(dict(self.request,origin_auto=True))
        self.assertEqual(result['route']['systems'],[2,3])
        self.positions[0]['observed_at']=900
        with self.assertRaisesRegex(ValueError,'stale'):
            self.service.calculate(dict(self.request,origin_auto=True))
        self.assertTrue(self.service.calculate(self.request)['route']['reachable'])

    def test_policy_excludes_special_and_highsec(self):
        for region in [11000001,10000070,10000004,10000017,10000019,10000071,12000001]:
            self.assertFalse(is_jump_destination_allowed(dict(region_id=region,security=-1),'CAPITAL'))
        for value in [.45,1,float('nan')]:
            self.assertFalse(is_jump_destination_allowed(dict(region_id=10000002,security=value),'CAPITAL'))
        self.assertFalse(is_jump_destination_allowed({},'CAPITAL'))

    def test_impossible_no_fake_midpoint(self):
        self.rows[2]['security']=1
        result=self.service.calculate(self.request)
        self.assertFalse(result['route']['reachable'])
        self.assertEqual(result['midpoints'],[])
        self.assertEqual(result['route']['legs'],[])
        self.assertIsNone(result['route']['total_fuel_raw'])

    def test_profile_failure_no_fake_result(self):
        self.profiles.side_effect=None;self.profiles.return_value=failure('skills','forbidden','scope')
        with self.assertRaisesRegex(ValueError,'forbidden'):
            self.service.calculate(self.request)

    def test_bridge_contract(self):
        tree=ast.parse((Path(__file__).parent/'mmd_gui.py').read_text(encoding='utf-8-sig'))
        api=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='Api')
        methods={n.name:n for n in api.body if isinstance(n,ast.FunctionDef)}
        for method,arity in [('get_jump_planner_options',1),('get_jump_pilot_profile',2),('start_jump_calculation',2),('get_jump_calculation',2)]:
            self.assertEqual(len(methods[method].args.args),arity)

    def test_background_job_calls_real_service_and_returns_safe_result(self):
        import eve_jump_service as jobs
        with patch.object(jobs,'default_service',return_value=self.service):
            started=jobs.start_calculation(self.request)
            self.assertTrue(started['ok'])
            jobs._jobs[started['job_id']].result(timeout=5)
            result=jobs.calculation_result(started['job_id'])
        self.assertTrue(result['route']['reachable'])
        self.assertEqual(D(result['route']['total_fuel_raw']),150)

    def test_expiry_during_skill_fetch_rejected(self):
        tick=[1000]
        self.service.now=lambda:tick[0]
        original=self.profiles.side_effect
        def delayed(cid):
            result=original(cid)
            if cid==43:tick[0]=1040
            return result
        self.profiles.side_effect=delayed
        result=self.service.calculate(self.request)
        self.assertEqual(result['cynos'],[])
        self.assertEqual(result['cyno_candidates'][0]['status'],'STALE')


if __name__=='__main__':unittest.main()
