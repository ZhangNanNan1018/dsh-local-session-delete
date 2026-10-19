import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { clientRemoteInfo } from './wire.js';
import stylesheet from './styles.css';

function TrashIcon({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6" /></svg>;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function valueOf(call) {
  const result = await call;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function displayDate(value) {
  if (!value) return '时间未知';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function SessionManager({ wide = true, remote, afterDelete }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current += 1; }; }, []);
  const active = requestId => mounted.current && epoch.current === requestId;

  async function load({ keepNotice = false } = {}) {
    const requestId = ++epoch.current;
    setPhase('loading');
    setError('');
    setPreview(null);
    setConfirmed(false);
    if (!keepNotice) setNotice('');
    try {
      const result = await valueOf(remote.list({}));
      if (active(requestId)) setCatalog(result);
    } catch (cause) {
      if (active(requestId)) setError(messageOf(cause));
    } finally {
      if (active(requestId)) setPhase('idle');
    }
  }

  function show() {
    setOpen(true);
    void load();
  }

  function close() {
    if (phase === 'deleting') return;
    epoch.current += 1;
    setOpen(false);
    setPhase('idle');
    setPreview(null);
    setConfirmed(false);
  }

  async function inspect(sessionId) {
    const requestId = ++epoch.current;
    setPhase('previewing');
    setError('');
    setNotice('');
    setConfirmed(false);
    try {
      const result = await valueOf(remote.preview({ sessionId }));
      if (active(requestId)) setPreview(result);
    } catch (cause) {
      if (active(requestId)) setError(messageOf(cause));
    } finally {
      if (active(requestId)) setPhase('idle');
    }
  }

  async function remove() {
    if (!preview || !confirmed || phase !== 'idle' || preview.busyReasons.length > 0) return;
    const requestId = ++epoch.current;
    setPhase('deleting');
    setError('');
    try {
      const result = await valueOf(remote.deleteConfirmed({ sessionId: preview.sessionId, previewToken: preview.previewToken }));
      let refreshWarning = '';
      try { await afterDelete(result.deletedIds); } catch (cause) { refreshWarning = `；侧边栏刷新失败，请重新打开应用：${messageOf(cause)}`; }
      if (!active(requestId)) return;
      setNotice(`已永久删除 ${result.deletedIds.length} 个会话及 ${result.attachmentCount} 个专属附件${refreshWarning}。`);
      await load({ keepNotice: true });
    } catch (cause) {
      if (active(requestId)) {
        setError(messageOf(cause));
        setPreview(null);
        setConfirmed(false);
      }
    } finally {
      if (active(requestId)) setPhase('idle');
    }
  }

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (catalog?.sessions ?? []).filter(session =>
      (filter === 'all' || (filter === 'archived' ? session.archived : !session.archived)) &&
      (!needle || `${session.title}\n${session.workspace}\n${session.id}`.toLocaleLowerCase().includes(needle)));
  }, [catalog, query, filter]);
  const working = phase !== 'idle';
  const blocked = catalog?.compatible === false;

  return <>
    <button type="button" className="dsh-delete-entry" onClick={show} title="对话管理" aria-label="对话管理" aria-haspopup="dialog">
      <TrashIcon />{wide && <span>对话管理</span>}
    </button>
    <Modal open={open} onClose={close} title={preview ? '确认永久删除' : '对话管理'} closeLabel="关闭" className="dsh-delete-modal" contentClassName="dsh-delete-modal-content"
      description={preview ? '请核对删除范围。确认后无法从本机恢复。' : '管理本机对话，包含已归档对话。每次删除前都会显示具体范围。'}
      footer={<>
        <span className="dsh-delete-progress" role="status" aria-live="polite">{phase === 'loading' ? '正在读取对话…' : phase === 'previewing' ? '正在检查删除范围…' : phase === 'deleting' ? '正在永久删除，请稍候…' : ''}</span>
        <Button variant="ghost" disabled={phase === 'deleting'} onClick={preview ? () => { setPreview(null); setConfirmed(false); setError(''); } : close}>{preview ? '返回列表' : '关闭'}</Button>
        {preview && <Button variant="primary" className="dsh-delete-danger" disabled={working || !confirmed || preview.busyReasons.length > 0} onClick={() => void remove()}>{phase === 'deleting' ? '正在删除…' : '永久删除'}</Button>}
      </>}>
      <div className="dsh-delete-body" aria-busy={working}>
        {error && <div className="dsh-delete-message dsh-delete-error" role="alert">{error}</div>}
        {notice && <div className="dsh-delete-message dsh-delete-success" role="status">{notice}</div>}
        {blocked && <div className="dsh-delete-message dsh-delete-error" role="alert">{catalog.reason || '当前应用版本或存储结构不受支持，已停用删除功能。'}</div>}
        {preview ? <section className="dsh-delete-preview">
          <div className="dsh-delete-counts"><span><strong>{preview.sessionCount}</strong> 个会话</span><span><strong>{preview.attachmentCount}</strong> 个专属附件</span></div>
          <p className="dsh-delete-hint">包含选定对话及其专属子智能体会话。独立分叉会话、被其他对话引用的附件会保留。</p>
          <ul className="dsh-delete-preview-list">{preview.sessions.map(session => <li key={session.id}><strong>{session.title || '未命名对话'}</strong><code>{session.id}</code></li>)}</ul>
          {preview.busyReasons.length > 0 && <div className="dsh-delete-message dsh-delete-error" role="alert">{preview.busyReasons.join('；')}</div>}
          <label className="dsh-delete-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={working || preview.busyReasons.length > 0} /><span>我已核对范围，确认永久删除这些本机对话及专属附件。</span></label>
        </section> : <>
          <div className="dsh-delete-toolbar">
            <Input className="dsh-delete-search" aria-label="搜索对话" placeholder="搜索标题、工作区或会话编号" value={query} onChange={event => setQuery(event.target.value)} disabled={phase === 'deleting'} />
            <Button variant="outline" size="sm" disabled={working} onClick={() => void load()}>刷新</Button>
          </div>
          <div className="dsh-delete-filters" role="group" aria-label="对话范围">{[['all', '全部'], ['active', '未归档'], ['archived', '已归档']].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}<span>{rows.length} 个对话</span></div>
          <div className="dsh-delete-list">
            {rows.map(session => <article key={session.id} className="dsh-delete-row">
              <div className="dsh-delete-row-main"><div className="dsh-delete-row-heading"><strong>{session.title || '未命名对话'}</strong>{session.archived && <span className="dsh-delete-badge">已归档</span>}</div>
                <p className="dsh-delete-workspace" title={session.workspace}>{session.workspace || '未分组'} · {displayDate(session.updatedAt)}{session.subagentCount > 0 && ` · ${session.subagentCount} 个子会话`}</p>
                <code className="dsh-delete-id">{session.id}</code>
                {session.busyReasons.length > 0 && <p className="dsh-delete-busy">{session.busyReasons.join('；')}</p>}
              </div>
              <Button variant="outline" size="sm" disabled={working || blocked || session.busyReasons.length > 0} aria-label={`删除对话：${session.title || '未命名对话'}`} onClick={() => void inspect(session.id)}>删除</Button>
            </article>)}
            {rows.length === 0 && <p className="dsh-delete-empty">{phase === 'loading' ? '正在读取对话…' : catalog === null ? '无法读取对话，请刷新重试。' : query || filter !== 'all' ? '没有符合条件的对话。' : '暂无对话。'}</p>}
          </div>
          <p className="dsh-delete-hint">运行中、等待交互或存在活动子任务的对话无法删除。删除仅作用于本机 Harness 保存的数据，不会删除工作区文件。</p>
        </>}
      </div>
    </Modal>
  </>;
}

