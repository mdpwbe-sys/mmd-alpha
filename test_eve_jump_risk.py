import unittest
from eve_jump_risk import proximity_risk

class RiskTests(unittest.TestCase):
    def test_live_double_esi_and_distance_halves(self):
        graph={1:{2},2:{1,3},3:{2,4},4:{3,5},5:{4}}
        old=proximity_risk(1,graph,{2:{'esi_score':20}})
        live=proximity_risk(1,graph,{2:{'recent_score':20}})
        distant=proximity_risk(1,graph,{3:{'recent_score':20}})
        self.assertEqual(old['risk'],20)
        self.assertEqual(live['risk'],40)
        self.assertEqual(distant['risk'],20)
        self.assertEqual(proximity_risk(1,graph,{5:{'recent_score':20}})['risk'],0)

    def test_no_duplicate_path_or_signal(self):
        graph={1:{2,3},2:{1,3},3:{1,2}}
        result=proximity_risk(1,graph,{2:{'esi_score':20,'recent_score':20}})
        self.assertEqual(result['risk'],40)
        self.assertEqual(len(result['contributors']),1)
