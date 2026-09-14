from decimal import Decimal as D
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import eve_jump_math as math
from eve_jump_router import JumpNeighborIndex, find_direct_jump, find_jump_route, FEWEST_JUMPS, LEAST_FUEL


def systems(*points):
    return {i+1: {'position_m': {a:D(str(v))*math.METERS_PER_LY for a,v in zip('xyz',(*p,0) if len(p)==2 else p)}}
            for i,p in enumerate(points)}


class JumpRouterTests(unittest.TestCase):
    def test_safer_caps_detour_while_safest_can_take_long_safe_arc(self):
        rows=systems((0,0),(3,0),(6,0),(0,2),(2,4),(4,4),(6,2))
        args=self.args(rows,radius='3.1',danger_cost=lambda sid:100 if sid==2 else 0)
        shortest=find_jump_route(1,3,mode='FEWEST_JUMPS',**args)
        safest=find_jump_route(1,3,mode='SAFEST',**args)
        safer=find_jump_route(1,3,mode='SAFER',**args)
        self.assertEqual(shortest['jump_count'],2)
        self.assertGreater(safest['jump_count'],3)
        self.assertLessEqual(safer['jump_count'],3)
        self.assertTrue(safer['reachable'])
        self.assertEqual(safer,find_jump_route(1,3,mode='SAFER',**args))

    def test_safer_uses_affordable_lower_risk_detour(self):
        rows=systems((0,0),(3,1),(2,0),(4,0),(6,0))
        route=find_jump_route(1,5,mode='SAFER',danger_cost=lambda sid:90 if sid==2 else 0,**self.args(rows))
        self.assertEqual(route['systems'],[1,3,4,5])

    def test_safest_avoids_danger_and_preserves_range(self):
        rows=systems((0,0),(3,1),(2,0),(4,0),(6,0),(50,0))
        route=find_jump_route(1,5,mode='SAFEST',danger_cost=lambda sid:90 if sid==2 else 0,**self.args(rows))
        self.assertEqual(route['systems'],[1,3,4,5])
        self.assertFalse(find_jump_route(1,6,mode='SAFEST',danger_cost=lambda sid:0,**self.args(rows))['reachable'])

    def test_safest_tie_prefers_fewer_jumps(self):
        rows=systems((0,0),(3,1),(2,0),(4,0),(6,0))
        for cost in (0,100):
            for _ in range(2):
                self.assertEqual(find_jump_route(1,5,mode='SAFEST',danger_cost=lambda sid:cost,**self.args(rows))['systems'],[1,2,5])

    def test_safest_requires_valid_external_cost(self):
        for provider in (None,lambda sid:-1,lambda sid:float('nan')):
            with self.assertRaises(ValueError):
                find_jump_route(1,2,mode='SAFEST',danger_cost=provider,**self.args(systems((0,0),(1,0))))

    def test_safest_equal_risk_cyno_then_station(self):
        rows=systems((0,0),(3,1),(3,-1),(6,0))
        rows[2]['npc_station']=True
        args=self.args(rows,mode='SAFEST',danger_cost=lambda sid:0,pilot_account_group_id=1)
        candidate=dict(character_id=43,account_group_id=2,system_id=3,cyno_skilled=True,position_fresh=True)
        self.assertEqual(find_jump_route(1,4,cyno_candidates=[candidate],**args)['systems'],[1,3,4])
        candidate['account_group_id']=1
        self.assertEqual(find_jump_route(1,4,cyno_candidates=[candidate],**args)['systems'],[1,2,4])

    def args(self, rows, radius='3.5', **extra):
        return dict(systems=rows, jump_profile=SimpleNamespace(character_id=42,
                    jump_drive_calibration=0,jump_fuel_conservation=0,jump_freighters=0),
                    hull_stats=math.JumpHullStats(1,D(radius),D(100)),ship_class='CAPITAL',
                    destination_policy=lambda system,ship: not system.get('forbidden'), **extra)

    def test_direct(self):
        route=find_direct_jump(1,2,**self.args(systems((0,0),(2,0))))
        self.assertTrue(route['reachable'])
        self.assertEqual(route['systems'],[1,2])
        self.assertEqual(route['legs'][0],dict(source_id=1,target_id=2,distance_ly=D(2),fuel_raw=D(200),kind='JUMP'))

    def test_exactly_range(self):
        self.assertTrue(find_direct_jump(1,2,**self.args(systems((0,0),(3.5,0))))['reachable'])

    def test_just_outside_range(self):
        self.assertFalse(find_direct_jump(1,2,**self.args(systems((0,0),('3.500000001',0))))['reachable'])

    def test_one_midpoint(self):
        rows=systems((0,0),(3,0),(6,0))
        self.assertFalse(find_direct_jump(1,3,**self.args(rows))['reachable'])
        self.assertEqual(find_jump_route(1,3,**self.args(rows))['systems'],[1,2,3])

    def test_multiple_midpoints(self):
        self.assertEqual(find_jump_route(1,4,**self.args(systems((0,0),(3,0),(6,0),(9,0))))['systems'],[1,2,3,4])

    def test_no_route(self):
        route=find_jump_route(1,2,**self.args(systems((0,0),(10,0))))
        self.assertFalse(route['reachable'])
        self.assertEqual(route['legs'],[])
        self.assertIsNone(route['total_fuel_raw'])

    def test_modes(self):
        rows=systems((0,0),(3,1),(2,0),(4,0),(6,0))
        few=find_jump_route(1,5,mode=FEWEST_JUMPS,**self.args(rows))
        fuel=find_jump_route(1,5,mode=LEAST_FUEL,**self.args(rows))
        self.assertEqual(few['systems'],[1,2,5])
        self.assertEqual(fuel['systems'],[1,3,4,5])
        self.assertLess(fuel['total_fuel_raw'],few['total_fuel_raw'])

    def test_waypoints_and_atomic_failure(self):
        rows=systems((0,0),(3,0),(6,0),(30,0))
        self.assertEqual(find_jump_route(1,3,waypoints=[2,1],**self.args(rows))['systems'],[1,2,1,2,3])
        failed=find_jump_route(1,4,waypoints=[2],**self.args(rows))
        self.assertFalse(failed['reachable']);self.assertEqual(failed['legs'],[])

    def test_sum_fuel_exact_and_math_only(self):
        args=self.args(systems((0,0),(3,0),(6,0)))
        args['jump_profile'].jump_fuel_conservation=5
        args['jump_profile'].jump_freighters=5
        args['ship_class']='JUMP_FREIGHTER'
        route=find_jump_route(1,3,**args)
        self.assertEqual(route['total_fuel_raw'],sum(leg['fuel_raw'] for leg in route['legs']))
        self.assertEqual(route['total_fuel_raw'],D(150))
        self.assertEqual(route['total_distance_ly'],sum(leg['distance_ly'] for leg in route['legs']))

    def test_policy_for_goal_midpoints_not_initial_origin(self):
        rows=systems((0,0),(3,0),(6,0));rows[1]['forbidden']=True
        self.assertTrue(find_jump_route(1,3,**self.args(rows))['reachable'])
        rows[2]['forbidden']=True
        self.assertFalse(find_jump_route(1,3,**self.args(rows))['reachable'])
        rows[3]['forbidden']=True
        self.assertFalse(find_direct_jump(2,3,**self.args(rows))['reachable'])

    def cyno(self,account=2,system=3):
        return dict(character_id=43,account_group_id=account,system_id=system,cyno_skilled=True,position_fresh=True)

    def test_same_account_and_unknown_ignored(self):
        rows=systems((0,0),(3,1),(3,-1),(6,0))
        for account in [1,'1',None]:
            result=find_jump_route(1,4,**self.args(rows,pilot_account_group_id=1,cyno_candidates=[self.cyno(account)]))
            self.assertEqual(result['systems'],[1,2,4])

    def test_other_account_positioned_tie_break(self):
        rows=systems((0,0),(3,1),(3,-1),(6,0))
        for mode in [FEWEST_JUMPS,LEAST_FUEL]:
            result=find_jump_route(1,4,mode=mode,**self.args(rows,pilot_account_group_id=1,cyno_candidates=[self.cyno()]))
            self.assertEqual(result['systems'],[1,3,4])

    def test_cyno_never_overrides_primary_cost_or_range(self):
        rows=systems((0,0),(3,1),(2,0),(4,0),(6,0),(50,0))
        candidate=self.cyno(system=2)
        result=find_jump_route(1,5,mode=LEAST_FUEL,**self.args(rows,pilot_account_group_id=1,cyno_candidates=[candidate]))
        self.assertEqual(result['systems'],[1,3,4,5])
        self.assertFalse(find_jump_route(1,6,**self.args(rows,pilot_account_group_id=1,cyno_candidates=[self.cyno(system=6)]))['reachable'])

    def test_stale_or_unskilled_cyno_ignored(self):
        rows=systems((0,0),(3,1),(3,-1),(6,0))
        for key in ['cyno_skilled','position_fresh']:
            candidate=self.cyno();candidate[key]=False
            self.assertEqual(find_jump_route(1,4,**self.args(rows,pilot_account_group_id=1,cyno_candidates=[candidate]))['systems'],[1,2,4])

    def test_station_tie(self):
        rows=systems((0,0),(3,1),(3,-1),(6,0));rows[3]['npc_station']=True
        self.assertEqual(find_jump_route(1,4,**self.args(rows))['systems'],[1,3,4])

    def test_cache_reused_across_routes_and_range_separated(self):
        index=JumpNeighborIndex(systems((0,0),(3,0),(6,0)))
        args=self.args(index)
        with patch.object(math,'distance_ly',wraps=math.distance_ly) as distance:
            first=find_jump_route(1,3,**args);count=distance.call_count
            self.assertGreater(count,0)
            self.assertEqual(find_jump_route(1,3,**args),first)
            self.assertEqual(distance.call_count,count)
        self.assertEqual(index.neighbors(1,D(2)),())
        self.assertEqual(index.neighbors(1,D(4))[0][0],2)

    def test_policy_not_cached_between_routes(self):
        index=JumpNeighborIndex(systems((0,0),(3,0)))
        args=self.args(index)
        self.assertTrue(find_jump_route(1,2,**args)['reachable'])
        args['destination_policy']=lambda row,ship:False
        self.assertFalse(find_jump_route(1,2,**args)['reachable'])

    def test_snapshot_not_tactical_and_cache_bounded(self):
        rows=systems((0,0),(3,0),(6,0));index=JumpNeighborIndex(rows,max_cached_neighborhoods=1)
        rows[2]['position_m']['x']=D(999)*math.METERS_PER_LY
        rows[2]['x']=0
        self.assertEqual(index.neighbors(1,D(4))[0][0],2)
        index.neighbors(2,D(4));self.assertEqual(len(index._cache),1)

    def test_spatial_index_matches_exhaustive_distance_in_three_dimensions(self):
        rows=systems(*[(x,y,z) for x in [-4,0,4] for y in [-4,0,4] for z in [-4,0,4]])
        index=JumpNeighborIndex(rows)
        for cid in rows:
            for radius in [D(0),D(4),D('5.7')]:
                expected=tuple((other,math.distance_ly(rows[cid],row)) for other,row in rows.items()
                               if other!=cid and math.is_reachable(math.distance_ly(rows[cid],row),radius))
                self.assertEqual(index.neighbors(cid,radius),expected)

    def test_sparse_index_avoids_all_pairs_distance_work(self):
        rows=systems(*[(x*10,y*10,z*10) for x in range(20) for y in range(20) for z in range(20)])
        index=JumpNeighborIndex(rows)
        with patch.object(math,'distance_ly',wraps=math.distance_ly) as distance:
            self.assertEqual(index.neighbors(1,D(1)),())
            distance.assert_not_called()

    def test_zero_fuel_cycles_terminate_and_unknown_ids_rejected(self):
        args=self.args(systems((0,0),(0,0),(3,0)))
        args['hull_stats']=math.JumpHullStats(1,D(4),D(0))
        self.assertEqual(find_jump_route(1,3,**args)['systems'],[1,3])
        self.assertEqual(find_jump_route(1,1,**args)['jump_count'],0)
        with self.assertRaises(ValueError):find_jump_route(1,99,**args)


if __name__=='__main__':
    unittest.main()
