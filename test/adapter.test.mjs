import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { RuntimeAdapter, SUPPORTED_RUNTIME, decompressSessionFrames, refsIn } from '../src/adapter.js';

const image = hash => ({ attachmentId: `sha256:${hash.repeat(64)}`, mediaType: 'image/png', width: 2, height: 2 });
const file = (hash, name) => ({ attachmentId: `sha256:${hash.repeat(64)}`, bytes: 10, name });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('method wrappers restore exact descriptors through fresh Cordis-style method proxies', async () => {
  class ServiceFixture {
    constructor() { this.ctx = { prefix: 'caller-context' }; }
    inherited(value) { return `${this.ctx.prefix}:${value}`; }
  }
  const raw = new ServiceFixture();
  const ownMethod = function (value) { return `${this.ctx.prefix}:own:${value}`; };
  Object.defineProperty(raw, 'own', { value: ownMethod, enumerable: false, writable: true, configurable: true });
  const originalOwn = Object.getOwnPropertyDescriptor(raw, 'own');
  const service = new Proxy(raw, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? new Proxy(value, { apply: (method, thisArg, args) => Reflect.apply(method, thisArg, args) }) : value;
    },
  });
  const adapter = new RuntimeAdapter({});
  let calls = 0;
  for (const key of ['inherited', 'own']) adapter.wrap(service, key, original => function (...args) {
    calls += 1;
    return Reflect.apply(original, this, args);
  });
  assert.notEqual(service.inherited, service.inherited);
  assert.equal(service.inherited('value'), 'caller-context:value');
  assert.equal(service.own('value'), 'caller-context:own:value');
  assert.equal(calls, 2);
  await adapter.dispose();
  assert.equal(Object.hasOwn(raw, 'inherited'), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(raw, 'own'), originalOwn);
  assert.equal(service.inherited('restored'), 'caller-context:restored');
  assert.equal(service.own('restored'), 'caller-context:own:restored');
  assert.equal(calls, 2);
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delete-adapter-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'sessions');
  await mkdir(root, { recursive: true });
  const stored = new Map();
  const live = new Map();
  const agents = new Map();
  const projections = new Map();
  const workspaceRows = new Map();
  const events = [];
  const state = { workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] };
  const table = { get: id => workspaceRows.get(id), update: async (id, update) => workspaceRows.set(id, update(workspaceRows.get(id))) };
  const projectionTable = { delete: async id => projections.delete(id) };
  const services = {
    sessions: { get: id => live.get(id), list: () => [...live.values()] },
    agents: { get: id => agents.get(id), list: () => [...agents.values()], create: async () => {}, resume: async () => {} },
    agentLoop: { prepare(_ctx, id, _options, session) {
      const agent = { id, session, status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false }, send() { this.sent = (this.sent ?? 0) + 1; }, followup(message) { this.send(message); } };
      return { agent, dispose: async () => { live.delete(id); agents.delete(id); } };
    } },
    sessionPersistence: {
      root, config: { root }, tracker: { openHandles: new Set() }, coldLogMemo: new Map(), migrationPreparations: new Map(),
      list: async () => [...stored.values()].map(row => ({ header: row.header, revision: '1', sizeBytes: row.materialized ? 100 : undefined })),
      stat: async id => stored.get(id) ? { header: stored.get(id).header, revision: '1' } : undefined,
      locate: header => ({ kind: 'jsonl', path: join(root, 'project', header.id, 'session.v4.jsonl') }),
      create: async header => ({ header }), open: async id => ({ id }),
    },
    sessionQuery: { _observations: { cache: new Map() }, observeSession: async id => ({ id }), readSession: async id => ({ id }) },
    workspaceRegistry: {
      table, state, headers: new Map(), sessionPaths: new Map(), missingSessionPaths: new Set(), invalidSessionPaths: new Map(), entities: new Map(),
      archivedSessionIds: state.archivedSessionIds, pinnedSessionIds: state.pinnedSessionIds,
      list() { return [...this.entities.values()]; }, requireState() { return this.state; },
      async setState(next) { this.state = next; this.archivedSessionIds = next.archivedSessionIds; this.pinnedSessionIds = next.pinnedSessionIds; },
      enqueueOperation: work => work(),
    },
    storageDomain: {},
    sessionProjectionCache: { table: projectionTable, put: async (id, value) => projections.set(id, value), cachedSnapshot: header => ({ values: { title: { title: `对话 ${header.id}` } } }), cachedPredecessorTitle: () => undefined },
    sessionProjections: { cachedSnapshot: session => ({ values: { title: { title: `对话 ${session.id}` } } }) },
    attachments: {
      root: join(home, 'attachments', 'v1'), cacheRoot: join(home, 'cache', 'attachments'), requestInflight: new Map(),
      saveImage: async () => image('a'), saveImages: async function () { return [await this.saveImage()]; },
      saveFile: async () => file('b', 'shared.txt'), saveFileStream: async () => file('c', 'stream.txt'), requestVersion: async () => ({ data: Buffer.from('image') }),
    },
    fileUploads: { stagedFiles: new WeakMap(), async commit(agent, save) { const value = await save(); let map = this.stagedFiles.get(agent.session); if (!map) this.stagedFiles.set(agent.session, map = new Map()); map.set('receipt', { file: value }); return value; } },
    sessionController: { commands: { prompt: async () => ({ accepted: true }) } },
  };
  const ctx = { get: name => services[name], emit: (...args) => events.push(args), waterfall: (_name, _payload, next) => next() };
  const adapter = new RuntimeAdapter(ctx, { version: SUPPORTED_RUNTIME, dshHome: home });
  assert.equal((await adapter.install()).compatible, true);
  t.after(() => adapter.dispose());
  async function session(id, refs = [], { materialized = true, compressed = false, generation = 'v4' } = {}) {
    const header = { id, type: 'session', version: 4, createdAt: 10, cwd: home };
    const entries = refs.map((attachment, index) => ({ type: 'user/message', seq: index, data: { content: [{ type: attachment.width ? 'image' : 'file', attachment }] } }));
    stored.set(id, { header, materialized });
    if (materialized) {
      const directory = join(root, 'project', id);
      await mkdir(directory, { recursive: true });
      const name = `session.${generation}.jsonl${compressed ? '.zstd' : ''}`;
      const bytes = Buffer.from([header, ...entries].map(row => JSON.stringify(row)).join('\n') + '\n');
      await writeFile(join(directory, name), compressed ? zstdCompressSync(bytes) : bytes);
    }
    return { id, header, seq: entries.length, snapshotEvents: () => entries };
  }
  function activate(session) {
    const prepared = services.agentLoop.prepare(ctx, session.id, {}, session);
    live.set(session.id, session); agents.set(session.id, prepared.agent);
    return prepared;
  }
  return { adapter, services, home, root, stored, live, agents, projections, state, workspaceRows, events, session, activate };
}

