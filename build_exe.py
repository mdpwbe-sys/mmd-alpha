"""Explicit application assets only. Never package a working directory wholesale."""
from pathlib import Path
from tools.configure_sso_build import configure

ROOT = Path(__file__).resolve().parent


def asset_files():
    allowed = []
    for path in (ROOT/'gui').rglob('*'):
        if not path.is_file() or path.suffix not in ('.html','.css','.js','.webp','.png'):
            continue
        if '.test.' in path.name or path.name.startswith(('preview','test_')):
            continue
        allowed.append(path)
    return sorted(allowed)


def main():
    import PyInstaller.__main__
    configure()
    args = [str(ROOT/'mmd_gui.py'),'--name=MMD-Alpha-0.1','--onefile','--windowed',
            '--noconfirm','--clean','--exclude-module=tkinter','--exclude-module=pytest',
            '--hidden-import=pythoncom','--hidden-import=win32com.client',
            '--hidden-import=tools.build_eve_map']
    for path in asset_files()+[ROOT/'mmd_sso_build.json', ROOT/'LICENSE', ROOT/'THIRD_PARTY_NOTICES.txt']:
        args.append(f'--add-data={path};{path.parent.relative_to(ROOT)}')
    PyInstaller.__main__.run(args)


if __name__ == '__main__':
    main()
