import unittest
from decimal import Decimal as D

from eve_jump_math import (METERS_PER_LY, distance_ly, hull_stats_from_sde,
                           max_jump_range, is_reachable, fuel_for_leg)


class JumpMathTests(unittest.TestCase):
    def setUp(self):
        # Synthetic SDE fixture: values intentionally not a real hull promise.
        self.row = {'dogma_attributes': {str(k): {'attribute_id': k, 'value': v}
                    for k, v in [(866, 17888), (867, 5), (868, 100)]}}
        self.hull = hull_stats_from_sde(self.row)

    def test_sde_attributes_and_missing_attribute(self):
        self.assertEqual(self.hull.fuel_type_id, 17888)
        self.assertEqual(self.hull.base_range_ly, 5)
        self.assertEqual(self.hull.base_fuel_per_ly, 100)
        del self.row['dogma_attributes']['868']
        with self.assertRaises(KeyError):
            hull_stats_from_sde(self.row)

    def test_distance_uses_only_ccp_meters(self):
        a = {'position_m': dict(x=0,y=0,z=0), 'x': 999, 'tx': 123}
        b = {'position_m': dict(x=3*METERS_PER_LY,y=4*METERS_PER_LY,z=0), 'x': 0}
        self.assertEqual(distance_ly(a,b), 5)
        self.assertEqual(distance_ly(b,a), 5)
        self.assertEqual(distance_ly(a,a), 0)
        with self.assertRaises(KeyError):
            distance_ly({'x': 0, 'y': 0, 'z': 0}, b)

    def test_jdc_zero_and_five_and_range_boundary(self):
        for jdc, expected in [(0, 5), (5, 10)]:
            value = max_jump_range(self.hull,jdc)
            self.assertEqual(value, expected)
            self.assertTrue(is_reachable(value,value))
            self.assertFalse(is_reachable(value+D('.000000000001'),value))

    def test_jfc_and_jf_zero_and_five(self):
        for jfc, jf, expected in [(0,0,200),(5,0,100),(0,5,100),(5,5,50)]:
            with self.subTest(jfc=jfc,jf=jf):
                self.assertEqual(fuel_for_leg(2,self.hull,jfc,is_jump_freighter=True,
                                              jump_freighters=jf),expected)
        self.assertEqual(fuel_for_leg(2,self.hull,0,jump_freighters=5),200)
        self.assertEqual(fuel_for_leg(2,self.hull,5,jump_freighters=5),100)

    def test_fractional_fuel_is_not_rounded(self):
        raw = fuel_for_leg(D('.12345'),self.hull,5,is_jump_freighter=True,jump_freighters=5)
        self.assertEqual(raw,D('3.08625'))
        self.assertIsInstance(raw,D)
        self.assertEqual(fuel_for_leg(0,self.hull,5),0)

    def test_invalid_inputs_fail_explicitly(self):
        for level in [-1,6,True,2.5]:
            with self.assertRaises(ValueError):
                max_jump_range(self.hull,level)
            with self.assertRaises(ValueError):
                fuel_for_leg(1,self.hull,level)
        for value in [-1,'NaN','Infinity']:
            with self.assertRaises(ValueError):
                fuel_for_leg(value,self.hull,0)
            with self.assertRaises(ValueError):
                is_reachable(value,5)


if __name__ == '__main__':
    unittest.main()
