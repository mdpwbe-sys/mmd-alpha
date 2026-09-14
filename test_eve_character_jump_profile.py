import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

import mmd_esi_auth as auth
from eve_character_jump_profile import (
    CharacterJumpProfile, SKILL_FIELDS, get_character_jump_profile,
)


class CharacterJumpProfileTests(unittest.TestCase):
    def setUp(self):
        auth.clear_memory_cache()

    def tearDown(self):
        auth.clear_memory_cache()

    def test_allowlist_and_existing_scope(self):
        self.assertIn('esi-skills.read_skills.v1', auth.sso.SCOPES)
        self.assertTrue(auth._allowed('GET', '/v4/characters/42/skills/'))
        for method, path in [('POST', '/v4/characters/42/skills/'),
                             ('GET', '/v4/corporations/42/skills/'),
                             ('GET', '/v4/characters/42/skills/extra')]:
            self.assertFalse(auth._allowed(method, path))

    def test_missing_skills_are_zero(self):
        with patch.object(auth, 'get_json', return_value=auth.EsiResult({'skills': []})) as get:
            result = get_character_jump_profile(42)
        get.assert_called_once_with('/v4/characters/42/skills/', 42)
        self.assertEqual(result.data, CharacterJumpProfile(42))

    def test_active_levels_zero_through_five_not_trained_levels(self):
        for level in range(6):
            with self.subTest(level=level):
                rows = [{'skill_id': sid, 'active_skill_level': level,
                         'trained_skill_level': 5-level} for sid in SKILL_FIELDS]
                rows.append({'skill_id': 1, 'active_skill_level': 5})
                with patch.object(auth, 'get_json', return_value=auth.EsiResult({'skills': rows})):
                    result = get_character_jump_profile(42)
                self.assertTrue(result.ok)
                for field in SKILL_FIELDS.values():
                    self.assertEqual(getattr(result.data, field), level)

    def test_invalid_payload_not_a_zero_profile(self):
        for payload in [{}, {'skills': None}, {'skills': [None]}] + [
            {'skills': [{'skill_id': 3456, 'active_skill_level': level}]}
            for level in [None, -1, 6, True, '5']
        ]:
            with self.subTest(payload=payload), patch.object(auth, 'get_json', return_value=auth.EsiResult(payload)):
                result = get_character_jump_profile(42)
                self.assertEqual(result.error.kind, 'invalid_payload')
                self.assertIsNone(result.data)

    def test_missing_token_does_not_request_network(self):
        with patch.object(auth.sso, '_access_token', return_value=None), \
             patch.object(auth.urllib.request, 'urlopen') as network:
            result = get_character_jump_profile(42)
        self.assertEqual(result.error.kind, 'authentication')
        network.assert_not_called()

    def test_invalid_token_and_scope_keep_transport_errors(self):
        for status, kind in [(401, 'authentication'), (403, 'forbidden')]:
            with self.subTest(status=status), \
                 patch.object(auth.sso, '_access_token', return_value='test-token'), \
                 patch.object(auth.sso, '_refresh', return_value=False), \
                 patch.object(auth, '_observe'), \
                 patch.object(auth.urllib.request, 'urlopen', side_effect=HTTPError(
                     'https://esi.evetech.net/v4/characters/42/skills/', status, 'denied', {}, None)):
                result = get_character_jump_profile(42)
                self.assertEqual(result.error.kind, kind)
                self.assertEqual(result.status, status)
                self.assertIsNone(result.data)

    def test_transport_cache_and_rate_limit_observation_are_reused(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {'Expires': 'Wed, 01 Jan 2099 00:00:00 GMT', 'ETag': 'skills-v1'}
        response.read.return_value = json.dumps({'skills': []}).encode()
        with patch.object(auth.sso, '_access_token', return_value='test-token'), \
             patch.object(auth.urllib.request, 'urlopen', return_value=response) as network, \
             patch.object(auth, '_observe') as observe:
            first = get_character_jump_profile(42)
            second = get_character_jump_profile(42)
        network.assert_called_once()
        observe.assert_called_once()
        self.assertFalse(first.from_cache)
        self.assertTrue(second.from_cache)
        self.assertEqual(first.data, second.data)
        self.assertEqual(second.headers['ETag'], 'skills-v1')


if __name__ == '__main__':
    unittest.main()
