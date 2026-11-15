import { request } from 'node:http';
import { BROKER_SOCKET, MAX_BYTES } from './configuration.mjs';

export class BrokerClient {
  constructor(socketPath = BROKER_SOCKET) { this.socketPath = socketPath; }
  call(operation, input) {
    const body = JSON.stringify({ operation, input });
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('runner_request_too_large');
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, method: 'POST', path: '/api/v1/broker',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) response.destroy(new Error('runner_response_too_large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('runner_broker_refused'));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('runner_response_invalid')); }
        });
      });
      req.setTimeout(20_000, () => req.destroy(new Error('runner_broker_timeout')));
      req.on('error', reject); req.end(body);
    });
  }
}