test('unknown versions stay read-only and install no hooks', async () => {
  const loop = { prepare() {} };
  const original = loop.prepare;
  const adapter = new RuntimeAdapter({ get: () => loop }, { version: '0.9.0' });
  assert.equal((await adapter.install()).compatible, false);
  assert.match(adapter.status().reason, /0.2.1-rc.2/);
  assert.equal(loop.prepare, original);
  assert.throws(() => adapter.beginDelete(['a']), /仅支持/);
});

test('references distinguish image and named file references', () => {
  const result = refsIn([{ attachment: image('a') }, { attachment: file('b', 'report.txt') }], true);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.files, [{ attachmentId: file('b', 'report.txt').attachmentId, name: 'report.txt' }]);
});

test('inspects every compressed generation and preserves references from old generations', async t => {
  const f = await fixture(t);
  await f.session('target', [image('a'), file('b', 'shared.txt')]);
  await f.session('retained', [image('c')], { generation: 'v4', compressed: true });
  await f.session('retained', [image('a'), file('b', 'shared.txt')], { generation: 'v3', compressed: true });
  const result = await f.adapter.inspect(['target']);
  assert.equal(result.snapshot.sessions[0].generations.length, 1);
  assert.equal(result.paths[0].directory, join(f.root, 'project', 'target'));
  assert.equal(result.attachments.candidates.images.length, 1);
  assert.ok(result.attachments.retained.images.some(ref => ref.attachmentId === image('a').attachmentId));
  assert.ok(result.attachments.retained.files.some(ref => ref.name === 'shared.txt'));
});

