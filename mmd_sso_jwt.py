"""Validate EVE-signed access tokens before persisting them."""
import json
import urllib.request
from functools import lru_cache
import jwt

@lru_cache(maxsize=1)
def key_client():
    with urllib.request.urlopen('https://login.eveonline.com/.well-known/oauth-authorization-server', timeout=20) as response:
        uri = json.load(response)['jwks_uri']
    if not uri.startswith('https://login.eveonline.com/'):
        raise ValueError('Unexpected EVE JWKS endpoint')
    return jwt.PyJWKClient(uri, timeout=20, lifespan=300)

def validate(token, client_id):
    key = key_client().get_signing_key_from_jwt(token).key
    claims = jwt.decode(token, key, algorithms=['RS256'], audience=client_id,
        issuer=['https://login.eveonline.com/', 'https://login.eveonline.com', 'login.eveonline.com'],
        options={'require':['exp','iss','aud','sub','name']})
    if not isinstance(claims['aud'], list) or 'EVE Online' not in claims['aud'] or client_id not in claims['aud']:
        raise ValueError('Invalid EVE token audience')
    subject = claims['sub'].split(':')
    if len(subject)!=3 or subject[:2]!=['CHARACTER','EVE'] or not subject[2].isdigit():
        raise ValueError('Invalid EVE character subject')
    return {'CharacterID':int(subject[2]), 'CharacterName':claims['name'],
            'Scopes':' '.join(claims.get('scp',[])) if isinstance(claims.get('scp',[]),list) else claims['scp']}
