import type { RedisLike, RedisPipelineLike } from '../src/transports/redis.js';

/** Shared in-memory pub/sub hub. FakeRedis clients on the same hub deliver to each other
 *  synchronously — simulating separate processes/connections in tests. */
export class FakeHub {
  readonly clients = new Set<FakeRedis>();
  publish(channel: string, message: string): void {
    for (const c of [...this.clients]) c._deliver(channel, message);
  }
}

export class FakeRedis implements RedisLike {
  private readonly channels = new Set<string>();
  private readonly listeners = new Set<(channel: string, message: string) => void>();
  public publishCount = 0;
  /** Number of pipelines executed — each one is a single round trip carrying several publishes. */
  public pipelineExecCount = 0;

  constructor(private readonly hub: FakeHub) {
    hub.clients.add(this);
  }

  publish(channel: string, message: string): number {
    this.publishCount += 1;
    this.hub.publish(channel, message);
    return 1;
  }
  pipeline(): RedisPipelineLike {
    const queued: Array<[string, string]> = [];
    const pipeline: RedisPipelineLike = {
      publish: (channel, message) => {
        queued.push([channel, message]);
        return pipeline;
      },
      exec: () => {
        this.pipelineExecCount += 1;
        for (const [channel, message] of queued) this.hub.publish(channel, message);
        return Promise.resolve(queued.map(() => [null, 1]));
      },
    };
    return pipeline;
  }
  subscribe(channel: string, callback?: (err: Error | null, count: number) => void): void {
    this.channels.add(channel);
    callback?.(null, this.channels.size);
  }
  unsubscribe(channel: string): void {
    this.channels.delete(channel);
  }
  on(_event: 'message', listener: (channel: string, message: string) => void): void {
    this.listeners.add(listener);
  }
  removeListener(_event: 'message', listener: (channel: string, message: string) => void): void {
    this.listeners.delete(listener);
  }
  /** Hub callback: deliver to this client's message listeners only if subscribed to the channel. */
  _deliver(channel: string, message: string): void {
    if (!this.channels.has(channel)) return;
    for (const l of [...this.listeners]) l(channel, message);
  }
}
