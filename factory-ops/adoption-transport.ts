/** RGM-operated S3 adapter. No credentials are read and no command runs on import. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { bytesHash } from '../packages/core/src/assembly-identity';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function awsBucket(options: { slug: string; account: string; bucket: string; directory: string; executable?: string; execute?: typeof spawnSync }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.slug) || !/^[a-f0-9]{32}$/.test(options.account) || !/^[a-z0-9][a-z0-9-]*$/.test(options.bucket)) throw new Error('Invalid S3 configuration');
  const execute = options.execute ?? spawnSync;
  const cached = new Map<string, any>();
  function call(operation: string, args: string[]) {
    const result = execute(options.executable ?? 'aws', ['--endpoint-url', `https://${options.account}.r2.cloudflarestorage.com`, '--no-cli-pager', '--output', 'json', 's3api', operation,
      '--bucket', options.bucket, ...args], { encoding: 'utf8', env: { ...process.env, AWS_DEFAULT_REGION: 'auto', AWS_REGION: 'auto', AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' } });
    if (result.status !== 0) {
      // Do not print command output: SDK/CLI diagnostics may contain sensitive request data.
      const detail = String(result.stderr ?? '');
      if (/\b(NoSuchKey|NotFound|404)\b/.test(detail)) return null;
      if (/PreconditionFailed|412/.test(detail)) throw new Error('Conditional plan write rejected; another operator changed it');
      throw new Error(`S3 ${operation} failed or is unconfirmed (exit ${result.status ?? 'unknown'}); inspect locally`);
    }
    return JSON.parse(String(result.stdout || '{}'));
  }
  function keyCheck(key: string) { if (!key.startsWith(`books/${options.slug}/`) || key.includes('..')) throw new Error('Object outside selected book'); }
  return {
    async get(key: string) {
      keyCheck(key); const file = join(options.directory, `${randomUUID()}.object`);
      const result = call('get-object', ['--key', key, file]); if (!result) return null;
      // Retain every fetched original; never remove an input to tidy the run folder.
      const bytes = new Uint8Array(readFileSync(file)); cached.set(key, result);
      writeFileSync(`${file}.json`, JSON.stringify({ key, at: new Date().toISOString(), etag: result.ETag, bytes: bytes.length, sha256: bytesHash(bytes) }), { flag: 'wx' });
      return { etag: result.ETag, arrayBuffer: async () => bytes.buffer, httpMetadata: { contentType: result.ContentType }, customMetadata: result.Metadata };
    },
    async head(key: string) { keyCheck(key); const result = call('head-object', ['--key', key]); return result ? { etag: result.ETag, size: result.ContentLength, customMetadata: result.Metadata } : null; },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      keyCheck(prefix);
      const result = call('list-objects-v2', ['--prefix', prefix, '--max-keys', '1000', '--no-paginate', ...(cursor ? ['--continuation-token', cursor] : [])]);
      if (!result) throw new Error('Object list unavailable');
      writeFileSync(join(options.directory, `${randomUUID()}.listing.json`), JSON.stringify({ prefix, cursor, at: new Date().toISOString(), response: result }), { flag: 'wx' });
      return { objects: (result.Contents ?? []).map((o: any) => ({ key: o.Key, size: o.Size })), truncated: result.IsTruncated ?? false, cursor: result.NextContinuationToken };
    },
    async put(key: string, body: string, init: { onlyIf: { etagMatches: string } }) {
      if (!new RegExp(`^books/${options.slug}/plans/S[1-9][0-9]*\\.json$`).test(key) || !init?.onlyIf?.etagMatches) throw new Error('Only conditional plan JSON writes are authorized');
      const file = join(options.directory, `${randomUUID()}.plan.json`); writeFileSync(file, body, { flag: 'wx' });
      const original = cached.get(key);
      if (!original) throw new Error('Plan must be captured before a write');
      const result = call('put-object', ['--key', key, '--body', file, '--if-match', init.onlyIf.etagMatches, '--content-type', original.ContentType ?? 'application/json',
        ...(original.Metadata ? ['--metadata', JSON.stringify(original.Metadata)] : []),
        ...(original.CacheControl ? ['--cache-control', original.CacheControl] : []),
        ...(original.ContentEncoding ? ['--content-encoding', original.ContentEncoding] : []),
        ...(original.ContentDisposition ? ['--content-disposition', original.ContentDisposition] : []),
        ...(original.ContentLanguage ? ['--content-language', original.ContentLanguage] : []),
        ...(original.Expires ? ['--expires', original.Expires] : [])]);
      if (!result) throw new Error('Conditional plan write unconfirmed');
      return { etag: result.ETag };
    },
  };
}
