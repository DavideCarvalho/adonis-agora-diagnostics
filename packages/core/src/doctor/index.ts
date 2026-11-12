import { diagnosticsDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { diagnosticsDoctorChecks } from './checks.js';

/** The diagnostics doctor checks, read by `agora:doctor --no-boot`. */
export const agoraDoctorChecks = diagnosticsDoctorChecks();
