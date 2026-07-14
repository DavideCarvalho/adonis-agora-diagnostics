/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.2.2';

export {
  type CapabilityOf,
  type CapabilityRegistry,
  capability,
} from './capability.js';
export {
  CHANNEL_PREFIX,
  channelName,
  emit,
  EMIT_SLOT,
  getChannel,
  SCHEMA_VERSION,
} from './channel.js';
export { claimDiagnostics, isDiagnosticClaimed } from './claims.js';
export { assertCapabilityNaming } from './conformance.js';
export {
  type DiagnosticsConfig,
  defineConfig,
  type QueueTransportConfig,
  type RedisTransportConfig,
  type TransportContext,
  type TransportProvider,
  transports,
} from './define_config.js';
export {
  CONTEXT_ACCESSOR,
  type ContextAccessor,
  type ContextStore,
  getContextAccessor,
  resolveTraceId,
  setContextAccessor,
  type UserRef,
} from './context_accessor.js';
export {
  onChannelRegistered,
  registerChannel,
  registeredChannels,
  resetRegistry,
} from './registry.js';
export {
  type ChannelRef,
  type ChannelSelection,
  type ChannelSelector,
  createChannelSelector,
  parseChannelName,
} from './relay.js';
export {
  type DiagnosticHandler,
  onDiagnostic,
  type OnDiagnosticOptions,
  unsubscribeAll,
} from './subscriber.js';
export {
  SPAN_SCHEMA_VERSION,
  trace,
  type TraceChannelNames,
  traceChannelNames,
  type TracingChannel,
  tracingChannel,
} from './trace.js';
export {
  createDiagnosticsRedisRelay,
  type DiagnosticsRedisRelayOptions,
  type RedisLike,
} from './transports/redis.js';
export {
  bindRelayReEmitter,
  createDiagnosticsQueueRelay,
  type DiagnosticsEventEnvelope,
  type DiagnosticsEventJobLike,
  type DiagnosticsQueueRelayOptions,
  getActiveReEmitter,
  type RelayReEmitter,
} from './transports/queue.js';
export type {
  ChannelRegistry,
  DiagnosticEvent,
  EmitOptions,
  EventOf,
  LibOf,
  PayloadOf,
  SpanEvent,
  SpanPhase,
  TraceOptions,
} from './types.js';
