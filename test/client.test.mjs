import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function allNodes(tree, predicate, output = []) {
  if (Array.isArray(tree)) for (const child of tree) allNodes(child, predicate, output);
  else if (tree && typeof tree === 'object' && 'props' in tree) {
    if (predicate(tree)) output.push(tree);
    allNodes(tree.props.children, predicate, output);
    allNodes(tree.props.footer, predicate, output);
  }
  return output;
}

async function clientHarness({ busy = false } = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const values = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const key = cursor++;
      if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial;
      return [values[key], value => { values[key] = typeof value === 'function' ? value(values[key]) : value; }];
    },
    useRef(initial) {
      const key = cursor++;
      return values[key] ??= { current: initial };
    },
    useEffect() {},
    useMemo(factory) { return factory(); },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, '@deepseek-ai/dsh-client-ui-primitives': { Button: 'Button', Input: 'Input', Modal: 'Modal' } };
  let plugin;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: module => { plugin = module.factory(id => { assert.ok(id in modules, `unexpected browser dependency ${id}`); return modules[id]; }); } } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
  });
  let component;
  let props;
  let slotInject;
  let namespaceAllowed = false;
  let calls = 0;
  let cleared = 0;
  let refreshed = 0;
  let settle;
  const row = { id: 'test-session', title: '测试会话', workspace: '测试工作区', archived: false, updatedAt: 1, subagentCount: 0, busyReasons: busy ? ['会话正在运行'] : [] };
  const remote = {
    list: async () => ({ ok: true, value: { compatible: true, sessions: [row] } }),
    preview: async () => ({ ok: true, value: { sessionId: row.id, previewToken: busy ? '' : 'confirmed-preview', sessionCount: 1, attachmentCount: 2, busyReasons: row.busyReasons, sessions: [{ id: row.id, title: row.title }] } }),
    deleteConfirmed: async request => { calls += 1; assert.deepEqual(JSON.parse(JSON.stringify(request)), { sessionId: row.id, previewToken: 'confirmed-preview' }); return new Promise(resolve => { settle = () => resolve({ ok: true, value: { deletedIds: [row.id], attachmentCount: 2, complete: true } }); }); },
  };
  const ctx = {
    remote: { $mount: async contribution => {
      assert.deepEqual(Array.from(contribution.descriptors, descriptor => descriptor.method), ['list', 'preview', 'deleteConfirmed']);
      assert.equal(contribution.descriptors.some(descriptor => descriptor.method === 'remove'), false, '宿主内部 remove 方法不得挂载到浏览器 namespace');
    }, get sessionDelete() { assert.equal(namespaceAllowed, true, '动态 namespace 必须从声明依赖的作用域读取'); return remote; } },
    effect: factory => factory(),
    inject: (dependencies, factory) => {
      assert.deepEqual(Array.from(dependencies), ['remote.sessionDelete']);
      namespaceAllowed = true;
      try { return factory(ctx); } finally { namespaceAllowed = false; }
    },
    slots: { inject: (_name, factory) => factory(), register: (options, view) => { slotInject = options.inject; component = view; } },
    uiWorkspace: { selection: { getSnapshot: () => ({ sessionId: row.id }) }, clearMain: () => { cleared += 1; } },
    sessions: { refresh: async () => { refreshed += 1; } },
  };
  await plugin.apply(ctx);
  props = slotInject();
  let tree;
  return {
    render() { cursor = 0; tree = component({ wide: true, ...props }); return tree; },
    find(predicate) { return allNodes(tree, predicate)[0]; },
    get calls() { return calls; }, get cleared() { return cleared; }, get refreshed() { return refreshed; },
    settle() { settle(); },
    flush: () => new Promise(resolve => setImmediate(resolve)),
  };
}

test('删除前必须勾选确认，删除过程中不能关闭，成功后清空当前会话并刷新', async () => {
  const app = await clientHarness();
  app.render();
  app.find(node => node.props['aria-label'] === '对话管理').props.onClick();
  await app.flush();
  app.render();
  app.find(node => node.props['aria-label'] === '删除对话：测试会话').props.onClick();
  await app.flush();
  app.render();
  let action = app.find(node => node.type === 'Button' && node.props.children === '永久删除');
  assert.equal(action.props.disabled, true);
  action.props.onClick();
  assert.equal(app.calls, 0);
  app.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  app.render();
  action = app.find(node => node.type === 'Button' && node.props.children === '永久删除');
  assert.equal(action.props.disabled, false);
  action.props.onClick();
  app.render();
  assert.equal(app.calls, 1);
  const modal = app.find(node => node.type === 'Modal');
  modal.props.onClose();
  app.render();
  assert.equal(app.find(node => node.type === 'Modal').props.open, true);
  app.settle();
  await app.flush();
  app.render();
  assert.equal(app.cleared, 1);
  assert.equal(app.refreshed, 1);
  assert.ok(app.find(node => node.props.role === 'status' && String(node.props.children).includes('已永久删除')));
});

test('运行中的对话禁用删除入口', async () => {
  const app = await clientHarness({ busy: true });
  app.render();
  app.find(node => node.props['aria-label'] === '对话管理').props.onClick();
  await app.flush();
  app.render();
  assert.equal(app.find(node => node.props['aria-label'] === '删除对话：测试会话').props.disabled, true);
  assert.equal(app.calls, 0);
});
