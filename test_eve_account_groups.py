import ast
from pathlib import Path
import tempfile
import unittest

from eve_account_groups import AccountGroups


class AccountGroupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'accounts.json'
        self.groups = AccountGroups(self.path)

    def test_same_account_mutually_exclusive(self):
        for cid in [1,2,3]:
            self.groups.assign(cid,1)
        for pair in [[1,2],[1,3],[2,3],[1,2,3]]:
            self.assertFalse(self.groups.characters_simultaneously_available(pair))

    def test_different_account_candidate_not_online_guarantee(self):
        self.groups.assign(1,1)
        self.groups.assign(2,2)
        self.assertTrue(self.groups.characters_simultaneously_available([1,2]))
        self.groups.assign(2,1)
        self.assertFalse(self.groups.characters_simultaneously_available([1,2]))

    def test_unknown_accounts_are_not_inferred(self):
        rows = [{'id':1,'name':'A','CharacterOwnerHash':'same'},
                {'id':2,'name':'B','CharacterOwnerHash':'same'}]
        self.assertTrue(all(c['account_group_id'] is None for c in self.groups.characters(rows)))
        self.assertNotIn('account_group_id',rows[0])
        self.assertFalse(self.groups.characters_simultaneously_available([1,2]))
        self.groups.assign(1,1)
        self.assertFalse(self.groups.characters_simultaneously_available([1,2]))

    def test_persistence_and_unassign(self):
        self.groups.assign(1,2)
        reloaded=AccountGroups(self.path)
        self.assertEqual(reloaded.characters([{'id':1}])[0]['account_group_id'],'2')
        reloaded.assign(1,None)
        self.assertIsNone(self.groups.characters([{'id':1}])[0]['account_group_id'])

    def test_singleton_empty_and_duplicate(self):
        self.assertTrue(self.groups.characters_simultaneously_available([]))
        self.assertTrue(self.groups.characters_simultaneously_available([1]))
        self.assertFalse(self.groups.characters_simultaneously_available([1,1]))

    def test_invalid_group_does_not_overwrite(self):
        self.groups.assign(1,1)
        original=self.path.read_text()
        for value in ['',0,-1,True,'owner-hash']:
            with self.assertRaises(ValueError):
                self.groups.assign(1,value)
        self.assertEqual(self.path.read_text(),original)

    def test_corrupt_file_not_silently_replaced(self):
        self.path.write_text('broken')
        with self.assertRaises(ValueError):
            self.groups.assign(1,1)
        with self.assertRaises(ValueError):
            self.groups.characters_simultaneously_available([1,2])
        self.assertEqual(self.path.read_text(),'broken')

    def test_js_python_bridge_argument_contract(self):
        root=Path(__file__).parent
        api=next(n for n in ast.parse((root/'mmd_gui.py').read_text(encoding='utf-8-sig')).body
                 if isinstance(n,ast.ClassDef) and n.name=='Api')
        methods={n.name:n for n in api.body if isinstance(n,ast.FunctionDef)}
        self.assertEqual(len(methods['get_account_groups'].args.args),1)
        self.assertEqual(len(methods['set_character_account_group'].args.args),3)
        html=(root/'gui/index.html').read_text(encoding='utf-8')
        self.assertIn('api.get_account_groups()',html)
        self.assertIn('api.set_character_account_group(character.id,select.value || null)',html)


if __name__ == '__main__':
    unittest.main()
