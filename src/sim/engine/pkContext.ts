import { clamp } from '../core/math';
import type { PkContext } from '../pharmacology/types';
import type { EngineState } from './state';

export function buildPkContext(s: EngineState): PkContext {
  const { phys, patient } = s;
  return {
    weightKg: patient.weightKg,
    ageYears: patient.ageYears,
    renalFactor: clamp(phys.renal.gfr / (110 * (patient.bsa / 1.73)), 0.02, 1.4),
    hepaticFunction: patient.baseline.hepaticFunction,
    hepaticFlowFactor: Number(s.detectors['hepaticFlow'] ?? 1),
    peripheralPerfusion: phys.cv.peripheralPerfusion,
    temperatureC: phys.thermo.core,
    airflowFactor: phys.resp.airflowFactor,
  };
}
