/**
 * Which half of a split deployment a process is. The same vocabulary as every Agora library:
 *
 * - `'all'` (default): emit, forward, consume and run listeners. One process does everything.
 * - `'api'`: emit and forward through the selected transport, and hand listener work to it; never
 *   consume what other processes forward, never run a listener.
 * - `'worker'`: consume and run listeners. Diagnostics mounts no HTTP surface, so a worker does
 *   everything `'all'` does; the role exists so one setting drives every library of the app.
 */
export type DiagnosticsRole = 'all' | 'api' | 'worker';

const ROLES: readonly DiagnosticsRole[] = ['all', 'api', 'worker'];

/** Which half this process is. Defaults to running both. */
export function resolveRole(config: { role?: DiagnosticsRole | undefined }): DiagnosticsRole {
  const role = config.role ?? 'all';
  if (!ROLES.includes(role)) {
    throw new Error(
      `@adonis-agora/diagnostics: config.role must be 'all', 'api' or 'worker' (got ${JSON.stringify(role)})`,
    );
  }
  return role;
}

/**
 * Splitting `'api'` from `'worker'` only works when a transport carries events between the halves.
 * Without a `default` transport diagnostics is local to each process: an `'api'` process would
 * drop its listeners' work and a `'worker'` would never receive anything, so both are refused.
 */
export function assertRoleHasTransport(role: DiagnosticsRole, transport: string | undefined): void {
  if (role === 'all' || transport) return;
  throw new Error(
    `@adonis-agora/diagnostics: config.role is "${role}", which splits emitting from consuming — but no \`default\` transport is selected, so nothing carries events between the two halves. Select a transport with \`default\`, or drop \`role\`.`,
  );
}
