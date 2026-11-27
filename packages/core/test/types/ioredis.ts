/**
 * Compile-time regression test, type-checked by `test/redis-like-typecheck.spec.ts`: real ioredis 6
 * and ioredis 5 clients are accepted as `RedisLike`.
 */
import { Redis } from 'ioredis';
import { Redis as Redis5 } from 'ioredis5';
import { createDiagnosticsRedisRelay, type RedisLike } from '../../src/index.js';

const pub = new Redis({ lazyConnect: true });
createDiagnosticsRedisRelay({ pub, sub: pub.duplicate(), all: true });

const pub5 = new Redis5({ lazyConnect: true });
createDiagnosticsRedisRelay({ pub: pub5, sub: pub5.duplicate(), all: true });

export const clients: RedisLike[] = [pub, pub5];
