"""Public build identity. Never read credentials from the user's state/.env."""
import json
from pathlib import Path

CALLBACK_URL = 'http://127.0.0.1:8766/callback'

def client_id():
    try:
        value = json.loads((Path(__file__).parent / 'mmd_sso_build.json').read_text())['client_id']
    except (OSError, ValueError, KeyError):
        raise RuntimeError('MMD build SSO configuration missing. Contact the MMD maintainer.') from None
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError('MMD build Client ID missing. Contact the MMD maintainer.')
    return value.strip()
