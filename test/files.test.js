import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SafeDeletionFiles, exclusiveRefs } from '../src/files.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const image = hash => ({ attachmentId: `sha256:${hash}` });
const file = (hash, name = 'document.txt') => ({ ...image(hash), name });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-delete-files-'));
  t.after(async () => {
    // The target is the exact directory returned by mkdtemp, never a user path.
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('dsh-delete-files-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = {
    sessionsRoot: path.join(root, 'sessions'), attachmentRoot: path.join(root, 'attachments'),
    requestCacheRoot: path.join(root, 'cache'), stateRoot: path.join(root, 'state'),
  };
  for (const target of Object.values(options)) await fs.mkdir(target);
  const store = new SafeDeletionFiles(options);
  return { root, ...options, store };
}

async function write(target, content = 'test data') {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function exists(target) {
  return fs.lstat(target).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

test('removes every session generation and remains idempotent after interruption', async t => {
  const { store, sessionsRoot } = await fixture(t);
  const first = path.join(sessionsRoot, '_no-cwd', 'first');
  const second = path.join(sessionsRoot, '--project--', 'second');
  const fork = path.join(sessionsRoot, '--project--', 'independent-fork');
  for (const directory of [first, second, fork]) {
    await write(path.join(directory, 'session.v1.jsonl'));
    await write(path.join(directory, 'session.v2.jsonl.gz'));
    await write(path.join(directory, 'nested', 'future-format.bin'));
  }
  const paths = [{ id: 'first', directory: first, materialized: true },
    { id: 'second', directory: second, materialized: true }];
  assert.equal(await store.deleteSessions(paths.slice(0, 1)), 1);
  assert.equal(await store.deleteSessions(paths), 1);
  assert.equal(await store.deleteSessions(paths), 0);
  assert.equal(await exists(fork), true);
  assert.equal(await exists(first), false);
  assert.equal(await exists(second), false);
});

test('rejects root, project, traversal, and outside session paths before mutation', async t => {
  const { root, store, sessionsRoot } = await fixture(t);
  const good = path.join(sessionsRoot, 'project', 'good');
  await write(path.join(good, 'session.jsonl'));
  for (const directory of [sessionsRoot, path.join(sessionsRoot, 'project'), path.join(root, 'elsewhere'),
    `${sessionsRoot}${path.sep}project${path.sep}..${path.sep}project${path.sep}good`]) {
    await assert.rejects(store.deleteSessions([{ directory: good }, { directory }]), { code: 'UNSAFE_DELETE_PATH' });
    assert.equal(await exists(good), true);
  }
});

test('rejects junctions in ancestors and symlinks inside a session without following them', async t => {
  const { root, store, sessionsRoot } = await fixture(t);
  const outside = path.join(root, 'outside');
  const original = await write(path.join(outside, 'precious.txt'), 'keep');
  const linkedProject = path.join(sessionsRoot, 'linked-project');
  await fs.symlink(outside, linkedProject, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.validateSessionDirectory(path.join(linkedProject, 'session')), { code: 'UNSAFE_DELETE_PATH' });
  const good = path.join(sessionsRoot, 'project', 'session');
  await write(path.join(good, 'session.jsonl'));
  await fs.symlink(outside, path.join(good, 'linked-child'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.deleteSessions([{ directory: good }]), { code: 'UNSAFE_DELETE_PATH' });
  assert.equal(await fs.readFile(original, 'utf8'), 'keep');
  assert.equal(await exists(path.join(good, 'session.jsonl')), true);
});

test('exclusive references deduplicate and preserve exact shared aliases', () => {
  assert.deepEqual(exclusiveRefs({ images: [image(A), image(A), image(B)], files: [file(A), file(A), file(A, 'other.txt')] },
    { images: [image(A)], files: [file(A)] }), { images: [image(B)], files: [file(A, 'other.txt')] });
  for (const name of ['../bad', '..\\bad', 'NUL.txt', 'con .txt', 'bad:stream', 'bad.']) {
    assert.throws(() => exclusiveRefs({ files: [file(A, name)] }, {}), { code: 'INVALID_ATTACHMENT_REF' });
  }
  assert.throws(() => exclusiveRefs({ images: [image('../bad')] }, {}), { code: 'INVALID_ATTACHMENT_REF' });
});

test('removes only exclusive CAS images and aliases, preserving same-digest canonical files', async t => {
  const { store, attachmentRoot } = await fixture(t);
  const imageA = await write(path.join(attachmentRoot, 'objects', 'aa', A));
  const imageB = await write(path.join(attachmentRoot, 'objects', 'bb', B));
  const aliasA = await write(path.join(attachmentRoot, 'files', 'aa', A, 'target.txt'));
  const sharedAlias = await write(path.join(attachmentRoot, 'files', 'aa', A, 'keep.txt'));
  const canonicalA = await write(path.join(attachmentRoot, 'file-objects', 'aa', A));
  const aliasC = await write(path.join(attachmentRoot, 'files', 'cc', C, 'only.txt'));
  const canonicalC = await write(path.join(attachmentRoot, 'file-objects', 'cc', C));
  const plan = store.planAttachments({ images: [image(A), image(B)], files: [file(A, 'target.txt'), file(C, 'only.txt')] },
    { images: [image(B)], files: [file(A, 'keep.txt')] });
  assert.deepEqual(plan.retainedFileDigests, [A]);
  assert.deepEqual(await store.deleteAttachments(plan), { images: 1, files: 2, objects: 1, total: 4 });
  for (const target of [imageA, aliasA, aliasC, canonicalC]) assert.equal(await exists(target), false);
  for (const target of [imageB, sharedAlias, canonicalA]) assert.equal(await exists(target), true);
  assert.deepEqual(await store.deleteAttachments(plan), { images: 0, files: 0, objects: 0, total: 0 });
});

test('Windows case variants of retained file aliases are never deleted', { skip: process.platform !== 'win32' }, async t => {
  const { store, attachmentRoot } = await fixture(t);
  const candidate = await write(path.join(attachmentRoot, 'files', 'aa', A, 'REPORT.txt'));
  const canonical = await write(path.join(attachmentRoot, 'file-objects', 'aa', A));
  const retainedPath = path.join(attachmentRoot, 'files', 'aa', A, 'report.TXT');
  assert.equal(await fs.readFile(retainedPath, 'utf8'), 'test data');
  const plan = store.planAttachments({ files: [file(A, 'REPORT.txt')] }, { files: [file(A, 'report.TXT')] });
  assert.deepEqual(plan.files, []);
  assert.deepEqual(exclusiveRefs({ files: [file(A, 'I.txt')] }, { files: [file(A, 'ı.txt')] }).files, []);
  assert.equal((await store.deleteAttachments(plan)).total, 0);
  assert.equal(await exists(candidate), true);
  assert.equal(await exists(canonical), true);
});

test('attachment preflight rejects directory impostors and junctions before any unlink', async t => {
  const { root, store, attachmentRoot } = await fixture(t);
  const valid = await write(path.join(attachmentRoot, 'objects', 'aa', A));
  await fs.mkdir(path.join(attachmentRoot, 'objects', 'bb', B), { recursive: true });
  await assert.rejects(store.deleteAttachments(store.planAttachments({ images: [image(A), image(B)] }, {})), { code: 'UNSAFE_DELETE_PATH' });
  assert.equal(await exists(valid), true);
  const outside = path.join(root, 'external-objects');
  await write(path.join(outside, C));
  await fs.symlink(outside, path.join(attachmentRoot, 'objects', 'cc'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.deleteAttachments(store.planAttachments({ images: [image(C)] }, {})), { code: 'UNSAFE_DELETE_PATH' });
  assert.equal(await exists(path.join(outside, C)), true);
});

test('clears derived request images only, checking the tree before removal', async t => {
  const { root, store, requestCacheRoot } = await fixture(t);
  const request = await write(path.join(requestCacheRoot, 'request-images', 'aa', A));
  const other = await write(path.join(requestCacheRoot, 'unrelated-cache', 'keep'));
  assert.equal(await store.clearRequestCache(), true);
  assert.equal(await exists(request), false);
  assert.equal(await exists(other), true);
  assert.equal(await store.clearRequestCache(), false);
  const outside = path.join(root, 'outside-cache');
  await write(path.join(outside, 'keep'));
  await fs.symlink(outside, path.join(requestCacheRoot, 'request-images'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.clearRequestCache(), { code: 'UNSAFE_DELETE_PATH' });
  assert.equal(await exists(path.join(outside, 'keep')), true);
});

test('journal durably tracks phases without storing transcript, ignores staging leftovers, and resumes partial work', async t => {
  const { store, sessionsRoot, stateRoot } = await fixture(t);
  const first = path.join(sessionsRoot, 'project', 'first');
  const second = path.join(sessionsRoot, 'project', 'second');
  await write(path.join(first, 'session.v1.jsonl'), 'private transcript');
  await write(path.join(second, 'session.v2.jsonl'), 'private transcript');
  const journal = { id: randomUUID(), phase: 'prepared', sessionIds: ['first', 'second'],
    paths: [{ id: 'first', directory: first, materialized: true }, { id: 'second', directory: second, materialized: true }],
    attachments: store.planAttachments({}, {}), createdAt: Date.now(), title: 'private title', transcript: 'private transcript' };
  await store.writeJournal(journal);
  await assert.rejects(store.writeJournal({ ...journal, createdAt: journal.createdAt + 1 }), { code: 'INVALID_DELETE_JOURNAL' });
  const raw = await fs.readFile(store.journalPath(journal.id), 'utf8');
  assert.ok(!raw.includes('private'));
  await write(path.join(stateRoot, 'pending', '.interrupted.tmp'), 'partial invalid json');
  assert.equal((await store.listPending()).length, 1);
  await store.updateJournal(journal.id, { phase: 'closed' });
  await store.deleteSessions(journal.paths.slice(0, 1));
  const fresh = new SafeDeletionFiles(store);
  const [pending] = await fresh.listPending();
  assert.equal(pending.phase, 'closed');
  assert.equal(await fresh.deleteSessions(pending.paths), 1);
  await fresh.updateJournal(journal.id, { phase: 'logs' });
  await assert.rejects(fresh.updateJournal(journal.id, { phase: 'prepared' }), { code: 'INVALID_DELETE_JOURNAL' });
  await fresh.updateJournal(journal.id, { phase: 'metadata' });
  await fresh.updateJournal(journal.id, { phase: 'attachments' });
  assert.equal(await fresh.removeJournal(journal.id), true);
  assert.equal(await fresh.removeJournal(journal.id), false);
  assert.deepEqual(await fresh.listPending(), []);
});

test('journal refuses traversal IDs, mismatched paths, and symlink destinations', async t => {
  const { root, store, sessionsRoot, stateRoot } = await fixture(t);
  assert.throws(() => store.journalPath('../escape'), { code: 'INVALID_DELETE_JOURNAL' });
  const journal = { id: 'operation', phase: 'prepared', sessionIds: ['session'],
    paths: [{ id: 'session', directory: path.join(sessionsRoot, 'project', 'session'), materialized: false }],
    attachments: store.planAttachments({}, {}), createdAt: Date.now() };
  await assert.rejects(store.writeJournal({ ...journal, paths: [] }), { code: 'INVALID_DELETE_JOURNAL' });
  const outside = path.join(root, 'outside-journals');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(stateRoot, 'pending'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.writeJournal(journal), { code: 'UNSAFE_DELETE_PATH' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a Windows file lock retains the journal and a later retry completes', { skip: process.platform !== 'win32' }, async t => {
  const { store, sessionsRoot } = await fixture(t);
  const directory = path.join(sessionsRoot, 'project', 'locked-session');
  const lockedFile = await write(path.join(directory, 'session.v2.jsonl'));
  const journal = { id: randomUUID(), phase: 'closed', sessionIds: ['locked-session'],
    paths: [{ id: 'locked-session', directory, materialized: true }],
    attachments: store.planAttachments({}, {}), createdAt: Date.now() };
  await store.writeJournal(journal);
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$stream = [System.IO.File]::Open($env:DSH_DELETE_LOCK_FILE, 'Open', 'ReadWrite', 'None'); [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $stream.Dispose()"],
  { windowsHide: true, env: { ...process.env, DSH_DELETE_LOCK_FILE: lockedFile }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => holder.once('exit', resolve));
  let stderr = '';
  holder.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`File-lock helper timed out: ${stderr}`)), 10_000);
      holder.once('error', error => { clearTimeout(timeout); reject(error); });
      holder.once('exit', code => { clearTimeout(timeout); reject(new Error(`File-lock helper exited ${code}: ${stderr}`)); });
      holder.stdout.setEncoding('utf8').on('data', chunk => {
        if (chunk.includes('LOCKED')) { clearTimeout(timeout); resolve(); }
      });
    });
    await assert.rejects(store.deleteSessions(journal.paths));
    assert.equal((await store.readJournal(journal.id)).phase, 'closed');
    assert.equal(await exists(lockedFile), true);
  } finally {
    holder.stdin.end('\n');
    await exit;
  }
  const restarted = new SafeDeletionFiles(store);
  assert.equal(await restarted.deleteSessions((await restarted.readJournal(journal.id)).paths), 1);
  await restarted.removeJournal(journal.id);
  assert.equal(await exists(directory), false);
});
