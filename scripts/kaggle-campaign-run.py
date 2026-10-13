"""Verify and run the portable frozen campaign, on Kaggle or a local CPU."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
from zipfile import ZipFile

PROTOCOL = 'plans/20261012-integrated-campaign/reports/evaluation-protocol.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path)
    parser.add_argument('--output', type=Path, default=Path('/kaggle/working/wp3'))
    parser.add_argument('--smoke', action='store_true')
    parser.add_argument('--workers', type=int, choices=(1, 2), default=2)
    args = parser.parse_args()
    if args.package is None:
        candidates = list(Path('/kaggle/input').rglob('campaign-bundle.zip'))
        if len(candidates) != 1:
            parser.error('Specify --package; exactly one campaign-bundle.zip required')
        args.package = candidates[0]
    root = args.output.resolve() / 'source'
    with ZipFile(args.package) as bundle:
        manifest = json.loads(bundle.read('manifest.json'))
        if manifest['version'] != 'q1-campaign-kaggle/v1':
            raise ValueError('Unsupported campaign package')
        names = bundle.namelist()
        if len(names) != len(set(names)) or set(names) != {*manifest['files'], 'manifest.json'}:
            raise ValueError('Unexpected or duplicate package files')
        # Verify every member before writing any source or resuming outputs.
        files = {}
        for name, expected in manifest['files'].items():
            relative = PurePosixPath(name)
            if relative.is_absolute() or '..' in relative.parts or '\\' in name:
                raise ValueError('Invalid package path')
            raw = bundle.read(name)
            if hashlib.sha256(raw).hexdigest() != expected:
                raise ValueError('Package checksum mismatch: ' + name)
            target = root / name
            if target.exists() and target.read_bytes() != raw:
                raise ValueError('Existing extracted source drift: ' + name)
            files[target] = raw
        for target, raw in files.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(raw)
    protocol_path = root / PROTOCOL
    mode = 'evidence'
    if args.smoke:
        protocol = json.loads(protocol_path.read_text())
        protocol.update(id=protocol['id'] + '-portability-smoke',
                        seeds=['portability-smoke-20261012'],
                        response_scales=[1.0, 0.0],
                        workloads={'smoke': {'fleet': 3, 'quotes': 12}},
                        common={**protocol['common'], 'minutes': 5},
                        created_before_evaluation=False,
                        evidence='Portability smoke only; no primary acceptance claim.')
        protocol_path = root / 'portability-smoke.json'
        protocol_path.write_text(json.dumps(protocol, indent=2) + '\n')
        mode = 'evidence-smoke'
    subprocess.run([sys.executable, str(root / 'scripts/evaluate-campaign.py'),
                    str(protocol_path), str(args.output.resolve() / mode),
                    '--workers', str(args.workers)], cwd=root, check=True)


if __name__ == '__main__':
    main()
