const properties = {
  taskId: { type: 'string', format: 'uuid' }, profile: { type: 'string' },
  kind: { enum: ['reviewed_controller', 'control_checks'] },
  attachmentId: { type: 'string', format: 'uuid' }, packetSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  scopeIssueId: { type: ['string', 'null'] }, scopeCommentId: { type: ['string', 'null'] },
  ackCommentId: { type: ['string', 'null'] }, recipe: { type: ['string', 'null'] },
};
export const tools = [
  { name: 'submit-runner-job', displayName: 'Run reviewed work',
    description: 'Submit one registered Ubuntu job. Reviewed executions require exact current review, CTO scope and acknowledgement. Replays return the same job. Never re-run a spent attempt or passed cases.',
    parametersSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } },
  { name: 'runner-job-status', displayName: 'Read runner result', description: 'Read an existing job; starts no execution and emits no wake.',
    parametersSchema: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' } }, required: ['jobId'], additionalProperties: false } },
];
export default {
  id: 'paperclip.ubuntu-runner-results', apiVersion: 1, version: '0.1.0',
  displayName: 'Ubuntu runner results', description: 'Durable reviewed jobs and native same-task result delivery.',
  author: 'Paperclip', categories: ['automation'],
  capabilities: ['agent.tools.register', 'issues.read', 'issues.update', 'issue.documents.read', 'issue.documents.write',
    'issues.checkout', 'issues.wakeup', 'issues.wakeup.durable', 'jobs.schedule', 'webhooks.receive'],
  entrypoints: { worker: './worker.mjs' }, tools,
  jobs: [{ jobKey: 'deliver-pending-results', displayName: 'Recover pending result delivery', schedule: '* * * * *' }],
  webhooks: [{ endpointKey: 'terminal', displayName: 'Runner completion hint' }],
  instanceConfigSchema: { type: 'object', additionalProperties: false, required: ['profiles'],
    properties: { profiles: { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' } } } },
};
