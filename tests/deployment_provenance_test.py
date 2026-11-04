import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
import json
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_provenance', ROOT / 'scripts/build_provenance.py')
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)

class DeploymentProvenanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / 'source.ts').write_text('source')
        (self.root / 'dist').mkdir()
        (self.root / 'dist/worker.js').write_bytes(b'AAAA')
        (self.root / '.gitignore').write_text('dist/\n')
        def git(*args):
            return subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)
        git('init')
        git('add', '.')
        git('-c', 'user.name=Offline Test', '-c', 'user.email=offline@example.test', 'commit', '-m', 'fixture')

    def seal(self):
        return provenance.seal_build(self.root, 'kidsbook-factory', ['dist/worker.js'])

    def test_actual_bytes_and_source_are_bound(self):
        receipt = self.seal()
        self.assertEqual(len(receipt['sourceSha']), 40)
        self.assertEqual(len(receipt['buildDigest']), 64)
        self.assertEqual(provenance.verify_build(self.root, receipt, 'kidsbook-factory'), receipt)

    def test_same_size_bundle_edit_is_refused(self):
        receipt = self.seal()
        (self.root / 'dist/worker.js').write_bytes(b'BBBB')
        with self.assertRaises(ValueError):
            provenance.verify_build(self.root, receipt, 'kidsbook-factory')

    def test_dirty_source_is_not_blessed(self):
        (self.root / 'source.ts').write_text('uncommitted change')
        with self.assertRaises(ValueError):
            self.seal()

    def test_wrong_worker_or_tampered_receipt_is_refused(self):
        receipt = self.seal()
        with self.assertRaises(ValueError):
            provenance.verify_build(self.root, receipt, 'bigbrainshelf')
        receipt['sourceSha'] = 'f' * 40
        with self.assertRaises(ValueError):
            provenance.verify_build(self.root, receipt, 'kidsbook-factory')

    def test_added_uploaded_module_changes_the_expected_artifact_set(self):
        receipt = self.seal()
        (self.root / 'dist/extra.js').write_bytes(b'EXTRA')
        with self.assertRaises(ValueError):
            provenance.verify_build(self.root, receipt, 'kidsbook-factory', ['dist/worker.js', 'dist/extra.js'])

    def load_uploader(self, relative):
        spec = importlib.util.spec_from_file_location('offline_' + relative.replace('/', '_'), ROOT / relative)
        module = importlib.util.module_from_spec(spec)
        with patch('urllib.request.urlopen', side_effect=AssertionError('Import must not access the network')):
            spec.loader.exec_module(module)
        return module

    def test_hub_uploader_carries_verified_bytes_and_binding_and_keeps_receipts(self):
        for name, data in [('dist/server/worker.mjs', b'WORKER'), ('dist/server/entry.mjs', b'ENTRY'), ('dist/client/asset.txt', b'ASSET')]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        receipt = provenance.seal_build(self.root, 'bigbrainshelf', provenance.artifact_paths(self.root, 'bigbrainshelf'))
        (self.root / 'dist/build-provenance.json').write_text(json.dumps(receipt))
        uploader = self.load_uploader('deploy.py')
        uploader.BASE = str(self.root)
        calls = []
        def fake_api(method, path, body=None, **kwargs):
            calls.append((method, path, body))
            if path.endswith('assets-upload-session'):
                return {'success': True, 'result': {'jwt': 'offline-session', 'buckets': []}}
            if path.endswith('/schedules'):
                return {'success': True, 'result': {'schedules': [{'cron': '*/15 * * * *'}]}}
            self.assertIn(receipt['sourceSha'].encode(), body)
            self.assertIn(receipt['buildDigest'].encode(), body)
            self.assertIn(b'BBS_BUILD_PROVENANCE', body)
            self.assertIn(b'WORKER', body)
            return {'success': True, 'result': {'version_id': 'offline-version'}}
        uploader.api = fake_api
        uploader.main()
        records = [json.loads(line) for line in next((self.root / '.deployment-records/deployments').glob('*.jsonl')).read_text().splitlines()]
        self.assertEqual([r['status'] for r in records], ['prepared', 'worker-uploaded', 'completed'])
        self.assertEqual(records[-1]['provider']['versionId'], 'offline-version')
        # Equal-size changes after sealing fail before even a fake upload.
        (self.root / 'dist/server/worker.mjs').write_bytes(b'CHANGED')
        calls.clear()
        with self.assertRaises(ValueError):
            uploader.main()
        self.assertEqual(calls, [])

    def test_factory_uploader_is_import_safe_and_stamps_verified_bundle(self):
        path = self.root / 'factory/dist/worker.js'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'FACTORY')
        receipt = provenance.seal_build(self.root, 'kidsbook-factory', ['factory/dist/worker.js'])
        (path.parent / 'build-provenance.json').write_text(json.dumps(receipt))
        uploader = self.load_uploader('factory/deploy.py')
        uploader.ROOT = self.root
        uploader.add_surrogate_to_request = lambda *args, **kwargs: None
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"success":true,"result":{"version_id":"offline-factory"}}'
        with patch('urllib.request.urlopen', return_value=Response()) as mocked:
            uploader.main()
            request = mocked.call_args.args[0]
            self.assertIn(receipt['buildDigest'].encode(), request.data)
            self.assertIn(receipt['sourceSha'].encode(), request.data)
            self.assertIn(b'FACTORY', request.data)

    def test_failed_upload_appends_failure_without_overwriting_intent(self):
        path = self.root / 'factory/dist/worker.js'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'FACTORY')
        receipt = provenance.seal_build(self.root, 'kidsbook-factory', ['factory/dist/worker.js'])
        (path.parent / 'build-provenance.json').write_text(json.dumps(receipt))
        def fail(*args): raise RuntimeError('offline transport failure')
        with self.assertRaises(RuntimeError):
            provenance.deploy_recorded(self.root, 'kidsbook-factory', fail)
        records = [json.loads(line) for line in next((self.root / '.deployment-records/deployments').glob('*.jsonl')).read_text().splitlines()]
        self.assertEqual([r['status'] for r in records], ['prepared', 'failed-or-unconfirmed'])

if __name__ == '__main__':
    unittest.main()
