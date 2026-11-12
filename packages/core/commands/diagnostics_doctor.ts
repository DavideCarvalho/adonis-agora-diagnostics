import AgoraDoctor from './agora_doctor.js';

/** `node ace diagnostics:doctor`: `agora:doctor` for `@adonis-agora/diagnostics` only. */
export default class DiagnosticsDoctor extends AgoraDoctor {
  static override commandName = 'diagnostics:doctor';
  static override description = 'Check the @adonis-agora/diagnostics configuration';
  protected override presetLib: string | undefined = 'diagnostics';
}
