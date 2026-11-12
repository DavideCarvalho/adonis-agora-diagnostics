import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import DiagnosticsDoctor from './diagnostics_doctor.js';

/**
 * The commands barrel for `@adonis-agora/diagnostics`, registered in `adonisrc.ts` with
 * `rcFile.addCommand('@adonis-agora/diagnostics/commands')` (done by `configure`).
 */
const loader = new ListLoader([AgoraDoctor, DiagnosticsDoctor]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
