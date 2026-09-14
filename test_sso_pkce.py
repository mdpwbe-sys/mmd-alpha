import base64
import hashlib
import time
import unittest
from unittest.mock import patch, Mock
from urllib.parse import urlparse, parse_qs
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
import mmd_sso as sso
import mmd_sso_jwt as validation
from mmd_sso_config import client_id

class PkceTests(unittest.TestCase):
    def test_expired_state_rejected(self):
        state,_,_=sso._new_oauth_session()
        with patch.object(sso.time,'time',return_value=time.time()+601):
            self.assertIsNone(sso._consume_oauth_session(state))

    def test_refresh_invalid_token_does_not_persist(self):
        with patch.object(sso,'_chars',return_value={'42':{'access_token':'old','refresh_token':'old'}}), patch.object(sso,'_post_form',return_value={'access_token':'bad'}), patch.object(sso,'_verify',side_effect=ValueError('Invalid audience')), patch.object(sso,'_save_cache') as save:
            self.assertFalse(sso._refresh(42))
            save.assert_not_called()

    def test_pkce_state_callback_and_no_user_config(self):
        with patch.object(sso,'_load_env',side_effect=AssertionError('No user credentials')):
            query=parse_qs(urlparse(sso.get_login_url()).query)
        self.assertEqual(query['client_id'],[client_id()])
        self.assertEqual(query['redirect_uri'],['http://127.0.0.1:8766/callback'])
        self.assertEqual(query['code_challenge_method'],['S256'])
        self.assertIsNone(sso._consume_oauth_session('wrong'))
        verifier,callback=sso._consume_oauth_session(query['state'][0])
        challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(query['code_challenge'],[challenge])
        self.assertTrue(43<=len(verifier)<=128)
        self.assertIsNone(sso._consume_oauth_session(query['state'][0]))
        self.assertNotEqual(query['state'],parse_qs(urlparse(sso.get_login_url()).query)['state'])

    def test_exchange_and_refresh_without_secret(self):
        info={'CharacterID':42,'CharacterName':'Pilot','Scopes':'esi-skills.read_skills.v1'}
        cache={}
        with patch.object(sso,'_load_cache',side_effect=lambda:cache), patch.object(sso,'_save_cache',side_effect=lambda data:cache.update(data)), patch.object(sso,'_verify',return_value=info), patch.object(sso,'_post_form',return_value={'access_token':'access','refresh_token':'refresh','expires_in':1200}) as post:
            sso.exchange_code('code','verifier',sso.CALLBACK_URL)
            self.assertEqual(post.call_args.args[1]['client_id'],client_id())
            self.assertEqual(len(post.call_args.args),2)
            post.return_value={'access_token':'new','refresh_token':'rotated','expires_in':1200}
            self.assertTrue(sso._refresh(42))
            self.assertEqual(post.call_args.args[1],{'client_id':client_id(),'grant_type':'refresh_token','refresh_token':'refresh'})
            self.assertEqual(cache['characters']['42']['refresh_token'],'rotated')

    def test_real_jwt_signature_audiences_issuer_and_expiry(self):
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        claims={'iss':'https://login.eveonline.com/','aud':[client_id(),'EVE Online'],'exp':int(time.time())+60,'sub':'CHARACTER:EVE:42','name':'Pilot','scp':[]}
        with patch.object(validation,'key_client',return_value=Mock(get_signing_key_from_jwt=Mock(return_value=Mock(key=key.public_key())))):
            token=jwt.encode(claims,key,algorithm='RS256')
            self.assertEqual(validation.validate(token,client_id())['CharacterID'],42)
            for override in ({'aud':['other','EVE Online']},{'aud':[client_id()]},{'exp':1},{'iss':'https://evil.invalid/'}):
                with self.assertRaises((ValueError,jwt.PyJWTError)):
                    validation.validate(jwt.encode({**claims,**override},key,algorithm='RS256'),client_id())
            other=rsa.generate_private_key(public_exponent=65537,key_size=2048)
            with self.assertRaises(jwt.InvalidSignatureError):
                validation.validate(jwt.encode(claims,other,algorithm='RS256'),client_id())

if __name__=='__main__':
    unittest.main()
