"""Package only the frozen synthetic campaign inputs for a private Kaggle run."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = 'plans/20261012-integrated-campaign/reports/evaluation-protocol.json'


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    protocol = json.loads((ROOT / PROTOCOL).read_text())
    locked = {**protocol['code_hashes'], **protocol['asset_hashes']}
    files = {}
    for name, expected in locked.items():
        raw = (ROOT / name).read_bytes()
        if sha256(raw) != expected:
            raise ValueError('Frozen source or asset drift: ' + name)
        files[name] = raw
    # This existing helper was not in the original preregistration. Record its
    # current hash separately without rewriting the original evaluation lock.
    helper = 'backend/app/simulation.py'
    files[helper] = (ROOT / helper).read_bytes()
    files[PROTOCOL] = (ROOT / PROTOCOL).read_bytes()
    manifest = {'version': 'q1-campaign-kaggle/v1', 'protocol_id': protocol['id'],
                'files': {name: sha256(raw) for name, raw in files.items()},
                'additional_dependency': {'path': helper, 'sha256': sha256(files[helper]),
                                         'scope': 'Packaging-time integrity; not an original preregistered hash.'},
                'data_scope': 'Synthetic TRAIN profiles, fitted coefficients and public OSM-derived routing matrix. No credentials, source customer IDs, outcomes, oracle or held-out tables.'}
    args.output.mkdir(parents=True, exist_ok=False)
    archive = args.output / 'campaign-bundle.zip'
    with ZipFile(archive, 'w', compression=ZIP_DEFLATED) as bundle:
        for name, raw in files.items():
            bundle.writestr(name, raw)
        bundle.writestr('manifest.json', json.dumps(manifest, indent=2) + '\n')
    shutil.copyfile(ROOT / 'scripts/kaggle-campaign-run.py', args.output / 'main.py')
    instructions = """# Private Kaggle CPU execution

Upload campaign-bundle.zip and main.py to a private Kaggle Dataset. Create a
private Notebook, attach that Dataset, select CPU and disable Internet. No pip
installation, GPU, PBF, OSRM server or Docker is needed. The road matrices stay
exactly those in the frozen local bundle; the map viewer stays local.

Run this cell, substituting your Dataset's actual mounted path:

```python
import subprocess, sys
subprocess.run([sys.executable, '/kaggle/input/YOUR-DATASET/main.py',
                '--package', '/kaggle/input/YOUR-DATASET/campaign-bundle.zip',
                '--output', '/kaggle/working/wp3', '--smoke'], check=True)
```

After the smoke check, remove --smoke to run the original 144 frozen worlds,
three policies each, using two CPU workers. Run Save & Run All to retain outputs
under /kaggle/working/wp3. The previous local full evaluation occupied about
62 MiB. Download evidence/index.json, evidence/summary.json and every raw world
JSON. Re-running against the same intact output resumes verified evidence.

--smoke uses separate portability seeds and output; it is not primary evidence.
Do not tune parameters, seeds or the model from primary/smoke results. Both modes
check all original code and asset hashes before executing. No cloud run or
upload has been performed by this packaging command. Account CPU/runtime limits
depend on Kaggle access. Original conclusions remain conditional synthetic.

Official documentation:
https://www.kaggle.com/docs/notebooks
https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md
"""
    (args.output / 'README.md').write_text(instructions)
    summary = {'archive': str(archive.resolve()), 'bytes': archive.stat().st_size,
               'sha256': sha256(archive.read_bytes()), 'protocol_id': protocol['id'],
               'runner_sha256': sha256((args.output / 'main.py').read_bytes()),
               'cloud_executed': False, 'manifest': manifest}
    (args.output / 'package.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({k: v for k, v in summary.items() if k != 'manifest'}, indent=2))


if __name__ == '__main__':
    main()
