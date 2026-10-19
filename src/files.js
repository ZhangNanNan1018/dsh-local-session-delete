import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DIGEST = /^sha256:([a-f0-9]{64})$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const OP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const PHASES = ['prepared', 'closed', 'logs', 'metadata', 'attachments'];
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);

function fail(message, code = 'UNSAFE_DELETE_PATH') {
  return Object.assign(new Error(message), { code });
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')
      || value.split(/[\\/]/).includes('..')) throw fail('删除路径必须是无回溯段的绝对路径。');
  return path.resolve(value);
}

function within(root, target, depth) {
  const relative = path.relative(root, absolute(target));
  const segments = relative.split(path.sep).filter(Boolean);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..'
      || path.isAbsolute(relative) || segments.some(part => part.includes(':'))
      || (depth !== undefined && segments.length !== depth)) {
    throw fail('删除路径不属于预期的数据目录。');
  }
  return path.resolve(target);
}

/** Check each ancestor rather than trusting realpath, which follows junctions. */
async function inspectPath(target, { directory, allowMissing = true } = {}) {
  target = absolute(target);
  const root = path.parse(target).root;
  const segments = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  let stat;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index]);
    try { stat = await fs.lstat(current); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw fail('数据路径包含符号链接或目录联接，已停止删除。');
    if (index < segments.length - 1 && !stat.isDirectory()) throw fail('数据路径的父级不是普通目录。');
    if (!samePath(await fs.realpath(current), current)) throw fail('数据路径解析结果与预期不一致。');
  }
  if (directory === true && !stat.isDirectory()) throw fail('预期的数据目录实际不是目录。');
  if (directory === false && !stat.isFile()) throw fail('预期的附件实际不是普通文件。');
  return stat;
}

async function inspectTree(directory) {
  if (!await inspectPath(directory, { directory: true })) return false;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw fail('待删除目录内包含符号链接或目录联接。');
    if (stat.isDirectory()) await inspectTree(child);
    else if (!stat.isFile()) throw fail('待删除目录内包含非普通文件。');
  }
  return true;
}

function imageRef(ref) {
  const match = DIGEST.exec(ref?.attachmentId);
  if (!match) throw fail('图片附件引用无效。', 'INVALID_ATTACHMENT_REF');
  return { attachmentId: `sha256:${match[1]}` };
}

function fileRef(ref) {
  const normalized = imageRef(ref);
  const name = ref?.name;
  if (typeof name !== 'string' || !name || name !== name.trim() || name === '.' || name === '..'
      || /[\\/<>:"|?*\u0000-\u001f\u007f]/u.test(name) || /[. ]$/u.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(name.split('.')[0].replace(/[. ]+$/u, ''))
      || Buffer.byteLength(name) > 255) throw fail('文件附件名不是安全的存储文件名。', 'INVALID_ATTACHMENT_REF');
  return { ...normalized, name };
}

function refs(value = {}) {
  if (!Array.isArray(value.images ?? []) || !Array.isArray(value.files ?? [])) {
    throw fail('附件引用集合无效。', 'INVALID_ATTACHMENT_REF');
  }
  const images = new Map((value.images ?? []).map(ref => {
    const normalized = imageRef(ref);
    return [normalized.attachmentId, normalized];
  }));
  const files = new Map((value.files ?? []).map(ref => {
    const normalized = fileRef(ref);
    // NTFS aliases differing only in case can address the same directory entry.
    // Ordinal uppercase also covers one-character pairs such as I / dotless i.
    const leafKey = process.platform === 'win32' ? normalized.name.toUpperCase() : normalized.name;
    return [`${normalized.attachmentId}\0${leafKey}`, normalized];
  }));
  return { images, files };
}

/** File aliases are independent; the canonical object is shared by digest. */
export function exclusiveRefs(candidates, retained) {
  const candidate = refs(candidates);
  const keep = refs(retained);
  return {
    images: [...candidate.images].filter(([key]) => !keep.images.has(key)).map(([, ref]) => ref),
    files: [...candidate.files].filter(([key]) => !keep.files.has(key)).map(([, ref]) => ref),
  };
}

function cleanPlan(plan) {
  const clean = exclusiveRefs(plan, {});
  if (!Array.isArray(plan.retainedFileDigests ?? [])
      || (plan.retainedFileDigests ?? []).some(hash => !HEX_DIGEST.test(hash))) {
    throw fail('保留文件摘要集合无效。', 'INVALID_ATTACHMENT_REF');
  }
  return { ...clean, retainedFileDigests: [...new Set(plan.retainedFileDigests ?? [])].sort() };
}

function cleanJournal(value) {
  if (!OP_ID.test(value?.id) || !PHASES.includes(value?.phase)
      || !Array.isArray(value?.sessionIds) || !Array.isArray(value?.paths)
      || !value.sessionIds.length || value.sessionIds.some(id => typeof id !== 'string' || !id || id.length > 512)
      || !Number.isFinite(value.createdAt)) throw fail('删除恢复记录格式无效。', 'INVALID_DELETE_JOURNAL');
  const sessionIds = [...new Set(value.sessionIds)];
  const paths = value.paths.map(item => {
    if (!sessionIds.includes(item?.id) || typeof item.materialized !== 'boolean') {
      throw fail('删除恢复记录中的对话路径无效。', 'INVALID_DELETE_JOURNAL');
    }
    return { id: item.id, directory: absolute(item.directory), materialized: item.materialized };
  });
  if (new Set(paths.map(item => item.id)).size !== sessionIds.length || paths.length !== sessionIds.length) {
    throw fail('删除恢复记录的对话与路径不匹配。', 'INVALID_DELETE_JOURNAL');
  }
  // This allowlist intentionally never persists titles, messages, or error text.
  return { id: value.id, phase: value.phase, sessionIds, paths,
    attachments: cleanPlan(value.attachments ?? {}), createdAt: value.createdAt };
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); } catch (error) {
    // Windows does not permit opening a directory for fsync.
    if (!(process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes(error.code))) throw error;
  } finally { await handle?.close(); }
}

