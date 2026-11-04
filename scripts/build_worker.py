"""Build and seal committed source. No credentials, model calls or uploads."""
import json
from pathlib import Path
import subprocess
import sys
import uuid
from build_provenance import source_sha, artifact_paths, seal_build, append_record


def main():
    root = Path(__file__).resolve().parents[1]
    target = sys.argv[1] if len(sys.argv) == 2 else ''
    worker = {'hub': 'bigbrainshelf', 'factory': 'kidsbook-factory'}.get(target)
    if worker is None:
        raise ValueError('Usage: python3 scripts/build_worker.py hub|factory')
    before = source_sha(root)
    build_id = str(uuid.uuid4())
    append_record(root, 'builds', build_id, {'status': 'started', 'worker': worker, 'sourceSha': before})
    try:
        if target == 'hub':
            subprocess.run(['bun', 'run', 'astro', 'build'], cwd=root, check=True)
            subprocess.run(['node', 'scripts/prepare-worker-entry.mjs'], cwd=root, check=True)
            output = root / 'dist/build-provenance.json'
        else:
            candidates = [root / 'factory/node_modules/.bin/esbuild', root / 'node_modules/.bin/esbuild']
            bundler = next((str(p) for p in candidates if p.exists()), None)
            if bundler is None:
                raise ValueError('Install the declared factory dependencies before building; no automatic download is performed.')
            subprocess.run([bundler, 'src/index.ts', '--bundle', '--format=esm', '--platform=browser',
                            '--target=es2022', '--external:cloudflare:workers', '--outfile=dist/worker.js'], cwd=root / 'factory', check=True)
            output = root / 'factory/dist/build-provenance.json'
        receipt = seal_build(root, worker, artifact_paths(root, worker), before)
        append_record(root, 'builds', build_id, {'status': 'sealed', 'build': receipt})
        output.write_text(json.dumps(receipt, indent=2) + '\n')
        print(f"sealed {worker}: source={before} build={receipt['buildDigest']}")
    except Exception as error:
        append_record(root, 'builds', build_id, {'status': 'failed', 'errorType': type(error).__name__})
        raise


if __name__ == '__main__':
    main()
