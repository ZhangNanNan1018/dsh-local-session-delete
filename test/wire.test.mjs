import test from 'node:test';
import assert from 'node:assert/strict';
import { clientRemoteInfo, remoteInfo, requestSchemas, resultSchemas } from '../src/wire.js';

test('删除接口只接受确认预览产生的会话编号和令牌', () => {
  assert.deepEqual(requestSchemas.remove.parse({ sessionId: 'session-a', previewToken: 'one-time-token' }), { sessionId: 'session-a', previewToken: 'one-time-token' });
  for (const request of [
    { sessionId: 'session-a' },
    { sessionId: 'session-a', previewToken: '' },
    { sessionId: 'session-a', previewToken: 'token', includeAll: true },
  ]) assert.throws(() => requestSchemas.remove.parse(request));
  assert.throws(() => requestSchemas.list.parse({ includePrivateContent: true }));
});

test('Host 和 Client 共享严格且唯一的 namespace 描述符', () => {
  assert.deepEqual(remoteInfo.descriptors.map(row => `${row.namespace}/${row.method}`), ['sessionDelete/list', 'sessionDelete/preview', 'sessionDelete/remove', 'sessionDelete/deleteConfirmed']);
  assert.deepEqual(clientRemoteInfo.descriptors.map(row => row.method), ['list', 'preview', 'deleteConfirmed']);
  assert.equal(remoteInfo.descriptors[3].implementation, 'remove');
  assert.equal(remoteInfo.descriptors[2].result, remoteInfo.descriptors[3].result);
  for (const descriptor of remoteInfo.descriptors) {
    assert.equal(descriptor.service, 'sessionDeleteController');
    assert.equal(descriptor.parameters.length, 1);
    assert.equal(descriptor.parameters[0].wire, 'request');
    assert.equal(descriptor.parameters[0].codec, descriptor.parameters[0].strictCodec);
    assert.equal(descriptor.invocation.kind, 'direct');
    assert.throws(() => descriptor.parameters[0].codec.decode({ unknown: true }));
  }
});

test('不将部分成功伪装成完整删除结果', () => {
  assert.deepEqual(resultSchemas.remove.parse({ deletedIds: ['session-a'], attachmentCount: 2, complete: true }), { deletedIds: ['session-a'], attachmentCount: 2, complete: true });
  assert.throws(() => resultSchemas.remove.parse({ deletedIds: ['session-a'], attachmentCount: 2, complete: false }));
  assert.throws(() => resultSchemas.remove.parse({ deletedIds: ['session-a'], attachmentCount: -1, complete: true }));
});
