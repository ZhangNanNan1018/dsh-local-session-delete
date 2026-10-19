import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { DeletionService } from './service.js';
import { RuntimeAdapter } from './adapter.js';
import { PACKAGE_NAME, SERVICE_KEY, NAMESPACE, remoteInfo, requestSchemas, resultSchemas } from './wire.js';

export const name = 'local-session-delete';
export const inject = ['typert', 'agents', 'agentLoop', 'sessions', 'sessionPersistence', 'sessionQuery', 'sessionController', 'fileUploads', 'workspaceRegistry', 'storageDomain', 'sessionProjectionCache', 'attachments'];

class SessionDeleteController extends TypertRemoteService {
  constructor(ctx, service) {
    super(ctx, SERVICE_KEY, { namespace: NAMESPACE });
    this.service = service;
  }

  assertOwner() {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('session-delete/forbidden', '仅本机拥有者可管理对话。', {});
    }
  }

  async list(request) {
    this.assertOwner();
    return resultSchemas.list.parse(await this.service.list(requestSchemas.list.parse(request)));
  }

  async preview(request) {
    this.assertOwner();
    return resultSchemas.preview.parse(await this.service.preview(requestSchemas.preview.parse(request)));
  }

  async remove(request) {
    this.assertOwner();
    return resultSchemas.remove.parse(await this.service.remove(requestSchemas.remove.parse(request)));
  }
}

export async function apply(ctx) {
  const adapter = new RuntimeAdapter(ctx);
  await adapter.install();
  const service = new DeletionService(adapter);
  ctx.effect(() => async () => {
    await service.tail;
    await adapter.barrierTail;
    await adapter.dispose();
  }, 'session-delete: drain confirmed operations before releasing runtime adapter');
  await service.initialize();
  new SessionDeleteController(ctx, service);
  ctx.typert.register({
    package: PACKAGE_NAME,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: remoteInfo.descriptors,
  });
}