test('staged files of other live sessions retain their bytes', async t => {
  const f = await fixture(t);
  await f.session('target', [file('b', 'shared.txt')]);
  const retained = await f.session('retained', [], { materialized: false });
  f.activate(retained);
  f.services.fileUploads.stagedFiles.set(retained, new Map([['receipt', { file: file('b', 'shared.txt') }]]));
  const result = await f.adapter.inspect(['target']);
  assert.ok(result.attachments.retained.files.some(ref => ref.name === 'shared.txt'));
});

test('damaged retained generation blocks attachment deletion planning', async t => {
  const f = await fixture(t);
  await f.session('target', [image('a')]);
  await f.session('retained');
  await writeFile(join(f.root, 'project', 'retained', 'session.v3.jsonl'), '{broken');
  await assert.rejects(f.adapter.inspect(['target']), error => error.code === 'UNREADABLE_SESSION');
});

test('deletion guards stop sends and cold reactivation while full disposers close targets', async t => {
  const f = await fixture(t);
  const session = await f.session('target');
  const { agent } = f.activate(session);
  const release = f.adapter.beginDelete(['target']);
  assert.throws(() => agent.followup('late message'), error => error.code === 'SESSION_DELETING');
  assert.throws(() => f.services.agents.resume({ resumeSessionId: 'target' }), error => error.code === 'SESSION_DELETING');
  await f.adapter.closeTargets(['target']);
  assert.equal(f.live.size, 0); assert.equal(f.agents.size, 0);
  release();
});

test('busy or uncaptured live lifecycle cannot be force detached', async t => {
  const f = await fixture(t);
  const session = await f.session('target');
  const { agent } = f.activate(session);
  agent.status = 'running';
  const release = f.adapter.beginDelete(['target']);
  await assert.rejects(f.adapter.closeTargets(['target']), error => error.code === 'SESSION_BUSY');
  assert.equal(f.live.get('target'), session);
  release();
});

test('parent deletion blocks new child publication and fresh forks while existing forks can resume', async t => {
  const f = await fixture(t);
  const parent = await f.session('parent'); const { agent } = f.activate(parent);
  const child = await f.session('new-child', [], { materialized: false });
  const fork = await f.session('existing-fork'); fork.header.parentSession = 'parent';
  const release = f.adapter.beginDelete(['parent']);
  assert.throws(() => f.services.agentLoop.prepare(f.services, 'new-child', {}, child, undefined, undefined, agent), error => error.code === 'SESSION_DELETING');
  assert.throws(() => f.services.sessionPersistence.create({ id: 'new-fork', parentSession: 'parent' }), error => error.code === 'SESSION_DELETING');
  assert.doesNotThrow(() => f.activate(fork));
  release();
});

