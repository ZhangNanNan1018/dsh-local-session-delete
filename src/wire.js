import { z } from 'zod';

export const PACKAGE_NAME = 'dsh-local-session-delete';
export const SERVICE_KEY = 'sessionDeleteController';
export const NAMESPACE = 'sessionDelete';

const id = z.string().min(1);
const reasons = z.array(z.string());
export const requestSchemas = {
  list: z.strictObject({}),
  preview: z.strictObject({ sessionId: id }),
  remove: z.strictObject({ sessionId: id, previewToken: z.string().min(1) }),
};
export const resultSchemas = {
  list: z.strictObject({
    compatible: z.boolean(),
    reason: z.string().nullable().optional(),
    sessions: z.array(z.strictObject({
      id,
      title: z.string(),
      workspace: z.string(),
      archived: z.boolean(),
      busyReasons: reasons,
      updatedAt: z.number().finite(),
      subagentCount: z.number().int().nonnegative(),
    })),
  }),
  preview: z.strictObject({
    sessionId: id,
    previewToken: z.string(),
    sessionCount: z.number().int().positive(),
    attachmentCount: z.number().int().nonnegative(),
    busyReasons: reasons,
    sessions: z.array(z.strictObject({ id, title: z.string() })),
  }).refine(value => value.busyReasons.length > 0 || value.previewToken.length > 0, '可删除预览必须包含确认令牌'),
  remove: z.strictObject({
    deletedIds: z.array(id),
    attachmentCount: z.number().int().nonnegative(),
    complete: z.literal(true),
  }),
};

function codec(schema, typeName) {
  return {
    mode: 'strict',
    typeSymbol: `${PACKAGE_NAME}#${typeName}`,
    create: () => schema,
    decode: value => schema.parse(value),
    encode: value => schema.parse(value),
  };
}

// 同一份严格契约用于 Host 分发与 Client namespace 挂载，避免维护两套参数规则。
export const remoteInfo = {
  package: PACKAGE_NAME,
  descriptors: Object.keys(requestSchemas).map(method => {
    const input = codec(requestSchemas[method], `${method}Request`);
    return {
      id: `${PACKAGE_NAME}#${NAMESPACE}/${method}`,
      service: SERVICE_KEY,
      namespace: NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: input, strictCodec: input }],
      result: codec(resultSchemas[method], `${method}Result`),
    };
  }),
};

// 保留 Host remove 端点兼容既有调用；浏览器 namespace 的 remove 是宿主内部保留方法。
remoteInfo.descriptors.push({
  ...remoteInfo.descriptors.find(descriptor => descriptor.method === 'remove'),
  id: `${PACKAGE_NAME}#${NAMESPACE}/deleteConfirmed`,
  method: 'deleteConfirmed',
  implementation: 'remove',
});
export const clientRemoteInfo = {
  package: PACKAGE_NAME,
  descriptors: remoteInfo.descriptors.filter(descriptor => descriptor.method !== 'remove'),
};
