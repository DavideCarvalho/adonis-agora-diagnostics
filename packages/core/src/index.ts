/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.2.8';

// Re-export the configure hook from the package root so `node ace configure` finds it
export { configure } from '../configure.js';
export {
  type CapabilityOf,
  type CapabilityRegistry,
  capability,
} from './capability.js';
export {
  CHANNEL_PREFIX,
  channelName,
  EMIT_SLOT,
  emit,
  getChannel,
  SCHEMA_VERSION,
} from './channel.js';
export { claimDiagnostics, isDiagnosticClaimed } from './claims.js';
export { assertCapabilityNaming } from './conformance.js';
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
  type DiagnosticsConfig,
  defineConfig,
  type QueueTransportConfig,
  type RedisTransportConfig,
  type TransportContext,
  type TransportProvider,
  transports,
} from './define_config.js';
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
  type OnDiagnosticOptions,
  onDiagnostic,
  unsubscribeAll,
} from './subscriber.js';
export {
  SPAN_SCHEMA_VERSION,
  TRACE_SLOT,
  type TraceChannelNames,
  type TracingChannel,
  trace,
  traceChannelNames,
  tracingChannel,
} from './trace.js';
export {
  bindRelayReEmitter,
  createDiagnosticsQueueRelay,
  type DiagnosticsEventEnvelope,
  type DiagnosticsEventJobLike,
  type DiagnosticsQueueRelayOptions,
  getActiveReEmitter,
  type RelayReEmitter,
} from './transports/queue.js';
export {
  createDiagnosticsRedisRelay,
  type DiagnosticsRedisRelayOptions,
  type RedisLike,
} from './transports/redis.js';
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
