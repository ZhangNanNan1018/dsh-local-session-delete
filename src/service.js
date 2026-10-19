import { createHash, randomUUID } from 'node:crypto';
import { SafeDeletionFiles } from './files.js';

export class DeleteError extends Error {
  constructor(code, message, details) { super(message); this.name = 'DeleteError'; this.code = code; this.details = details; }
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicRow = row => ({
  id: row.id, title: row.title || '未命名对话', workspace: row.workspace || '',
  archived: Boolean(row.archived), busyReasons: [...(row.busyReasons || [])],
  updatedAt: Number(row.updatedAt || row.createdAt || 0), subagentCount: row.subagentCount || 0,
});

/** One confirmed root and its owned descendants form a single deletion operation. */
export function ownedFamily(inventory, rootId) {
  const byId = new Map(inventory.map(row => [row.id, row]));
  if (!byId.has(rootId)) throw new DeleteError('NOT_FOUND', '该对话已不存在，请刷新列表。');
  const ids = new Set([rootId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of inventory) {
      if (row.origin === 'subagent' && ids.has(row.parentSession) && !ids.has(row.id)) {
        ids.add(row.id); changed = true;
      }
    }
  }
  return [rootId, ...[...ids].filter(id => id !== rootId).sort()];
}

/** No dialogue bodies enter preview tokens or durable operation journals. */
function fingerprint(inspected, ids) {
  return hash({
    ids,
    inventory: inspected.snapshot.inventory.map(row => ({
      id: row.id, origin: row.origin, parentSession: row.parentSession,
      revision: row.revision, busyReasons: row.busyReasons,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    generations: inspected.snapshot.sessions.map(row => ({
      id: row.id, generations: row.generations, revision: row.revision,
      // Hash live events too: an unflushed send must invalidate the preview.
      live: hash(row.events || []),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    candidates: inspected.attachments.candidates,
    retained: inspected.attachments.retained,
  });
}

export class DeletionService {
  constructor(adapter, { files } = {}) {
    this.adapter = adapter;
    this.files = files;
    this.tokens = new Map();
    this.pending = new Map();
    this.guards = new Map();
    this.tail = Promise.resolve();
    this.recoveryError = null;
  }

  async initialize() {
    if (!this.adapter.status().compatible) return;
    this.files ??= new SafeDeletionFiles(this.adapter.paths);
    const operations = await this.files.listPending();
    for (const operation of operations) {
      this.pending.set(operation.id, operation);
      try { await this._execute(operation); }
      catch (error) { this.recoveryError = error.message; }
    }
  }

  _assertCompatible() {
    const status = this.adapter.status();
    if (!status.compatible) throw new DeleteError('UNSUPPORTED', status.reason || '当前版本暂不支持安全删除。');
  }

  async list() {
    const status = this.adapter.status();
    if (!status.compatible) return { compatible: false, reason: status.reason || '', sessions: [] };
    const inventory = await this.adapter.inventory();
    const rows = inventory.filter(row => row.origin !== 'subagent').map(row => {
      const family = ownedFamily(inventory, row.id);
      return publicRow({ ...row, subagentCount: family.length - 1 });
    });
    for (const op of this.pending.values()) {
      const existing = rows.find(row => row.id === op.sessionIds[0]);
      if (existing) { existing.title += '（删除未完成，可重试）'; existing.busyReasons = []; }
      else rows.push(publicRow({ id: op.sessionIds[0], title: '删除未完成，可重试', updatedAt: op.createdAt,
        subagentCount: op.sessionIds.length - 1 }));
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return { compatible: true, reason: this.recoveryError || '', sessions: rows };
  }

  async preview({ sessionId }) {
    this._assertCompatible();
    const pending = [...this.pending.values()].find(op => op.sessionIds[0] === sessionId);
    if (pending) {
      const previewToken = randomUUID();
      this.tokens.set(previewToken, { sessionId, operationId: pending.id });
      return { sessionId, previewToken, sessionCount: pending.sessionIds.length,
        attachmentCount: pending.attachments.images.length + pending.attachments.files.length,
        busyReasons: [], sessions: pending.sessionIds.map(id => ({ id, title: id })) };
    }
    return this.adapter.withAttachmentBarrier(async () => {
      const inventory = await this.adapter.inventory();
      const ids = ownedFamily(inventory, sessionId);
      const busyReasons = ids.flatMap(id => (inventory.find(row => row.id === id)?.busyReasons || [])
        .map(reason => `${inventory.find(row => row.id === id)?.title || id}：${reason}`));
      if (busyReasons.length) return { sessionId, previewToken: '', sessionCount: ids.length,
        attachmentCount: 0, busyReasons, sessions: ids.map(id => ({ id, title: inventory.find(row => row.id === id)?.title || id })) };
      const inspected = await this.adapter.inspect(ids);
      for (const item of inspected.paths) if (item.directory) await this.files.validateSessionDirectory(item.directory);
      const attachments = this.files.planAttachments(inspected.attachments.candidates, inspected.attachments.retained);
      await this.files.validateDeletion(inspected.paths, attachments);
      const previewToken = randomUUID();
      this.tokens.set(previewToken, { sessionId, ids, fingerprint: fingerprint(inspected, ids) });
      return { sessionId, previewToken, sessionCount: ids.length,
        attachmentCount: attachments.images.length + attachments.files.length,
        busyReasons: [], sessions: ids.map(id => ({ id, title: inventory.find(row => row.id === id)?.title || id })) };
    });
  }

  remove(request) {
    const task = this.tail.then(() => this._remove(request));
    this.tail = task.catch(() => {});
    return task;
  }

  async _remove({ sessionId, previewToken }) {
    this._assertCompatible();
    const preview = this.tokens.get(previewToken);
    this.tokens.delete(previewToken);
    if (!preview || preview.sessionId !== sessionId) throw new DeleteError('PREVIEW_REQUIRED', '请重新预览并确认删除范围。');
    if (preview.operationId) {
      const operation = this.pending.get(preview.operationId);
      if (!operation) throw new DeleteError('NOT_FOUND', '该清理已完成，请刷新列表。');
      return this._execute(operation);
    }
    const release = this.adapter.beginDelete(preview.ids);
    let journaled = false;
    try {
      return await this.adapter.withAttachmentBarrier(async () => {
        const inventory = await this.adapter.inventory();
        const ids = ownedFamily(inventory, sessionId);
        if (ids.some(id => inventory.find(row => row.id === id)?.busyReasons?.length))
          throw new DeleteError('BUSY', '对话状态发生变化，请先停止运行或处理待办后重新预览。');
        const inspected = await this.adapter.inspect(ids);
        if (fingerprint(inspected, ids) !== preview.fingerprint)
          throw new DeleteError('STALE_PREVIEW', '对话或附件引用已变化，请重新预览。');
        const operation = {
          id: randomUUID(), createdAt: Date.now(), phase: 'prepared', sessionIds: ids,
          paths: inspected.paths.map(({ id, directory, materialized }) => ({ id, directory, materialized })),
          attachments: this.files.planAttachments(inspected.attachments.candidates, inspected.attachments.retained),
        };
        await this.files.validateDeletion(operation.paths, operation.attachments);
        await this.files.writeJournal(operation);
        this.pending.set(operation.id, operation);
        this.guards.set(operation.id, release);
        journaled = true;
        return this._executeInsideBarrier(operation);
      });
    } finally { if (!journaled) release(); }
  }

  async _execute(operation) {
    this._assertCompatible();
    if (!this.guards.has(operation.id)) this.guards.set(operation.id, this.adapter.beginDelete(operation.sessionIds));
    return this.adapter.withAttachmentBarrier(() => this._executeInsideBarrier(operation));
  }

  async _phase(operation, phase) {
    const phases = ['prepared', 'closed', 'logs', 'metadata', 'attachments'];
    if (phases.indexOf(phase) > phases.indexOf(operation.phase)) {
      await this.files.updateJournal(operation.id, { phase });
      operation.phase = phase;
    }
  }

  async _executeInsideBarrier(operation) {
    try {
      await this.adapter.closeTargets(operation.sessionIds);
      await this._phase(operation, 'closed');
      await this.files.deleteSessions(operation.paths);
      await this._phase(operation, 'logs');
      // Remove cold list rows before archive metadata changes can reveal a stale row.
      await this.adapter.emitRemoved(operation.sessionIds);
      await this.adapter.removeMetadata(operation.sessionIds);
      await this._phase(operation, 'metadata');
      // A restart may have gained new shared references since the journal was written.
      const inventory = await this.adapter.inventory();
      const retainedIds = inventory.map(row => row.id).filter(id => !operation.sessionIds.includes(id));
      const retained = await this.adapter.captureRefs(retainedIds);
      const attachments = this.files.planAttachments(operation.attachments, retained);
      await this.files.deleteAttachments(attachments);
      await this.adapter.removeUploadMappings(attachments);
      if (attachments.images.length) await this.files.clearRequestCache();
      await this._phase(operation, 'attachments');
      await this.files.removeJournal(operation.id);
      this.pending.delete(operation.id);
      this.recoveryError = null;
      this.guards.get(operation.id)?.();
      this.guards.delete(operation.id);
      return { complete: true, deletedIds: operation.sessionIds,
        attachmentCount: attachments.images.length + attachments.files.length };
    } catch (error) {
      this.recoveryError = `清理未完成：${error.message}`;
      throw new DeleteError('CLEANUP_INCOMPLETE', `${this.recoveryError}。请在对话管理中重新预览并重试；重启后也会继续清理。`,
        { operationId: operation.id, phase: operation.phase });
    }
  }
}
