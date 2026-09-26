"""Package the reproducible dataset and synthetic media for review."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import os


root = Path(__file__).resolve().parent
workspace = root.parent
target = workspace / 'ORBITA-QC-full-data.zip'
temporary = target.with_suffix('.zip.tmp')

if root.name != 'quality_dataset' or not (root / 'expanded_dataset/manifest.json').is_file():
    raise SystemExit('Unexpected dataset layout')

with ZipFile(temporary, 'w', ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file() and not {'__pycache__', '.git'}.intersection(file.relative_to(root).parts):
            archive.write(file, file.relative_to(workspace))

with ZipFile(temporary) as archive:
    broken = archive.testzip()
    if broken:
        raise SystemExit(f'Archive verification failed: {broken}')
    print(f'{len(archive.namelist())} files in dataset archive')

os.replace(temporary, target)
print(target)
