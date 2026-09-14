"""Fail closed on private/runtime files in the explicit release source set.

Reports paths and rule names only, never matched credential values.
"""
import ast
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git','build','dist','__pycache__','.venv','node_modules'}


def audit():
    findings = []
    files = []
    for path in ROOT.rglob('*'):
        if not path.is_file() or any(part in SKIP for part in path.relative_to(ROOT).parts):
            continue
        relative = path.relative_to(ROOT).as_posix()
        if path.suffix in ('.pyc','.spec') or relative == 'release-audit.json':
            continue
        files.append(relative)
        if path.name.startswith(('.env','boot_')) or path.suffix in ('.db','.log','.mp3','.wav') or 'reference/' in relative:
            findings.append([relative,'runtime/private file'])
        if path.stat().st_size > 90*1024*1024:
            findings.append([relative,'oversized artifact'])
        if path.suffix in ('.py','.js','.json','.html','.md','.txt'):
            data = path.read_text(encoding='utf-8')
            if path.name != 'audit_release.py':
                for rule,pattern in {
                    'personal path':r'(?i)[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[^\\/\s]+',
                    'personal email':r'[\w.+-]+@(?:hotmail|gmail|outlook)\.[a-z]+',
                    'private key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
                }.items():
                    if re.search(pattern,data): findings.append([relative,rule])
            if path.suffix == '.py':
                ast.parse(data,filename=relative)
    gui = ast.parse((ROOT/'mmd_gui.py').read_text(encoding='utf-8'))
    api = next(n for n in gui.body if isinstance(n,ast.ClassDef) and n.name=='Api')
    methods = {n.name for n in api.body if isinstance(n,ast.FunctionDef)}
    for name in files:
        path = ROOT/name
        if path.parent == ROOT/'gui' and path.suffix in ('.js','.html') and '.test.' not in name:
            calls = set(re.findall(r'\bapi\.([a-zA-Z_]\w*)\s*\(',path.read_text(encoding='utf-8')))
            findings.extend([name,'missing bridge method: '+method] for method in sorted(calls-methods))
    return {'files':files,'findings':findings,'ok':not findings}


if __name__ == '__main__':
    result = audit()
    print(json.dumps({'file_count':len(result['files']),'findings':result['findings'],'ok':result['ok']}))
    raise SystemExit(0 if result['ok'] else 1)
