"""Maintainer-only: materialize the public Client ID, never a client secret."""
import json
import os
from pathlib import Path

def configure():
    path = Path(__file__).resolve().parents[1] / 'mmd_sso_build.json'
    value = os.environ.get('MMD_EVE_CLIENT_ID', '').strip()
    if not value and path.is_file():
        value = json.loads(path.read_text(encoding='utf-8')).get('client_id','').strip()
    if not value:
        raise RuntimeError('Build requires official MMD_EVE_CLIENT_ID')
    path.write_text(json.dumps({'client_id': value}), encoding='utf-8')

if __name__ == '__main__':
    configure()
