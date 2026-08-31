import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChannel } from '../src/channel.js';
import { resetRegistry } from '../src/registry.js';
import DiagnosticsEventJob from '../src/transports/diagnostics_event_job.js';
import { createDiagnosticsQueueRelay } from '../src/transports/queue.js';
import type { DiagnosticEvent } from '../src/types.js';
import { FakeJob } from './fake-queue.js';

/** Hydrate the real job the way a worker would, then run its `execute()`. */
async function runJob(envelope: { node: string; env: DiagnosticEvent }) {
  const job = new DiagnosticsEventJob();
  job.$hydrate(envelope, {
    jobId: 'j1',
    name: 'agora.diagnostics.event',
    attempt: 1,
    queue: 'default',
    priority: 5,
    acquiredAt: new Date(),
    stalledCount: 0,
  });
  await job.execute();
}

describe('DiagnosticsEventJob', () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const t of teardowns.splice(0)) t();
    resetRegistry();
  });

  it('has a stable job name', () => {
    expect(DiagnosticsEventJob.options.name).toBe('agora.diagnostics.event');
  });

  it('re-emits onto the local bus when a relay is bound', async () => {
    teardowns.push(
      createDiagnosticsQueueRelay({ job: new FakeJob(), libs: ['authz'], nodeId: 'A' }),
    );
    const local = vi.fn();
    getChannel('authz', 'decision').subscribe((m) => local(m));

    const env: DiagnosticEvent = {
      ts: 1,
      lib: 'authz',
      event: 'decision',
      payload: { allow: true },
    };
    await runJob({ node: 'OTHER', env });

    expect(local).toHaveBeenCalledTimes(1);
    expect((local.mock.calls[0]?.[0] as DiagnosticEvent | undefined)?.payload).toEqual({
      allow: true,
    });
  });

  it('is a no-op (does not throw) when no relay is bound in the process', async () => {
    const env: DiagnosticEvent = { ts: 1, lib: 'authz', event: 'decision', payload: {} };
    await expect(runJob({ node: 'OTHER', env })).resolves.toBeUndefined();
  });
});
