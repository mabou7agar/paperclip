import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { uuid } from './contracts.mjs';
import { PLUGIN_KEY, ENVELOPE_DOMAIN } from './native-contracts.mjs';

// Public binding only. Never mount a broker token, signing key or HMAC here.
export const TRUST_FILE = '/opt/paperclip-runner-trust/broker.json';
export async function loadTrust() {
  for (let current = TRUST_FILE; ; current = path.dirname(current)) {
    const st = await lstat(current);
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) ||
        (current === TRUST_FILE ? !st.isFile() || st.size > 8192 : !st.isDirectory())) {
      throw new Error('runner_native_trust_unsealed');
    }
    if (current === '/') break;
  }
  const value = JSON.parse(await readFile(TRUST_FILE, 'utf8'));
  if (!['pluginId,publicKey','brokerUserId,pluginId,publicKey'].includes(Object.keys(value).sort().join()) || !uuid(value.pluginId) ||
      (Object.hasOwn(value,'brokerUserId') && (typeof value.brokerUserId !== 'string' || !value.brokerUserId || value.brokerUserId.length > 160))) {
    throw new Error('runner_native_trust_invalid');
  }
  const publicKey = createPublicKey(value.publicKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('runner_native_trust_invalid');
  return { ...value, publicKey };
}

export function verifyEnvelope(envelope, context, trust) {
  if (context?.actor?.type !== 'user' || context.actor.userId !== trust.brokerUserId ||
      !uuid(context.companyId) || context.actor.companyId !== context.companyId) throw new Error('runner_native_envelope_invalid');
  const value = verifyBrokerEnvelope(envelope, trust);
  if (value.companyId !== context.companyId) throw new Error('runner_native_envelope_scope_invalid');
  return value;
}

/** Webhooks carry no board credential. Only the sealed root public key can
 * authenticate the broker output; request/task binding is checked by the client. */
export function verifyBrokerEnvelope(envelope, trust) {
  if (!envelope || Object.keys(envelope).sort().join() !== 'payload,signature' ||
      typeof envelope.payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) ||
      envelope.payload.length > 180000 || typeof envelope.signature !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('runner_native_envelope_invalid');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.toString('base64') !== envelope.payload || bytes.length > 128 * 1024 ||
      !verify(null, Buffer.concat([Buffer.from(ENVELOPE_DOMAIN), bytes]), trust.publicKey,
        Buffer.from(envelope.signature, 'base64'))) throw new Error('runner_native_signature_invalid');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schema !== 'paperclip.runner-envelope.v1' || value.pluginKey !== PLUGIN_KEY ||
      value.pluginId !== trust.pluginId || !uuid(value.companyId) ||
      !['admission', 'result'].includes(value.kind) || !uuid(value.jobId) || !uuid(value.issueId) ||
      !uuid(value.agentId) || !uuid(value.projectId) || !/^[a-f0-9]{64}$/.test(value.requestDigest) ||
      !Number.isSafeInteger(value.sequence) || (value.kind === 'admission' ? value.sequence !== 0 : value.sequence <= 0)) {
    throw new Error('runner_native_envelope_scope_invalid');
  }
  return value;
}
