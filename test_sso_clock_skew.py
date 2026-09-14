"""Signed synthetic tokens only: never read a real user's SSO cache."""
from datetime import datetime, timezone
import unittest
from unittest.mock import Mock, patch
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
import mmd_sso_jwt as validation
from mmd_sso_config import client_id


NOW = 2_000_000_000


class FixedClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime.fromtimestamp(NOW, tz=timezone.utc)


class ClockSkewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537,key_size=2048)

    def validate(self, **changes):
        claims = {'iss':'https://login.eveonline.com/','aud':[client_id(),'EVE Online'],
                  'exp':NOW+1200,'iat':NOW,'nbf':NOW,'sub':'CHARACTER:EVE:42','name':'Test Pilot','scp':[]}
        claims.update(changes)
        token = jwt.encode(claims,self.key,algorithm='RS256')
        with patch.object(validation,'key_client',return_value=Mock(get_signing_key_from_jwt=Mock(return_value=Mock(key=self.key.public_key())))), \
             patch('jwt.api_jwt.datetime',FixedClock):
            return validation.validate(token,client_id())

    def test_future_issued_token_is_rejected(self):
        with self.assertRaises(jwt.ImmatureSignatureError):
            self.validate(iat=NOW+131,nbf=NOW+131)

    def test_current_token_is_accepted(self):
        self.assertEqual(self.validate()['CharacterID'],42)

    def test_larger_future_date_is_rejected(self):
        with self.assertRaises(jwt.ImmatureSignatureError):
            self.validate(iat=NOW+181)

    def test_expired_beyond_grace_is_still_rejected(self):
        with self.assertRaises(jwt.ExpiredSignatureError):
            self.validate(exp=NOW-181)

    def test_wrong_audience_is_not_fixed_by_clock_tolerance(self):
        with self.assertRaises(jwt.InvalidAudienceError):
            self.validate(aud=['wrong-client','EVE Online'])
