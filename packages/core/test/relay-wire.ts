import { relayKey, signFrame } from '../src/transports/relay_auth.js';

/** The app key the tests' relays share. */
export const TEST_APP_KEY = 'diagnostics-test-app-key-0123456789';

const redisKey = relayKey({ appKey: TEST_APP_KEY }, 'redis:agora:diagnostics:relay', 'test');
const queueKey = relayKey({ appKey: TEST_APP_KEY }, 'queue:agora.diagnostics.event', 'test');

/** A Redis relay message as another process of the same app would publish it. */
export function wire(node: string, env: unknown): string {
  return JSON.stringify(signFrame(redisKey, node, env));
}

/** A queue job payload as another process of the same app would dispatch it. */
export function jobPayload(node: string, env: unknown) {
  return signFrame(queueKey, node, env);
}
