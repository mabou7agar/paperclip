import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { BrokerClient } from './broker-client.mjs';
import { ResultService } from './result-service.mjs';
import { tools } from './manifest.mjs';
export function createRunnerPlugin(broker = new BrokerClient()) {
let service;
return definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) {
    service = new ResultService(ctx, broker);
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
  },
  async onWebhook(input) {
    if (input.endpointKey !== 'terminal' || Buffer.byteLength(input.rawBody) > 256) throw new Error('runner_hint_invalid');
    const value = JSON.parse(input.rawBody);
    if (!value || Object.keys(value).length !== 1) throw new Error('runner_hint_invalid');
    await service.deliver(value.jobId);
  },
  async onHealth() { return { status: 'ok', message: 'Runner results use the registered broker and native task admission.' }; },
});
}
const plugin = createRunnerPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
