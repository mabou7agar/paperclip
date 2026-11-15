const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const uuid = value => typeof value === 'string' && UUID.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const submitFields = ['taskId', 'profile', 'kind', 'attachmentId', 'packetSha256',
  'scopeIssueId', 'scopeCommentId', 'ackCommentId', 'recipe'];

export function submission(value) {
  if (!exact(value, submitFields) || !uuid(value.taskId) || !uuid(value.attachmentId) ||
      !KEY.test(value.profile) || !SHA.test(value.packetSha256) ||
      !['reviewed_controller', 'control_checks'].includes(value.kind)) throw new Error('runner_submission_invalid');
  if (value.kind === 'reviewed_controller') {
    if (![value.scopeIssueId, value.scopeCommentId, value.ackCommentId].every(uuid) || value.recipe !== null) {
      throw new Error('runner_review_authority_required');
    }
  } else if (value.scopeIssueId !== null || value.scopeCommentId !== null || value.ackCommentId !== null ||
      typeof value.recipe !== 'string' || !/^[a-z][a-z0-9-]{0,95}-new\.py$/.test(value.recipe)) {
    throw new Error('runner_control_recipe_invalid');
  }
  return value;
}

export function delivery(value) {
  if (!exact(value, ['jobId', 'companyId', 'projectId', 'issueId', 'agentId', 'profile', 'status',
    'receiptSha256', 'fingerprint', 'newEvidence', 'result']) ||
    ![value.jobId, value.companyId, value.projectId, value.issueId, value.agentId].every(uuid) ||
    !KEY.test(value.profile) || !SHA.test(value.receiptSha256) || !SHA.test(value.fingerprint) ||
    !['passed', 'failed', 'unknown', 'cancelled'].includes(value.status) || typeof value.newEvidence !== 'boolean' ||
    !value.result || typeof value.result !== 'object' || Array.isArray(value.result) ||
    Buffer.byteLength(JSON.stringify(value)) > 120 * 1024) throw new Error('runner_delivery_invalid');
  return value;
}
