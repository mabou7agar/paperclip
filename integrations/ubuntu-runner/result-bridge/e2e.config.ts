import type { E2EConfig } from 'e2e';
export default {
  tests: 'tests/result-delivery.e2e.ts',
  targets: [{ name: 'runner-result-ipc', platform: 'tools' }],
  workers: 1, retries: 0, timeout: 60000, trace: 'on', cache: 'off', reporters: ['list', 'junit', 'markdown'],
} satisfies E2EConfig;