test('attachment barrier drains nested admitted saves and delays new operations', async t => {
  const f = await fixture(t);
  const session = await f.session('target'); f.activate(session);
  const saving = deferred(); const order = [];
  const admitted = f.services.fileUploads.commit(f.agents.get('target'), async () => { await saving.promise; order.push('old save'); return f.services.attachments.saveFile(); });
  await new Promise(resolve => setImmediate(resolve));
  const inside = deferred(); const leave = deferred();
  const barrier = f.adapter.withAttachmentBarrier(async () => { order.push('barrier'); inside.resolve(); await leave.promise; });
  await new Promise(resolve => setImmediate(resolve));
  const fresh = f.services.attachments.saveImage().then(() => order.push('new save'));
  saving.resolve(); await admitted; await inside.promise;
  assert.deepEqual(order, ['old save', 'barrier']);
  leave.resolve(); await barrier; await fresh;
  assert.deepEqual(order, ['old save', 'barrier', 'new save']);
});

test('owner-aware upload pins do not retain attachments of the deleted owner', async t => {
  const f = await fixture(t);
  const target = await f.session('target'); f.activate(target);
  await f.services.fileUploads.commit(f.agents.get('target'), () => f.services.attachments.saveFile());
  const result = await f.adapter.withAttachmentBarrier(() => f.adapter.inspect(['target']));
  assert.equal(result.attachments.candidates.files.length, 1);
  assert.equal(result.attachments.retained.files.length, 0);
});

test('metadata removal drains writes and removes stale cache and legacy copies', async t => {
  const f = await fixture(t);
  await f.session('target');
  f.projections.set('target', { title: 'old' });
  f.services.sessionQuery._observations.cache.set('target', { old: true });
  f.services.sessionPersistence.coldLogMemo.set('target', { old: true });
  const storage = join(f.home, 'storages');
  await mkdir(join(storage, 'session_projcache', 'sessions'), { recursive: true });
  await writeFile(join(storage, 'session_projcache', 'sessions', 'target.json.bak.202610190830'), 'old');
  await writeFile(join(storage, 'session_projcache.json'), JSON.stringify({ unit: { name: 'session_projcache' }, tables: { sessions: { target: { title: 'old' }, keep: { title: 'keep' } } } }));
  const release = f.adapter.beginDelete(['target']);
  await f.services.sessionProjectionCache.put('target', { title: 'late' });
  await f.adapter.removeMetadata(['target']);
  assert.equal(f.projections.has('target'), false);
  assert.equal(f.services.sessionQuery._observations.cache.has('target'), false);
  assert.equal(f.services.sessionPersistence.coldLogMemo.has('target'), false);
  const legacy = JSON.parse(await readFile(join(storage, 'session_projcache.json'), 'utf8'));
  assert.deepEqual(Object.keys(legacy.tables.sessions), ['keep']);
  await assert.rejects(readFile(join(storage, 'session_projcache', 'sessions', 'target.json.bak.202610190830')), error => error.code === 'ENOENT');
  release();
});

test('local upload index cleanup uses exact generations and never invokes remote deletion', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, 'llm-deepseek'), { recursive: true });
  await writeFile(f.adapter.paths.uploadIndexPath, '{}');
  const removed = [];
  f.adapter.options.uploadIndexFactory = () => ({
    load: async () => ({ records: [
      { scope: 'owner', attachmentId: image('a').attachmentId, variantId: 'variant-a', fileId: 'file-a' },
      { scope: 'owner', attachmentId: image('b').attachmentId, variantId: 'variant-b', fileId: 'file-b' },
    ] }),
    remove: async (...args) => removed.push(args),
  });
  await f.adapter.removeUploadMappings({ images: [image('a')] });
  assert.deepEqual(removed, [['owner', [{ variantId: 'variant-a', fileId: 'file-a' }]]]);
});

