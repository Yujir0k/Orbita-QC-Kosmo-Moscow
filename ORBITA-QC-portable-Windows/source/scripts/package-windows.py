"""Create the self-contained Windows demo archive from the verified portable site."""

from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import os

workspace = Path(__file__).resolve().parents[3]
application = workspace / 'ORBITA-QC-portable-Windows'
quality = workspace / 'quality_dataset'
target = workspace / 'ORBITA-QC-workspaces-Windows.zip'
temporary = target.with_suffix('.zip.tmp')

if application.resolve().parent != workspace.resolve() or not (application / 'site/index.html').is_file():
    raise SystemExit('Portable site is missing or application layout is unexpected')

excluded_dirs = {'node_modules', 'dist', 'data', '__pycache__', '.git'}
excluded_files = {'tsconfig.tsbuildinfo', 'preview.log', 'preview-error.log', 'portable-preview.log', 'portable-preview-error.log'}

with ZipFile(temporary, 'w', ZIP_DEFLATED, compresslevel=6) as archive:
    for file in application.rglob('*'):
        if file.is_file() and not excluded_dirs.intersection(file.relative_to(application).parts) and file.name not in excluded_files:
            archive.write(file, file.relative_to(workspace))
    for subtree in ['expanded_dataset', 'media', 'contracts']:
        for file in (quality / subtree).rglob('*'):
            if file.is_file() and not excluded_dirs.intersection(file.relative_to(quality).parts):
                archive.write(file, file.relative_to(workspace))
    for name in ['README.md', 'ДЕМО_СЦЕНАРИИ.md', 'АРХИТЕКТУРА_И_СБОР_ДАННЫХ.md', 'validate_expanded.py', 'replay_ingest.py']:
        file = quality / name
        archive.write(file, file.relative_to(workspace))
    audit = workspace / 'АУДИТ_ДАННЫХ_ОТК.md'
    archive.write(audit, audit.relative_to(workspace))

with ZipFile(temporary) as archive:
    broken = archive.testzip()
    if broken:
        raise SystemExit(f'Archive verification failed: {broken}')
    print(f'{len(archive.namelist())} files in archive')

os.replace(temporary, target)
print(target)
