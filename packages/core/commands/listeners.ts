import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { DiagnosticsConfig } from '../src/define_config.js';
import { listListeners } from '../src/dev_tools/tools.js';

/**
 * `node ace diagnostics:listeners:list [--lib=durable] [--page=1] [--size=50] [--json]` — the app's
 * listeners (`@OnDiagnostic` classes and `onDiagnostic` references) and the transport that runs
 * them. Same data as the `diagnostics_list_listeners` dev tool.
 *
 * Boots the app (`startApp`) because listeners are discovered when the provider is ready.
 */
export default class DiagnosticsListenersList extends BaseCommand {
  static override commandName = 'diagnostics:listeners:list';
  static override description = 'List the diagnostics listeners and the transport that runs them';
  static override options: CommandOptions = { startApp: true };

  declare lib?: string;
  declare page?: number;
  declare size?: number;
  declare json?: boolean;

  static {
    DiagnosticsListenersList.defineFlag('lib', {
      type: 'string',
      description: "Only listeners of this library ('durable', 'authkit'…)",
    });
    DiagnosticsListenersList.defineFlag('page', {
      type: 'number',
      description: 'Page number, from 1 (default 1)',
    });
    DiagnosticsListenersList.defineFlag('size', {
      type: 'number',
      description: 'Listeners per page (default 50, at most 1000)',
    });
    DiagnosticsListenersList.defineFlag('json', { type: 'boolean', description: 'Print JSON' });
  }

  override async run(): Promise<void> {
    const page = this.page ?? 1;
    const size = this.size ?? 50;
    if (!Number.isInteger(page) || page < 1) {
      return this.fail('--page must be an integer of at least 1');
    }
    if (!Number.isInteger(size) || size < 1 || size > 1000) {
      return this.fail('--size must be an integer between 1 and 1000');
    }

    const lib = this.lib?.trim() || undefined;
    const { transport, items } = listListeners(
      { config: () => this.app.config.get<DiagnosticsConfig>('diagnostics', {}) ?? {} },
      lib !== undefined ? { lib } : {},
    );
    const data = items.slice((page - 1) * size, page * size);
    const meta = { total: items.length, page, size, hasNext: page * size < items.length };

    if (this.json) {
      this.logger.log(JSON.stringify({ transport, data, meta }, null, 2));
      return;
    }

    const runs = transport.name === null ? 'in-process (no transport)' : transport.name;
    this.logger.info(`Transport: ${runs} (${transport.kind}) · role: ${transport.role}`);
    if (data.length === 0) {
      this.logger.info(
        items.length === 0
          ? 'No listeners.'
          : `No listeners on page ${page} (${items.length} in all).`,
      );
      return;
    }
    const table = this.ui.table();
    table.head(['Id', 'Lib', 'Event', 'Method']);
    for (const listener of data) {
      table.row([listener.id, listener.lib, listener.event, listener.method]);
    }
    table.render();
    if (meta.hasNext) {
      this.logger.info(`${items.length} listeners in all: next page with --page=${page + 1}.`);
    }
  }

  private fail(message: string): void {
    this.logger.error(message);
    this.exitCode = 1;
  }
}
