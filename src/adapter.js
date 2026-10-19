import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const SUPPORTED_RUNTIME = '0.2.1-rc.2';
const LOG_NAME = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/;
const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/;
const unavailable = (message) => Object.assign(new Error(message), { code: 'RUNTIME_INCOMPATIBLE' });
const absent = (error) => error?.code === 'ENOENT';
const uniqueIds = (ids) => [...new Set(ids.map(String))];
const emptyRefs = () => ({ images: [], files: [] });
const refKey = (ref) => `${ref.attachmentId}\0${ref.name ?? ''}`;

/**
 * The pinned JSONL backend appends independent Zstandard frames. Node's one-shot decoder
 * consumes only the first frame, so walk the actual header/block lengths before decoding.
 * Like the runtime's scanZstdFrames, this rejects skippable/reserved frames; unlike runtime
 * crash recovery, deletion requires every byte and checksum of every retained frame.
 * Framing traversal adapted from DeepSeek Harness 0.2.1-rc.2,
 * @deepseek-ai/dsh-session-persistence-jsonl (src/zstd.ts), MIT license.
 * See THIRD_PARTY_NOTICES for the upstream copyright and permission notice.
 */
export function decompressSessionFrames(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length === 0) throw new Error('Empty Zstandard session log');
  const decoded = [];
  let offset = 0;
  const requireBytes = (count) => {
    if (buffer.length - offset < count) throw new Error(`Incomplete Zstandard frame at byte ${offset}`);
  };
  while (offset < buffer.length) {
    const start = offset;
    requireBytes(5);
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`Invalid Zstandard frame at byte ${offset}`);
    offset += 4;
    const descriptor = buffer[offset++];
    if ((descriptor & 0x18) !== 0) throw new Error(`Reserved Zstandard header at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    requireBytes(headerBytes);
    offset += headerBytes;
    for (;;) {
      requireBytes(3);
      const block = buffer.readUIntLE(offset, 3);
      offset += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error(`Reserved Zstandard block at byte ${offset - 3}`);
      const payloadBytes = type === 1 ? 1 : block >>> 3;
      requireBytes(payloadBytes);
      offset += payloadBytes;
      if ((block & 1) !== 0) break;
    }
    if (checksum) { requireBytes(4); offset += 4; }
    // The one-shot decoder now receives precisely one complete frame and validates its checksum.
    decoded.push(zstdDecompressSync(buffer.subarray(start, offset)));
  }
  return Buffer.concat(decoded);
}

export function mergeRefs(...groups) {
  const images = new Map();
  const files = new Map();
  for (const group of groups) {
    for (const ref of group?.images ?? []) images.set(ref.attachmentId, ref);
    for (const ref of group?.files ?? []) files.set(refKey(ref), ref);
  }
  return { images: [...images.values()], files: [...files.values()] };
}

/** Unknown positions pin both stores; future event shapes must never cause shared-byte deletion. */
export function refsIn(value, conservative = false) {
  const refs = emptyRefs();
  const seen = new WeakSet();
  function visit(item) {
    if (typeof item === 'string') {
      if (conservative && ATTACHMENT_ID.test(item)) {
        refs.images.push({ attachmentId: item });
      }
      return;
    }
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (typeof item.attachmentId === 'string' && ATTACHMENT_ID.test(item.attachmentId)) {
      const ref = { attachmentId: item.attachmentId };
      if (typeof item.name === 'string') ref.name = item.name;
      if (typeof item.width === 'number' || typeof item.height === 'number' || String(item.mediaType ?? '').startsWith('image/')) refs.images.push(ref);
      else if (typeof item.name === 'string') refs.files.push(ref);
      else if (conservative) refs.images.push(ref);
    }
    for (const [key, child] of Object.entries(item)) if (key !== 'attachmentId' || !ATTACHMENT_ID.test(String(child))) visit(child);
  }
  visit(value);
  return mergeRefs(refs);
}

function installedVersion() {
  const resources = process.resourcesPath ?? join(dirname(process.execPath), 'resources');
  try {
    return JSON.parse(readFileSync(join(resources, 'app.asar', 'dsh', 'package.json'), 'utf8')).version;
  } catch { return undefined; }
}

function inRoot(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function existingDirectory(root, path) {
  if (!inRoot(root, path)) throw unavailable('会话文件路径不在受支持的数据目录内。');
  let current = resolve(path);
  while (current !== resolve(root)) {
    let info;
    try { info = await lstat(current); } catch (error) { if (absent(error)) return false; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unavailable('会话目录包含链接或异常文件，已停止删除。');
    current = dirname(current);
  }
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  if (!inRoot(canonicalRoot, canonical)) throw unavailable('会话目录解析到了数据目录之外。');
  return true;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function getService(ctx, name) {
  try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]; } catch { return undefined; }
}

/** Narrow adapter for the installed desktop runtime; no direct registry detachment is permitted. */
export class RuntimeAdapter {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.version = options.version ?? installedVersion();
    this.options = options;
    this.paths = {};
    this.deleting = new Set();
    this.deleted = new Set();
    this.handles = new Map();
    this.restores = [];
    this.tracked = new Set();
    this.recentRefs = new Map();
    this.barrier = null;
    this.barrierTail = Promise.resolve();
    this.flow = new AsyncLocalStorage();
    this.reading = new Set();
    this.ready = false;
    this.reason = '';
    this.disposed = false;
  }

  status() {
    return { compatible: this.ready && !this.disposed, reason: this.reason || (this.disposed ? '删除插件已停止。' : this.ready ? '' : '删除插件尚未准备完成。'), version: this.version ?? 'unknown' };
  }

  requireReady() {
    if (!this.status().compatible) throw unavailable(this.status().reason);
  }

  blocked(id) { return this.deleting.has(String(id)) || this.deleted.has(String(id)); }

  rejectBlocked(id) {
    if (this.blocked(id)) throw Object.assign(new Error('该对话正在删除或已经删除，请刷新对话列表。'), { code: 'SESSION_DELETING' });
  }

  wrap(target, key, make) {
    if (!target) throw unavailable(`当前运行时缺少删除所需接口：${key}`);
    // Cordis 对方法每次读取都创建新的 Context 代理；描述符可保留原方法和精确恢复身份。
    const previousOwn = Object.getOwnPropertyDescriptor(target, key);
    let descriptor = previousOwn;
    for (let prototype = Object.getPrototypeOf(target); !descriptor && prototype; prototype = Object.getPrototypeOf(prototype)) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    }
    if (typeof descriptor?.value !== 'function') throw unavailable(`当前运行时缺少删除所需接口：${key}`);
    const wrapper = make(descriptor.value);
    Object.defineProperty(target, key, previousOwn ? { ...previousOwn, value: wrapper } : {
      value: wrapper, writable: true, configurable: true, enumerable: false,
    });
    this.restores.push(() => {
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper) return;
      if (previousOwn) Object.defineProperty(target, key, previousOwn);
      else Reflect.deleteProperty(target, key);
    });
  }

  /** Install before the desktop can open another Session, so each lifecycle disposer is retained. */
  async install() {
    if (this.ready) return this.status();
    try {
      if (this.version !== SUPPORTED_RUNTIME) throw unavailable(`仅支持 DeepSeek Harness ${SUPPORTED_RUNTIME}；当前版本为 ${this.version ?? '未知'}。`);
      for (const name of ['sessions', 'agents', 'agentLoop', 'sessionPersistence', 'sessionQuery', 'workspaceRegistry', 'storageDomain', 'sessionProjectionCache', 'attachments']) {
        this[name] = getService(this.ctx, name);
        if (!this[name]) throw unavailable(`当前运行时未提供 ${name}，已禁用删除。`);
      }
      const persistence = this.sessionPersistence;
      if (!persistence.tracker?.openHandles || !persistence.coldLogMemo || !persistence.migrationPreparations || typeof persistence.locate !== 'function') throw unavailable('当前会话存储实现与已验证版本不一致。');
      if (!this.sessionQuery._observations?.cache || typeof this.workspaceRegistry.enqueueOperation !== 'function' || typeof this.workspaceRegistry.setState !== 'function' || !this.sessionProjectionCache.table) throw unavailable('当前缓存或工作区实现与已验证版本不一致。');
      if (!this.attachments.requestInflight || typeof this.attachments.requestVersion !== 'function') throw unavailable('当前附件存储实现与已验证版本不一致。');
      const sessionsRoot = resolve(persistence.root ?? persistence.config?.root ?? '');
      if (!persistence.root && !persistence.config?.root) throw unavailable('无法确认会话数据目录。');
      const dshHome = resolve(this.options.dshHome ?? dirname(sessionsRoot));
      this.paths = {
        sessionsRoot,
        attachmentRoot: resolve(this.attachments.root),
        requestCacheRoot: resolve(this.attachments.cacheRoot),
        stateRoot: join(dshHome, 'local-session-delete'),
        storageRoot: join(dshHome, 'storages'),
        uploadIndexPath: join(dshHome, 'llm-deepseek', 'files-v3.json'),
        spillRoot: getService(this.ctx, 'spill')?.root,
      };
      const adapter = this;
      this.wrap(this.agentLoop, 'prepare', (original) => function (...args) {
        adapter.rejectBlocked(args[1]);
        if (args[6]) adapter.rejectBlocked(args[6].id);
        const prepared = Reflect.apply(original, this, args);
        if (!prepared?.agent || typeof prepared.dispose !== 'function') throw unavailable('无法取得完整的对话关闭句柄。');
        adapter.captureAgent(prepared.agent, prepared.dispose);
        return prepared;
      });
      for (const key of ['create', 'resume']) this.wrap(this.agents, key, (original) => function (options, ...args) {
        adapter.rejectBlocked(options?.sessionId ?? options?.resumeSessionId);
        if (key === 'create' && options?.meta?.parentSession) adapter.rejectBlocked(options.meta.parentSession);
        return Reflect.apply(original, this, [options, ...args]);
      });
      for (const key of ['create', 'open']) this.wrap(persistence, key, (original) => function (input, ...args) {
        adapter.rejectBlocked(typeof input === 'object' ? input.id : input);
        if (key === 'create' && input?.parentSession) adapter.rejectBlocked(input.parentSession);
        return Reflect.apply(original, this, [input, ...args]);
      });
      this.wrap(this.sessionProjectionCache, 'put', (original) => function (id, ...args) {
        if (adapter.blocked(id)) return Promise.resolve();
        return Reflect.apply(original, this, [id, ...args]);
      });
      // New/cold reads cannot pin a preparation or republish a checkpoint after the final purge.
      for (const key of ['observeSession', 'readSession']) this.wrap(this.sessionQuery, key, (original) => function (id, ...args) {
        adapter.rejectBlocked(id);
        return adapter.trackRead(() => Reflect.apply(original, this, [id, ...args]));
      });
      this.installAttachmentTracking();
      const schedule = getService(this.ctx, 'schedule');
      if (schedule) {
        this.wrap(schedule, 'create', (original) => function (id, ...args) {
          adapter.rejectBlocked(id);
          return adapter.attachmentOperation(() => Reflect.apply(original, this, [id, ...args]), id);
        });
        this.wrap(schedule, 'update', (original) => function (request, ...args) {
          adapter.rejectBlocked(request.sessionId);
          return adapter.attachmentOperation(() => Reflect.apply(original, this, [request, ...args]), request.sessionId);
        });
      }
      this.ready = true;
      return this.status();
    } catch (error) {
      this.reason = error.message;
      for (const restore of this.restores.splice(0).reverse()) restore();
      return this.status();
    }
  }

  captureAgent(agent, dispose) {
    this.handles.set(agent.id, { agent, dispose });
    const adapter = this;
    this.wrap(agent, 'send', (original) => function (...args) {
      adapter.rejectBlocked(agent.id);
      return Reflect.apply(original, this, args);
    });
  }

  trackRead(operation) {
    const task = Promise.resolve().then(operation);
    this.reading.add(task);
    task.finally(() => this.reading.delete(task)).catch(() => {});
    return task;
  }

  installAttachmentTracking() {
    const adapter = this;
    for (const key of ['saveImage', 'saveImages', 'saveFile', 'saveFileStream']) this.wrap(this.attachments, key, (original) => function (...args) {
      return adapter.attachmentOperation(async () => {
        const result = await Reflect.apply(original, this, args);
        // Retain newly admitted refs until an owner has durably recorded them. Unknown ownership pins safely.
        adapter.recentRefs.set(result, { owner: adapter.flow.getStore()?.owner, refs: refsIn(result) });
        return result;
      });
    });
    this.wrap(this.attachments, 'requestVersion', (original) => function (...args) {
      return adapter.attachmentOperation(() => Reflect.apply(original, this, args));
    });
    const uploads = getService(this.ctx, 'fileUploads');
    if (uploads) this.wrap(uploads, 'commit', (original) => function (agent, ...args) {
      adapter.rejectBlocked(agent.id);
      return adapter.attachmentOperation(() => Reflect.apply(original, this, [agent, ...args]), agent.id);
    });
    const commands = getService(this.ctx, 'sessionController')?.commands;
    if (commands) this.wrap(commands, 'prompt', (original) => function (request, ...args) {
      adapter.rejectBlocked(request.sessionId);
      return adapter.attachmentOperation(() => Reflect.apply(original, this, [request, ...args]), request.sessionId);
    });
  }

  async attachmentOperation(operation, owner) {
    // Already admitted operations may perform nested saves while the exclusive barrier drains them.
    const inherited = this.flow.getStore();
    if (this.barrier && !inherited?.admitted) await this.barrier.promise;
    const task = this.flow.run({ admitted: true, owner: owner ?? inherited?.owner }, () => Promise.resolve().then(operation));
    this.tracked.add(task);
    try { return await task; } finally { this.tracked.delete(task); }
  }

  async inventory() {
    this.requireReady();
    const persisted = await this.sessionPersistence.list();
    const map = new Map(persisted.map((entry) => [String(entry.header.id), { header: entry.header, revision: String(entry.revision), materialized: entry.sizeBytes !== undefined }]));
    for (const session of this.sessions.list()) {
      const prior = map.get(String(session.id));
      map.set(String(session.id), { ...prior, header: session.header, revision: `${prior?.revision ?? 'memory'}:${session.seq}`, materialized: prior?.materialized ?? false });
    }
    const registry = this.workspaceRegistry;
    const workspaces = registry.list();
    const schedule = getService(this.ctx, 'schedule');
    const scheduled = schedule ? await schedule.catalog() : [];
    const result = [];
    for (const [id, item] of map) {
      if (this.deleted.has(id)) continue;
      const live = this.sessions.get(id);
      const agent = this.agents.get(id);
      let projection;
      try {
        projection = live ? getService(this.ctx, 'sessionProjections')?.cachedSnapshot(live) : this.sessionProjectionCache.cachedSnapshot(item.header) ?? this.sessionProjectionCache.cachedPredecessorTitle(item.header);
      } catch { /* A cache miss does not activate a Session. */ }
      const values = projection?.values ?? {};
      const title = typeof values.title === 'string' ? values.title : values.title?.title;
      const busyReasons = [];
      if (agent?.status === 'running' || (agent?.phase && agent.phase.kind !== 'idle')) busyReasons.push('对话正在运行');
      if (agent?.inbox?.hasPending) busyReasons.push('存在待处理消息');
      if (agent && this.handles.get(id)?.agent !== agent) busyReasons.push('请重启 DeepSeek Harness 后再删除此对话');
      if (live && !agent) busyReasons.push('对话由其他运行组件持有');
      if (scheduled.some((task) => task.sessionId === id && task.status === 'active')) busyReasons.push('存在启用中的定时任务');
      const activity = typeof this.ctx.waterfall === 'function' ? await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])) : [];
      for (const entry of activity ?? []) busyReasons.push(entry.kind === 'schedule' ? '存在启用中的定时任务' : `存在运行活动：${entry.kind ?? '未知'}`);
      const workspace = workspaces.find((entry) => entry.record?.sessionIds?.includes(id) || entry.sessionIds.includes(id));
      result.push({ id, title: title || '未命名对话', createdAt: item.header.createdAt, updatedAt: Math.max(item.header.createdAt, values.sessionListMetadata?.lastPromptAt ?? 0), origin: item.header.origin, parentSession: item.header.parentSession, cwd: item.header.cwd, archived: registry.archivedSessionIds.includes(id), pinned: registry.pinnedSessionIds.includes(id), workspace: workspace?.title ?? '', busyReasons: [...new Set(busyReasons)], revision: item.revision, materialized: item.materialized });
    }
    return result.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  async rawSession(row) {
    const live = this.sessions.get(row.id);
    const stored = await this.sessionPersistence.stat(row.id);
    const header = live?.header ?? stored?.header;
    if (!header) throw Object.assign(new Error('对话已不存在，请刷新列表。'), { code: 'STALE_PREVIEW' });
    const location = this.sessionPersistence.locate(header);
    if (location?.kind !== 'jsonl' || !isAbsolute(location.path)) throw unavailable('只支持本机 JSONL 会话存储。');
    const directory = dirname(location.path);
    const exists = await existingDirectory(this.paths.sessionsRoot, directory);
    const generations = [];
    let refs = emptyRefs();
    let retainingRefs = emptyRefs();
    let events = live?.snapshotEvents() ?? [];
    if (exists) {
      const names = (await readdir(directory)).filter((name) => LOG_NAME.test(name)).sort();
      for (const name of names) {
        const path = join(directory, name);
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink()) throw unavailable('会话日志包含链接或异常文件。');
        const bytes = await readFile(path);
        let text;
        try { text = (name.endsWith('.zstd') ? decompressSessionFrames(bytes) : bytes).toString('utf8'); }
        catch { throw Object.assign(new Error('存在无法完整读取的历史会话日志，已停止删除以保护共享附件。'), { code: 'UNREADABLE_SESSION' }); }
        const after = await lstat(path);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Object.assign(new Error('会话记录发生变化，请重新预览。'), { code: 'STALE_PREVIEW' });
        let records;
        try { records = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)); }
        catch { throw Object.assign(new Error('存在损坏或尚未写完的会话日志，已停止删除。'), { code: 'UNREADABLE_SESSION' }); }
        if (!records[0] || records[0].id !== row.id || records[0].type !== 'session') throw unavailable('会话目录与日志身份不一致，已停止删除。');
        refs = mergeRefs(refs, refsIn(records));
        retainingRefs = mergeRefs(retainingRefs, refsIn(records, true));
        if (!live) events = records.slice(1);
        generations.push({ path, revision: `${before.size}:${before.mtimeMs}:${createHash('sha256').update(bytes).digest('hex')}`, sizeBytes: before.size });
      }
    }
    const staged = getService(this.ctx, 'fileUploads')?.stagedFiles?.get(live);
    const stagedRefs = staged ? refsIn([...staged.values()]) : emptyRefs();
    refs = mergeRefs(refs, refsIn(events), stagedRefs);
    retainingRefs = await this.expandRetainedAliases(mergeRefs(retainingRefs, refsIn(events, true), stagedRefs));
    return { ...row, header: structuredClone(header), events, refs, retainingRefs, generations, directory, materialized: generations.length > 0 };
  }

  async expandRetainedAliases(refs) {
    const files = [...refs.files];
    for (const ref of refs.images) {
      const hash = ref.attachmentId.slice(7);
      const path = join(this.paths.attachmentRoot, 'files', hash.slice(0, 2), hash);
      try {
        if (!await existingDirectory(this.paths.attachmentRoot, path)) continue;
        for (const name of await readdir(path)) {
          const info = await lstat(join(path, name));
          if (!info.isFile() || info.isSymbolicLink()) throw unavailable('共享附件目录包含异常文件。');
          files.push({ attachmentId: ref.attachmentId, name });
        }
      } catch (error) { if (!absent(error)) throw error; }
    }
    return mergeRefs(refs, { files });
  }

  /** A listing may omit broken headers; missing physical Sessions invalidate shared-reference proof. */
  async assertCorpusComplete(directories) {
    const identity = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    const known = new Set([...directories].map(identity));
    const refuse = () => Object.assign(new Error('存在未被会话列表识别的日志或异常目录，无法证明附件未被共享，已停止删除。'), { code: 'UNREADABLE_SESSION' });
    let rootInfo;
    try { rootInfo = await lstat(this.paths.sessionsRoot); }
    catch (error) { if (absent(error)) return; throw error; }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw refuse();
    for (const project of await readdir(this.paths.sessionsRoot, { withFileTypes: true })) {
      if (project.isSymbolicLink()) throw refuse();
      if (!project.isDirectory()) continue;
      const projectPath = join(this.paths.sessionsRoot, project.name);
      for (const session of await readdir(projectPath, { withFileTypes: true })) {
        if (session.isSymbolicLink()) throw refuse();
        if (!session.isDirectory()) continue;
        const directory = join(projectPath, session.name);
        const entries = await readdir(directory, { withFileTypes: true });
        const generations = entries.filter(entry => LOG_NAME.test(entry.name));
        if (generations.some(entry => entry.isSymbolicLink() || !entry.isFile())) throw refuse();
        if (generations.length > 0 && !known.has(identity(directory))) throw refuse();
      }
    }
  }

  async inspect(ids) {
    this.requireReady();
    const wanted = new Set(uniqueIds(ids));
    const inventory = await this.inventory();
    if ([...wanted].some((id) => !inventory.some((row) => row.id === id))) throw Object.assign(new Error('对话列表已变化，请重新预览。'), { code: 'STALE_PREVIEW' });
    const sessions = [];
    const directories = new Set();
    let candidates = emptyRefs();
    let retained = emptyRefs();
    for (const row of inventory) {
      const raw = await this.rawSession(row);
      directories.add(raw.directory);
      if (wanted.has(row.id)) { sessions.push(raw); candidates = mergeRefs(candidates, raw.refs); }
      else retained = mergeRefs(retained, raw.retainingRefs);
    }
    await this.assertCorpusComplete(directories);
    // Pins of newly admitted, not-yet-enqueued content are deliberately conservative.
    for (const pin of this.recentRefs.values()) {
      if (pin.owner && wanted.has(pin.owner)) candidates = mergeRefs(candidates, pin.refs);
      else retained = mergeRefs(retained, pin.refs);
    }
    const snapshot = { sessions, inventory, revision: fingerprint({ inventory, targets: sessions.map(({ id, generations }) => ({ id, generations })) }) };
    return { snapshot, attachments: { candidates, retained, attachmentRoot: this.paths.attachmentRoot, requestCacheRoot: this.paths.requestCacheRoot, uploadIndexPath: this.paths.uploadIndexPath }, paths: sessions.map(({ id, directory, generations, materialized }) => ({ id, directory, logPaths: generations.map((generation) => generation.path), materialized })) };
  }

  async captureRefs(ids) {
    const wanted = ids === undefined ? undefined : new Set(uniqueIds(ids));
    let result = emptyRefs();
    const directories = new Set();
    // Compare the complete listed corpus even if the caller collects a subset of its references.
    for (const row of await this.inventory()) {
      const raw = await this.rawSession(row);
      directories.add(raw.directory);
      if (!wanted || wanted.has(row.id)) result = mergeRefs(result, raw.retainingRefs);
    }
    await this.assertCorpusComplete(directories);
    for (const pin of this.recentRefs.values()) if (!pin.owner || !wanted || wanted.has(pin.owner)) result = mergeRefs(result, pin.refs);
    return result;
  }

  beginDelete(ids) {
    this.requireReady();
    const selected = uniqueIds(ids);
    for (const id of selected) this.rejectBlocked(id);
    for (const id of selected) this.deleting.add(id);
    return () => { for (const id of selected) this.deleting.delete(id); };
  }

  async closeTargets(ids) {
    this.requireReady();
    const selected = uniqueIds(ids);
    for (const id of selected) if (!this.deleting.has(id)) throw unavailable('删除保护尚未启用。');
    const exactAgents = selected.map((id) => this.agents.get(id)).filter(Boolean);
    for (const agent of exactAgents) {
      if (this.handles.get(agent.id)?.agent !== agent) throw unavailable('未捕获此对话的关闭句柄，请重启 DeepSeek Harness 后重试。');
      if (agent.status === 'running' || (agent.phase && agent.phase.kind !== 'idle') || agent.inbox?.hasPending) throw Object.assign(new Error('对话存在正在运行或待处理的任务。'), { code: 'SESSION_BUSY' });
    }
    const subagents = getService(this.ctx, 'subagents');
    if (subagents?.drainDescendants) await subagents.drainDescendants(exactAgents);
    for (const agent of exactAgents.reverse()) await this.handles.get(agent.id).dispose();
    await Promise.allSettled([...this.reading]);
    for (const id of selected) {
      if (this.sessions.get(id) || this.agents.get(id)) throw unavailable('对话尚未完全关闭，已停止删除。');
      const remaining = [...this.sessionPersistence.tracker.openHandles].filter((handle) => handle.id === id);
      await Promise.all(remaining.map((handle) => handle.close()));
      if ([...this.sessionPersistence.tracker.openHandles].some((handle) => handle.id === id)) throw unavailable('会话存储句柄尚未释放。');
    }
  }

  async withAttachmentBarrier(operation) {
    this.requireReady();
    const prior = this.barrierTail;
    let unlock;
    this.barrierTail = new Promise((resolve) => { unlock = resolve; });
    await prior;
    let release;
    this.barrier = { promise: new Promise((resolve) => { release = resolve; }) };
    try {
      while (this.tracked.size) await Promise.allSettled([...this.tracked]);
      await Promise.allSettled([...this.attachments.requestInflight.values()].map((entry) => entry.promise));
      return await operation();
    } finally {
      this.barrier = null;
      release();
      unlock();
    }
  }

  async removeMetadata(ids) {
    this.requireReady();
    const selected = uniqueIds(ids);
    const registry = this.workspaceRegistry;
    await registry.enqueueOperation(async () => {
      const wanted = new Set(selected);
      for (const workspace of registry.list()) {
        const row = registry.table.get(workspace.id);
        if (row.sessionIds.some((id) => wanted.has(id))) {
          const next = { ...row, sessionIds: row.sessionIds.filter((id) => !wanted.has(id)) };
          await registry.table.update(workspace.id, () => next);
          workspace.record = next;
        }
      }
      const state = registry.requireState();
      await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((id) => !wanted.has(id)), pinnedSessionIds: state.pinnedSessionIds.filter((id) => !wanted.has(id)) });
      for (const id of selected) for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) registry[key]?.delete(id);
    });
    const table = this.sessionProjectionCache.table;
    for (const id of selected) {
      await table.delete(id);
      this.sessionQuery._observations.cache.delete(id);
      this.sessionPersistence.coldLogMemo.delete(id);
      const preparation = this.sessionPersistence.migrationPreparations.get(id);
      preparation?.controller?.abort();
      this.sessionPersistence.migrationPreparations.delete(id);
      this.handles.delete(id);
    }
    await this.scrubLegacyProjection(selected);
    await this.scrubProjectionBackups(selected);
    const schedule = getService(this.ctx, 'schedule');
    if (schedule) {
      if (typeof schedule.serialize !== 'function' || typeof schedule.getDomain !== 'function') throw unavailable('无法安全清理对话的定时任务记录。');
      await schedule.serialize(async () => {
        const tasks = (await schedule.getDomain()).table('tasks');
        for (const [id, task] of tasks.entries()) if (selected.includes(task.sessionId)) await tasks.delete(id);
        schedule.emitChanged();
        schedule.runtime?.requestDrive();
      });
    }
    const query = this.sessionQuery;
    if (query._db) {
      if (typeof query._serialized !== 'function' || typeof query._reconcile !== 'function') throw unavailable('无法安全清理全文索引。');
      await query._serialized(undefined, async () => {
        await query._reconcile(undefined);
        query._db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        query._db.exec('VACUUM');
      });
    }
  }

  async scrubLegacyProjection(ids) {
    const path = join(this.paths.storageRoot, 'session_projcache.json');
    let data;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw unavailable('旧版投影缓存文件异常。');
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) { if (absent(error)) return; throw error; }
    if (data.unit?.name !== 'session_projcache' || !data.tables?.sessions || Array.isArray(data.tables.sessions)) throw unavailable('无法识别旧版投影缓存，已停止清理。');
    let changed = false;
    for (const id of ids) if (Object.hasOwn(data.tables.sessions, id)) { delete data.tables.sessions[id]; changed = true; }
    if (changed) {
      const temp = `${path}.delete-${process.pid}.tmp`;
      try { await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
      finally { await rm(temp, { force: true }); }
    }
  }

  async scrubProjectionBackups(ids) {
    const path = join(this.paths.storageRoot, 'session_projcache', 'sessions');
    let files;
    try { files = await readdir(path); } catch (error) { if (absent(error)) return; throw error; }
    for (const id of ids) {
      if (id === '.' || id === '..' || /[\\/\0]/.test(id)) throw unavailable('会话 ID 不能安全用于缓存清理。');
      for (const name of files) if (name.startsWith(`${id}.json.bak.`) && /^\d{12}$/.test(name.slice(`${id}.json.bak.`.length))) {
        const file = join(path, name);
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw unavailable('投影备份包含异常文件。');
        await rm(file);
      }
    }
  }

  async removeUploadMappings(exclusiveRefs) {
    const wanted = new Set((exclusiveRefs.images ?? []).map((ref) => ref.attachmentId));
    if (wanted.size === 0) return;
    let info;
    try { info = await lstat(this.paths.uploadIndexPath); } catch (error) { if (absent(error)) return; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw unavailable('本地上传索引文件异常。');
    const module = this.options.uploadIndexFactory ? null : await import('@deepseek-ai/dsh-llm-deepseek');
    const index = this.options.uploadIndexFactory?.(this.paths.uploadIndexPath) ?? new module.DeepSeekUploadIndex(this.paths.uploadIndexPath);
    const groups = new Map();
    for (const row of (await index.load()).records) if (wanted.has(row.attachmentId)) {
      const group = groups.get(row.scope) ?? [];
      group.push({ variantId: row.variantId, fileId: row.fileId });
      groups.set(row.scope, group);
    }
    for (const [scope, rows] of groups) await index.remove(scope, rows);
  }

  emitRemoved(ids) {
    for (const id of uniqueIds(ids)) {
      this.deleted.add(id);
      this.ctx.emit('api-session/removed', id);
    }
  }

  async dispose() {
    this.disposed = true;
    for (const restore of this.restores.splice(0).reverse()) restore();
    if (this.barrier) throw unavailable('附件清理仍在运行，不能停用插件。');
    this.handles.clear();
    this.recentRefs.clear();
  }
}

export default RuntimeAdapter;