test('concatenated checksummed Zstandard frames retain every append and embedded magic bytes', () => {
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  const inputs = [Buffer.from('header\n'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('image-reference\n'), Buffer.from('file-reference\n')];
  const encoded = Buffer.concat(inputs.map(input => zstdCompressSync(input, options)));
  assert.deepEqual(decompressSessionFrames(encoded), Buffer.concat(inputs));
});

test('all generations discover appended frame references and keep shares in older generations', async t => {
  const f = await fixture(t);
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  async function appendFrames(id, generation, attachments) {
    const session = await f.session(id, [], { compressed: true, generation });
    const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(session.header)}\n`), options)];
    for (const attachment of attachments) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', data: { attachment } })}\n`), options));
    await writeFile(join(f.root, 'project', id, `session.${generation}.jsonl.zstd`), Buffer.concat(frames));
  }
  await appendFrames('target', 'v4', [image('a'), file('b', 'appended.txt')]);
  await appendFrames('retained', 'v4', [image('c')]);
  await appendFrames('retained', 'v3', [image('a'), file('b', 'appended.txt')]);
  const result = await f.adapter.inspect(['target']);
  assert.deepEqual(result.attachments.candidates.images.map(ref => ref.attachmentId), [image('a').attachmentId]);
  assert.deepEqual(result.attachments.candidates.files, [{ attachmentId: file('b', 'appended.txt').attachmentId, name: 'appended.txt' }]);
  assert.ok(result.attachments.retained.images.some(ref => ref.attachmentId === image('a').attachmentId));
  assert.ok(result.attachments.retained.files.some(ref => ref.name === 'appended.txt'));
  assert.equal(result.snapshot.sessions[0].events.length, 2);
});

test('incomplete or corrupt later Zstandard frame blocks retained-reference proof', async t => {
  const f = await fixture(t);
  await f.session('target', [image('a')]);
  const retained = await f.session('retained', [], { compressed: true });
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  const header = zstdCompressSync(Buffer.from(`${JSON.stringify(retained.header)}\n`), options);
  const append = zstdCompressSync(Buffer.from(`${JSON.stringify({ attachment: image('a') })}\n`), options);
  const path = join(f.root, 'project', 'retained', 'session.v4.jsonl.zstd');
  await writeFile(path, Buffer.concat([header, append.subarray(0, append.length - 1)]));
  await assert.rejects(f.adapter.inspect(['target']), error => error.code === 'UNREADABLE_SESSION');
  const damaged = Buffer.from(append); damaged[damaged.length - 1] ^= 0xff;
  await writeFile(path, Buffer.concat([header, damaged]));
  await assert.rejects(f.adapter.inspect(['target']), error => error.code === 'UNREADABLE_SESSION');
  await writeFile(path, Buffer.concat([header, Buffer.from([0, 0, 0, 0, 0])]));
  await assert.rejects(f.adapter.inspect(['target']), error => error.code === 'UNREADABLE_SESSION');
});

test('unlisted physical session with corrupt header blocks shared-attachment planning', async t => {
  const f = await fixture(t);
  await f.session('healthy-target', [image('a')]);
  const omitted = join(f.root, 'project', 'not-in-persistence-list');
  await mkdir(omitted, { recursive: true });
  await writeFile(join(omitted, 'session.v4.jsonl'), `{broken-header\n${JSON.stringify({ attachment: image('a') })}\n`);
  assert.equal((await f.services.sessionPersistence.list()).length, 1);
  await assert.rejects(f.adapter.inspect(['healthy-target']), error => error.code === 'UNREADABLE_SESSION');
});

test('reference capture compares physical directories against every inventory row, not only requested IDs', async t => {
  const f = await fixture(t);
  await f.session('included', [image('a')]);
  await f.session('omitted-from-reference-subset', [image('b')]);
  const refs = await f.adapter.captureRefs(['included']);
  assert.deepEqual(refs.images.map(ref => ref.attachmentId), [image('a').attachmentId]);
  const unknown = join(f.root, 'another-project', 'unknown-session');
  await mkdir(unknown, { recursive: true });
  await writeFile(join(unknown, 'session.v3.jsonl.zstd'), Buffer.from('corrupt'));
  await assert.rejects(f.adapter.captureRefs(['included']), error => error.code === 'UNREADABLE_SESSION');
});