export const inject = ['slots', 'remote', 'sessions', 'uiWorkspace'];
export async function apply(ctx) {
  try { return await activateClient(ctx); }
  catch (error) {
    console.error('[dsh-local-session-delete] 客户端启动失败', error, error?.stack);
    throw error;
  }
}

async function activateClient(ctx) {
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-local-session-delete';
  style.textContent = stylesheet;
  ctx.effect(() => { document.head.appendChild(style); return () => style.remove(); }, 'session-delete: styles');
  await ctx.remote.$mount(clientRemoteInfo);
  const afterDelete = async deletedIds => {
    const selected = ctx.uiWorkspace.selection.getSnapshot().sessionId;
    if (selected !== undefined && deletedIds.includes(selected)) ctx.uiWorkspace.clearMain();
    await ctx.sessions.refresh();
  };
  const slot = 'sidebar.footer.action';
  // namespace 在 $mount 后才存在，必须由独立的注入作用域取得，不能从 slot 的借用作用域读取。
  ctx.inject(['remote.sessionDelete'], scope => {
    const remote = scope.remote.sessionDelete;
    scope.slots.inject(slot, () => scope.slots.register({ name: slot, id: 'dsh-local-session-delete', order: 60,
      inject: () => ({ remote, afterDelete }),
    }, SessionManager));
  });
}
