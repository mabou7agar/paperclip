import { createHash } from 'node:crypto';

export const REQUEST_NAMESPACE = 'runner-requests';
export const ADMISSION_NAMESPACE = 'runner-admissions';
export const PLUGIN_KEY = 'paperclip.ubuntu-runner-results';
export const ENVELOPE_DOMAIN = 'paperclip.ubuntu-runner-results.envelope.v1\n';
export const canonical = value => JSON.stringify(value, (_key, child) => child &&
  typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const stableInput = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'sourceRunId'));

/** Same URL-namespace UUIDv5 as the broker. Provider turns are not job IDs. */
export function jobId(value) {
  const identity = Object.fromEntries(['companyId', 'taskId', 'profile', 'kind', 'packetSha256',
    'scopeCommentId', 'recipe'].map(key => [key, value[key]]));
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace)
    .update('paperclip.runner-job.v1:' + digest(identity)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const text = bytes.toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export const requestKey = (taskId, id, namespace = REQUEST_NAMESPACE) => ({
  scopeKind: 'issue', scopeId: taskId, namespace, stateKey: id,
});
