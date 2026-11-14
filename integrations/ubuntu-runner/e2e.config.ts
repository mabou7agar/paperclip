import type { E2EConfig } from 'e2e';

export default {
  tests: 'tests/smoke.e2e.ts',
  targets: [{ name: 'prepared-ubuntu-preview', platform: 'tools' }],
  workers: 1,
  retries: 0,
  timeout: 120000,
  trace: 'on',
  cache: 'off',
  reporters: ['list', 'junit', 'markdown'],
} satisfies E2EConfig;
