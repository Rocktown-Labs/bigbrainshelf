"""Offline build receipts shared by both uploaders. Importing never deploys."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

HUB_ASSET_IGNORE = {'.assetsignore', '_worker.js', '_routes.json', 'wrangler.json', '.dev.vars'}


def source_sha(root):
    root = Path(root).resolve()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Commit tracked source changes before building or deploying.')
    # Reports outside build inputs may remain untracked. Untracked code cannot
    # be silently included in a bundle attributed to a committed source tree.
    for name in git('ls-files', '--others', '--exclude-standard').splitlines():
        if Path(name).suffix in {'.ts', '.tsx', '.astro', '.js', '.mjs', '.py', '.json', '.jsonc', '.sql', '.css', '.toml'}:
            raise ValueError(f'Untracked build input must be committed: {name}')
    return git('rev-parse', 'HEAD')


def artifact_paths(root, worker):
    root = Path(root).resolve()
    if worker == 'kidsbook-factory':
        return ['factory/dist/worker.js']
    if worker != 'bigbrainshelf':
        raise ValueError('Unknown worker.')
    paths = [p for p in (root / 'dist/server').rglob('*.mjs') if p.is_file()]
    paths += [p for p in (root / 'dist/client').rglob('*')
              if p.is_file() and p.relative_to(root / 'dist/client').as_posix() not in HUB_ASSET_IGNORE]
    if not (root / 'dist/server/worker.mjs').is_file() or not paths:
        raise ValueError('Hub build is incomplete.')
    return sorted(p.relative_to(root).as_posix() for p in paths)


def seal_build(root, worker, paths, expected_source=None):
    root = Path(root).resolve()
    sha = source_sha(root)
    if expected_source is not None and sha != expected_source:
        raise ValueError('Source changed during build.')
    artifacts = []
    for name in sorted(set(paths)):
        path = (root / name).resolve()
        if path.is_relative_to(root) is False or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'Missing, empty or external artifact: {name}')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        artifacts.append({'path': name, 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()})
    if not artifacts:
        raise ValueError('No build artifacts.')
    receipt = {'schema': 'worker-build/v1', 'worker': worker, 'sourceSha': sha, 'artifacts': artifacts}
    receipt['buildDigest'] = hashlib.sha256(json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return receipt


def verify_build(root, receipt, worker, paths=None):
    if receipt.get('schema') != 'worker-build/v1' or receipt.get('worker') != worker:
        raise ValueError('Build receipt belongs to a different worker or schema.')
    expected = seal_build(root, worker, paths if paths is not None else [a['path'] for a in receipt['artifacts']])
    if receipt != expected:
        raise ValueError('Source or uploaded artifact bytes changed. Rebuild before deploying.')
    return receipt


def deployment_binding(receipt, deployment_id):
    return {'schema': receipt['schema'], 'worker': receipt['worker'], 'sourceSha': receipt['sourceSha'],
            'buildDigest': receipt['buildDigest'], 'deploymentId': deployment_id}


def append_record(root, category, identifier, event):
    directory = Path(root) / '.deployment-records' / category
    directory.mkdir(parents=True, exist_ok=True)
    # Append, never replace. Keep local receipts outside dist: Astro clears dist.
    with (directory / f'{identifier}.jsonl').open('a') as stream:
        stream.write(json.dumps({'recordedAt': int(time.time() * 1000), **event}, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def prepare_deployment(root, worker):
    root = Path(root).resolve()
    receipt_path = root / ('factory/dist/build-provenance.json' if worker == 'kidsbook-factory' else 'dist/build-provenance.json')
    receipt = json.loads(receipt_path.read_text())
    verify_build(root, receipt, worker, artifact_paths(root, worker))
    identifier = str(uuid.uuid4())
    binding = deployment_binding(receipt, identifier)
    append_record(root, 'deployments', identifier, {'status': 'prepared', 'build': receipt, 'binding': binding})
    return receipt, binding


def verified_bytes(root, receipt, name):
    """Check the bytes actually passed to the uploader, after initial preflight."""
    entry = next((a for a in receipt['artifacts'] if a['path'] == name), None)
    data = (Path(root) / name).read_bytes()
    if entry is None or len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError(f'Artifact changed while preparing upload: {name}')
    return data


def archive_build(root, identifier, receipt):
    """Retain the exact sealed bytes per invocation; never dedupe or replace."""
    directory = Path(root) / '.deployment-records' / 'builds' / identifier
    directory.mkdir(parents=True, exist_ok=False)
    for entry in receipt['artifacts']:
        data = verified_bytes(root, receipt, entry['path'])
        target = directory / 'artifacts' / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
    with (directory / 'receipt.json').open('x') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
    return str(directory.relative_to(root))


def deploy_recorded(root, worker, upload):
    receipt, binding = prepare_deployment(root, worker)
    identifier = binding['deploymentId']
    try:
        result = upload(receipt, binding)
    except BaseException as error:
        append_record(root, 'deployments', identifier, {'status': 'failed-or-unconfirmed',
                      'binding': binding, 'errorType': type(error).__name__})
        raise
    append_record(root, 'deployments', identifier, {'status': 'completed', 'binding': binding,
                  'provider': result})
    print(json.dumps({'event': 'deployment_provenance', **binding}))
    return result
