/** Operator-mounted socket; company settings cannot select a network destination. */
export const BROKER_SOCKET = '/paperclip/ubuntu-runner/broker.sock';
export const BROKER_AUTH_FILE = '/paperclip/ubuntu-runner/plugin-auth';
export const MAX_BYTES = 128 * 1024;

export function profiles(config) {
  if (!config || !Array.isArray(config.profiles) || config.profiles.length > 32 ||
      config.profiles.some(value => typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))) {
    throw new Error('runner_profiles_not_configured');
  }
  return new Set(config.profiles);
}
