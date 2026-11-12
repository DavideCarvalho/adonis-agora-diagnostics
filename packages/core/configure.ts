import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/diagnostics` — auto-wires the package:
 *
 * 1. registers the service provider in `adonisrc.ts`;
 * 2. publishes `config/diagnostics.ts` (OTel + cross-process transports);
 * 3. publishes `start/diagnostics.ts` (where handlers are registered) and
 *    registers it as a preload file;
 * 4. registers the commands (`agora:doctor`, `diagnostics:doctor`).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/diagnostics/diagnostics_provider');
    rcFile.addPreloadFile('#start/diagnostics');
    rcFile.addCommand('@adonis-agora/diagnostics/commands');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/diagnostics.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'start/diagnostics.stub', {});
}
