"""Loopback static production server; rejects every /api/* request for offline QA."""
import argparse
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    directory = ROOT / 'frontend/dist'
    if not (directory / 'replay/manifest.json').is_file():
        parser.error('Run npm.cmd run package:replay and npm.cmd run build first.')
    evidence = ROOT / 'docs/evidence/a5'
    evidence.mkdir(parents=True, exist_ok=True)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def do_GET(self):
            if urlsplit(self.path).path.startswith('/api/'):
                self.send_error(503, 'STATIC_REPLAY_HAS_NO_BACKEND')
            else:
                super().do_GET()

        def do_POST(self):
            self.send_error(503, 'STATIC_REPLAY_HAS_NO_BACKEND')

        def log_request(self, code='-', size='-'):
            with (evidence / 'static-requests.jsonl').open('a', encoding='utf-8') as f:
                f.write(json.dumps({'path': self.path, 'status': code, 'method': self.command})+'\n')

    print(f'Static replay: http://127.0.0.1:{args.port}/?runtime=saved&audit=1', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
