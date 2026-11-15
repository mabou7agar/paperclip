import { readFileSync, lstatSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { BROKER_SOCKET, BROKER_AUTH_FILE, MAX_BYTES } from './configuration.mjs';

export class BrokerClient {
  constructor(socketPath = BROKER_SOCKET, secretReader = () => {
    const stat = lstatSync(BROKER_AUTH_FILE);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 || stat.size > 65) {
      throw new Error('runner_service_authentication_untrusted');
    }
    return readFileSync(BROKER_AUTH_FILE).toString('ascii').trim();
  }) { this.socketPath = socketPath; this.secretReader = secretReader; }
  call(operation, input) {
    const body = JSON.stringify({ operation, input });
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('runner_request_too_large');
    const secret = this.secretReader();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('runner_service_authentication_invalid');
    const signature = createHmac('sha256', secret).update('paperclip.ubuntu-runner-results\n' + body).digest('hex');
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, method: 'POST', path: '/api/v1/broker',
        headers: { 'x-paperclip-runner-plugin': 'paperclip.ubuntu-runner-results', 'x-paperclip-runner-signature': signature, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) response.destroy(new Error('runner_response_too_large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200) {
              const code = typeof value.error === 'string' && /^[a-z][a-z0-9_]{1,99}$/.test(value.error) ? value.error : 'broker_refused';
              return reject(new Error('runner_broker:' + code));
            }
            resolve(value);
          } catch { reject(new Error('runner_response_invalid')); }
        });
      });
      req.setTimeout(20_000, () => req.destroy(new Error('runner_broker_timeout')));
      req.on('error', reject); req.end(body);
    });
  }
}
