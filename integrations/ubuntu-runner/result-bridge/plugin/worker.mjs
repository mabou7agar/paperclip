import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { BrokerClient } from './broker-client.mjs';
import { ResultService } from './result-service.mjs';
import { NativeQueueClient } from './native-queue-client.mjs';
import { loadTrust } from './native-envelope.mjs';
import { tools } from './manifest.mjs';
export function createRunnerPlugin(broker) {
let service;
return definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) {
    if (!broker) {
      // config.get is company-scoped and cannot be called from global setup.
      // The sealed public binding activates native transport instance-wide.
      try { await loadTrust(); broker = new NativeQueueClient(ctx); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; broker = new BrokerClient(); }
    }
    service = new ResultService(ctx, broker);
    if (typeof broker.receive === 'function') ctx.actions.register('receive-broker-envelope',
      (params, context) => broker.receive(params, context, service));
    for (const tool of tools) ctx.tools.register(tool.name, tool, async (args, run) => {
      try { const data = tool.name === 'submit-runner-job'
        ? await service.submit(args, run) : await service.status(args.jobId, run);
        return { content: JSON.stringify(data), data }; }
      catch (error) {
        const match = /^runner_broker:([a-z][a-z0-9_]{1,99})$/.exec(error?.message ?? '');
        const code = match?.[1] ?? 'runner_request_unavailable';
        return { error: `Runner request not admitted (${code}). Preserve this task and context. Do not retry execution blindly; route a genuine configuration failure to its lead once.`,
          data: { state: 'not_admitted', code } };
      }
    });
    ctx.jobs.register('deliver-pending-results', () => service.drain());
    if (typeof broker.startup === 'function') await broker.startup();
  },
  async onWebhook(input) {
    if (input.endpointKey !== 'terminal' || Buffer.byteLength(input.rawBody) > 256) throw new Error('runner_hint_invalid');
    const value = JSON.parse(input.rawBody);
    if (!value || Object.keys(value).length !== 1) throw new Error('runner_hint_invalid');
    await service.deliver(value.jobId);
  },
  async onHealth() { return { status: 'ok', message: `Runner transport: ${typeof broker?.receive === 'function' ? 'native' : 'root_ipc'}. Native task admission remains authoritative.` }; },
});
}
const plugin = createRunnerPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
