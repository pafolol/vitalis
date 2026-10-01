/**
 * Diagnostics: every result value carries a provenance tag so the UI and the
 * debrief can distinguish values *measured from the simulated physiology* from
 * findings *authored by the scenario* (e.g. a toxicology screen or CT report
 * that the physiology engine cannot compute).
 */

export type ResultSource = 'simulated' | 'derived' | 'authored';

export interface ResultItem {
  key: string;
  label: string;
  value: string;
  unit?: string;
  /** Reference range text */
  ref?: string;
  flag?: 'H' | 'L' | 'HH' | 'LL' | 'abnormal' | null;
  source: ResultSource;
  numeric?: number;
}

export interface DiagnosticOrder {
  id: string;
  testId: string;
  label: string;
  orderedAt: number;
  /** When the sample/acquisition happened (state captured at this time) */
  collectedAt: number;
  resultAt: number;
  status: 'pending' | 'resulted';
  items: ResultItem[];
  /** Free-text interpretation / report (imaging, ECG) */
  report?: string;
  /** Structured payload for rich viewers (e.g. 12-lead ECG parameters) */
  payload?: Record<string, unknown>;
}

export interface DiagnosticsState {
  orders: DiagnosticOrder[];
}
