import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeletionService, ownedFamily } from '../src/service.js';

const image = digit => ({ attachmentId: `sha256:${digit.repeat(64)}` });
const refs = (images = [], files = []) => ({ images, files });
async function fixture(t, rows = [{ id: 'root' }]) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delete-service-'));
  t.after(async () => {
    const checked = resolve(home);
    assert.ok(checked.startsWith(resolve(tmpdir()) + '\\') || checked.startsWith(resolve(tmpdir()) + '/'));
    await rm(checked, { recursive: true, force: true });
  });
  const paths = { sessionsRoot: join(home, 'sessions'), attachmentRoot: join(home, 'attachments'),
    requestCacheRoot: join(home, 'cache'), stateRoot: join(home, 'state') };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  const items = rows.map(row => ({ title: row.id, origin: 'user', revision: 'one', busyReasons: [],
    events: [], refs: refs(), updatedAt: 1, ...row }));
  for (const row of items) {
    row.directory = join(paths.sessionsRoot, 'project', row.id);
    await mkdir(row.directory, { recursive: true });
    await writeFile(join(row.directory, 'session.v4.jsonl'), 'test transcript');
  }
  const guarded = new Set();
  const calls = [];
  const adapter = {
    paths, items, guarded, calls,
    status: () => ({ compatible: true }),
    inventory: async () => items.map(row => ({ ...row })),
    withAttachmentBarrier: async fn => fn(),
    inspect: async ids => ({ snapshot: { inventory: items, sessions: items.filter(row => ids.includes(row.id)).map(row => ({
      ...row, generations: [{ path: join(row.directory, 'session.v4.jsonl'), revision: row.revision, sizeBytes: 15 }],
    })) }, paths: items.filter(row => ids.includes(row.id)).map(row => ({
      id: row.id, directory: row.directory, materialized: true,
    })), attachments: { candidates: union(items.filter(row => ids.includes(row.id))),
      retained: union(items.filter(row => !ids.includes(row.id))) } }),
    beginDelete(ids) { ids.forEach(id => guarded.add(id)); return () => ids.forEach(id => guarded.delete(id)); },
    async closeTargets(ids) {
      calls.push('close');
      assert.ok(ids.every(id => guarded.has(id)));
      if (ids.some(id => items.find(row => row.id === id)?.busyReasons.length)) throw new Error('busy');
    },
    async removeMetadata(ids) {
      calls.push('metadata');
      if (adapter.failMetadata) throw new Error('metadata storage unavailable');
      for (let i = items.length - 1; i >= 0; i--) if (ids.includes(items[i].id)) items.splice(i, 1);
    },
    captureRefs: async ids => union(items.filter(row => ids.includes(row.id))),
    async removeUploadMappings(value) { calls.push('mappings'); adapter.cleanedMappings = value; },
    async emitRemoved(ids) { calls.push('emit'); adapter.emitted = ids; },
  };
  const service = new DeletionService(adapter);
  await service.initialize();
  return { home, paths, adapter, service };
}
function union(items) {
  return { images: items.flatMap(row => row.refs.images), files: items.flatMap(row => row.refs.files) };
}

test('owned descendants exclude independent forks and fork-owned children', () => {
  const rows = [{ id: 'root' }, { id: 'child', origin: 'subagent', parentSession: 'root' },
    { id: 'grandchild', origin: 'subagent', parentSession: 'child' },
    { id: 'fork', origin: 'fork', parentSession: 'root' }, { id: 'fork-child', origin: 'subagent', parentSession: 'fork' }];
  assert.deepEqual(ownedFamily(rows, 'root'), ['root', 'child', 'grandchild']);
});

test('delete removes target generations and children while retaining forks and shared uploads', async t => {
  const exclusive = image('a'); const shared = image('b');
  const { adapter, service, paths } = await fixture(t, [
    { id: 'root', refs: refs([exclusive, shared]) },
    { id: 'child', origin: 'subagent', parentSession: 'root' },
    { id: 'fork', origin: 'fork', parentSession: 'root', refs: refs([shared]) },
  ]);
  const rootDir = adapter.items[0].directory;
  await writeFile(join(rootDir, 'session.jsonl'), 'old generation');
  for (const value of [exclusive, shared]) {
    const digest = value.attachmentId.slice(7); const dir = join(paths.attachmentRoot, 'objects', digest.slice(0, 2));
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, digest), 'image bytes');
  }
  const p = await service.preview({ sessionId: 'root' });
  assert.equal(p.sessionCount, 2); assert.equal(p.attachmentCount, 1);
  const result = await service.remove({ sessionId: 'root', previewToken: p.previewToken });
  assert.deepEqual(result.deletedIds, ['root', 'child']);
  await assert.rejects(access(rootDir), { code: 'ENOENT' });
  assert.equal(await readFile(join(paths.attachmentRoot, 'objects', 'bb', 'b'.repeat(64)), 'utf8'), 'image bytes');
  await assert.rejects(access(join(paths.attachmentRoot, 'objects', 'aa', 'a'.repeat(64))), { code: 'ENOENT' });
  assert.deepEqual(adapter.items.map(row => row.id), ['fork']);
  assert.deepEqual(adapter.calls, ['close', 'emit', 'metadata', 'mappings']);
  assert.equal(adapter.guarded.size, 0);
  assert.deepEqual(await service.files.listPending(), []);
});