export class SafeDeletionFiles {
  constructor({ sessionsRoot, attachmentRoot, requestCacheRoot, stateRoot }) {
    this.sessionsRoot = absolute(sessionsRoot);
    this.attachmentRoot = absolute(attachmentRoot);
    this.requestCacheRoot = absolute(requestCacheRoot);
    this.stateRoot = absolute(stateRoot);
    this.pendingRoot = path.join(this.stateRoot, 'pending');
    // A misconfigured state directory must never place journals in deleted data.
    for (const root of [this.sessionsRoot, this.attachmentRoot, this.requestCacheRoot]) {
      const relative = path.relative(root, this.stateRoot);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw fail('恢复记录目录必须独立于会话和附件目录。');
      }
    }
  }

  async validateSessionDirectory(directory) {
    const target = within(this.sessionsRoot, directory, 2);
    await inspectPath(target, { directory: true });
    return target;
  }

  async deleteSessions(paths) {
    const targets = [...new Set(await Promise.all(paths.map(item => this.validateSessionDirectory(item.directory))))];
    // Validate every full tree before deleting any session.
    for (const target of targets) await inspectTree(target);
    let removed = 0;
    for (const target of targets) {
      if (!await inspectTree(target)) continue;
      await fs.rm(target, { recursive: true, force: false });
      removed += 1;
    }
    return removed;
  }

  planAttachments(candidates, retained) {
    const keep = refs(retained);
    return { ...exclusiveRefs(candidates, retained),
      retainedFileDigests: [...new Set([...keep.files.values()].map(ref => ref.attachmentId.slice(7)))].sort() };
  }

  attachmentTargets(plan) {
    plan = cleanPlan(plan);
    const targets = [];
    for (const ref of plan.images) {
      const hash = ref.attachmentId.slice(7);
      targets.push({ type: 'images', target: path.join(this.attachmentRoot, 'objects', hash.slice(0, 2), hash) });
    }
    const canonical = new Set();
    for (const ref of plan.files) {
      const hash = ref.attachmentId.slice(7);
      targets.push({ type: 'files', target: path.join(this.attachmentRoot, 'files', hash.slice(0, 2), hash, ref.name) });
      if (!plan.retainedFileDigests.includes(hash)) canonical.add(hash);
    }
    for (const hash of canonical) {
      targets.push({ type: 'objects', target: path.join(this.attachmentRoot, 'file-objects', hash.slice(0, 2), hash) });
    }
    return targets;
  }

  async validateAttachmentPlan(plan) {
    const targets = this.attachmentTargets(plan);
    for (const { target } of targets) {
      within(this.attachmentRoot, target);
      await inspectPath(target, { directory: false });
    }
    return targets;
  }

  async validateDeletion(paths, plan) {
    for (const item of paths) await inspectTree(await this.validateSessionDirectory(item.directory));
    await this.validateAttachmentPlan(plan);
    if (plan.images.length) await inspectTree(path.join(this.requestCacheRoot, 'request-images'));
  }

  async deleteAttachments(plan) {
    const targets = await this.validateAttachmentPlan(plan);
    const count = { images: 0, files: 0, objects: 0, total: 0 };
    for (const { type, target } of targets) {
      if (!await inspectPath(target, { directory: false })) continue;
      await fs.unlink(target);
      count[type] += 1;
      count.total += 1;
    }
    return count;
  }

  /** Caller holds the upload/conversion barrier before invoking this method. */
  async clearRequestCache() {
    const target = within(this.requestCacheRoot, path.join(this.requestCacheRoot, 'request-images'), 1);
    if (!await inspectTree(target)) return false;
    await fs.rm(target, { recursive: true, force: false });
    return true;
  }

  journalPath(id) {
    if (!OP_ID.test(id)) throw fail('删除恢复记录编号无效。', 'INVALID_DELETE_JOURNAL');
    return path.join(this.pendingRoot, `${id}.json`);
  }

  async writeJournal(value) {
    const journal = cleanJournal(value);
    for (const item of journal.paths) await this.validateSessionDirectory(item.directory);
    await inspectPath(this.pendingRoot, { directory: true });
    await fs.mkdir(this.pendingRoot, { recursive: true, mode: 0o700 });
    await inspectPath(this.pendingRoot, { directory: true, allowMissing: false });
    const target = this.journalPath(journal.id);
    await inspectPath(target, { directory: false });
    const existing = await this.readJournal(journal.id);
    if (existing && PHASES.indexOf(journal.phase) < PHASES.indexOf(existing.phase)) {
      throw fail('删除恢复记录阶段不可回退。', 'INVALID_DELETE_JOURNAL');
    }
    if (existing && JSON.stringify({ ...existing, phase: journal.phase }) !== JSON.stringify(journal)) {
      throw fail('已确认的删除范围不可更改，请使用新的删除操作。', 'INVALID_DELETE_JOURNAL');
    }
    const staging = path.join(this.pendingRoot, `.${journal.id}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(staging, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await inspectPath(target, { directory: false });
      await fs.rename(staging, target);
      await syncDirectory(this.pendingRoot);
    } finally {
      await handle?.close();
      await fs.unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return journal;
  }

  async readJournal(id) {
    const target = this.journalPath(id);
    if (!await inspectPath(target, { directory: false })) return null;
    const journal = cleanJournal(JSON.parse(await fs.readFile(target, 'utf8')));
    if (journal.id !== id) throw fail('删除恢复记录编号与文件名不符。', 'INVALID_DELETE_JOURNAL');
    for (const item of journal.paths) await this.validateSessionDirectory(item.directory);
    return journal;
  }

  async listPending() {
    if (!await inspectPath(this.pendingRoot, { directory: true })) return [];
    const names = (await fs.readdir(this.pendingRoot)).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(name => this.readJournal(name.slice(0, -5))));
  }

  async listJournals() { return this.listPending(); }

  async updateJournal(id, patch) {
    const existing = await this.readJournal(id);
    if (!existing) throw fail('找不到删除恢复记录。', 'DELETE_JOURNAL_NOT_FOUND');
    if (Object.keys(patch).some(key => key !== 'phase')) throw fail('仅允许更新删除恢复阶段。', 'INVALID_DELETE_JOURNAL');
    return this.writeJournal({ ...existing, ...patch });
  }

  async removeJournal(id) {
    const target = this.journalPath(id);
    if (!await inspectPath(target, { directory: false })) return false;
    await fs.unlink(target);
    await syncDirectory(this.pendingRoot);
    return true;
  }
}