test('busy descendants prevent deletion before creating operation journal', async t => {
  const { service, adapter } = await fixture(t, [{ id: 'root' },
    { id: 'child', origin: 'subagent', parentSession: 'root', busyReasons: ['等待审批'] }]);
  const p = await service.preview({ sessionId: 'root' });
  assert.equal(p.previewToken, ''); assert.equal(p.busyReasons.length, 1);
  await assert.rejects(service.remove({ sessionId: 'root', previewToken: '' }), { code: 'PREVIEW_REQUIRED' });
  assert.deepEqual(adapter.calls, []); assert.deepEqual(await service.files.listPending(), []);
});

test('writes and lineage changes invalidate a confirmed preview without deleting anything', async t => {
  const { service, adapter } = await fixture(t);
  const p = await service.preview({ sessionId: 'root' });
  adapter.items[0].events.push({ type: 'user/message', data: { text: 'new event' } });
  await assert.rejects(service.remove({ sessionId: 'root', previewToken: p.previewToken }), { code: 'STALE_PREVIEW' });
  await access(adapter.items[0].directory); assert.equal(adapter.guarded.size, 0);
  assert.deepEqual(adapter.calls, []);
});

test('a preview token is scoped to one root and cannot be reused', async t => {
  const { service, adapter } = await fixture(t, [{ id: 'root' }, { id: 'other' }]);
  const p = await service.preview({ sessionId: 'root' });
  await assert.rejects(service.remove({ sessionId: 'other', previewToken: p.previewToken }), { code: 'PREVIEW_REQUIRED' });
  await assert.rejects(service.remove({ sessionId: 'root', previewToken: p.previewToken }), { code: 'PREVIEW_REQUIRED' });
  assert.equal(adapter.items.length, 2);
});

test('failure retains deletion guard and body-free journal, then permits explicit retry', async t => {
  const { service, adapter } = await fixture(t);
  const p = await service.preview({ sessionId: 'root' });
  adapter.failMetadata = true;
  await assert.rejects(service.remove({ sessionId: 'root', previewToken: p.previewToken }), { code: 'CLEANUP_INCOMPLETE' });
  assert.equal(adapter.guarded.has('root'), true);
  const [journal] = await service.files.listPending();
  assert.equal(journal.phase, 'logs');
  assert.equal(JSON.stringify(journal).includes('test transcript'), false);
  assert.equal(JSON.stringify(journal).includes('title'), false);
  adapter.failMetadata = false;
  const retry = await service.preview({ sessionId: 'root' });
  assert.equal((await service.remove({ sessionId: 'root', previewToken: retry.previewToken })).complete, true);
  assert.equal(adapter.guarded.size, 0); assert.deepEqual(await service.files.listPending(), []);
});

test('startup resumes an interrupted confirmed operation', async t => {
  const { service, adapter } = await fixture(t);
  const p = await service.preview({ sessionId: 'root' }); adapter.failMetadata = true;
  await assert.rejects(service.remove({ sessionId: 'root', previewToken: p.previewToken }));
  adapter.failMetadata = false;
  const restarted = new DeletionService(adapter);
  await restarted.initialize();
  assert.deepEqual(adapter.items, []); assert.deepEqual(await restarted.files.listPending(), []);
});

test('unsupported runtime provides explanation and cannot preview or remove', async t => {
  const { service, adapter } = await fixture(t);
  adapter.status = () => ({ compatible: false, reason: '版本不匹配' });
  assert.deepEqual(await service.list(), { compatible: false, reason: '版本不匹配', sessions: [] });
  await assert.rejects(service.preview({ sessionId: 'root' }), { code: 'UNSUPPORTED' });
  assert.equal(adapter.items.length, 1);
});
