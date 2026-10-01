export const FPS = 30;

/** A stretch of a recorded clip (seconds in the source), or a held still frame. */
export type Part = { from: number; to: number; rate?: number } | { at: number; hold: number };

export interface Scene {
  clip: string;
  title: string;
  text: string;
  parts: Part[];
}

export const partFrames = (p: Part) => ('hold' in p ? Math.round(p.hold * FPS) : Math.max(1, Math.round(((p.to - p.from) / (p.rate ?? 1)) * FPS)));
export const sceneFrames = (s: Scene) => s.parts.reduce((n, p) => n + partFrames(p), 0);

export const INTRO = Math.round(4.5 * FPS);
export const OUTRO = Math.round(9 * FPS);

export const SCENES: Scene[] = [
  {
    clip: 'clips/01-start.mp4',
    title: 'Pick a case, or let AI write one',
    text: '19 library cases. AI-written cases must pass the simulator’s own validator before they can run.',
    parts: [{ from: 0.3, to: 11 }, { at: 33.6, hold: 5 }],
  },
  {
    clip: 'clips/02-arrival.mp4',
    title: 'The patient arrives',
    text: 'The hours before arrival are simulated, so this patient’s state is computed, not scripted. The diagnosis is hidden.',
    parts: [{ from: 0.3, to: 24.5 }],
  },
  {
    clip: 'clips/03-monitor-exam.mp4',
    title: 'Monitor and examine',
    text: 'Vital signs only appear once sensors are attached. Examination findings describe the patient right now.',
    parts: [{ from: 18.5, to: 35.9 }, { at: 35.9, hold: 3 }],
  },
  {
    clip: 'clips/04-auscultate.mp4',
    title: 'Listen to the chest',
    text: 'Click the 3D body with the stethoscope. Breath sounds come from the simulated airways: here, wheeze.',
    parts: [{ from: 2, to: 24 }],
  },
  {
    clip: 'clips/05-talk.mp4',
    title: 'Talk to the patient',
    text: 'An AI patient answers in character, limited by how breathless he is. It never reveals the diagnosis.',
    parts: [{ from: 25, to: 38.7 }, { at: 38.7, hold: 6 }],
  },
  {
    clip: 'clips/06-treat.mp4',
    title: 'Treat',
    text: 'Adrenaline into muscle and high-flow oxygen. Dose, route and blood flow all change how fast a drug works.',
    parts: [{ from: 22, to: 38.2 }, { at: 38.2, hold: 2 }],
  },
  {
    clip: 'clips/07-response.mp4',
    title: 'Watch the response',
    text: 'Time runs at 10×. As the drug is absorbed, blood pressure recovers from 85/48 to 116/69.',
    parts: [{ from: 24, to: 55.6 }],
  },
  {
    clip: 'clips/08-anatomy.mp4',
    title: 'Look inside',
    text: 'Anatomy layers fitted to this patient. The heart beats and the lungs inflate at the simulated rates.',
    parts: [{ from: 33.5, to: 65.8 }, { at: 65.8, hold: 2 }],
  },
  {
    clip: 'clips/09-tests.mp4',
    title: 'Order tests',
    text: 'Blood gas and 12-lead ECG. Samples reflect the moment they were taken; results arrive after realistic delays.',
    parts: [{ from: 39, to: 46 }, { from: 46, to: 54, rate: 4 }, { from: 54, to: 75 }, { at: 75, hold: 3 }],
  },
  {
    clip: 'clips/10-debrief.mp4',
    title: 'Debrief',
    text: 'Commit to a diagnosis, then review each decision with its measured effect, what was missed, and an AI narrative.',
    parts: [{ from: 2, to: 8.4 }, { at: 8.4, hold: 3.5 }, { from: 8.4, to: 12.6 }, { at: 12.7, hold: 4 }, { from: 19.5, to: 22 }, { from: 22, to: 44.2, rate: 8 }, { from: 44.2, to: 46.9 }, { at: 46.9, hold: 6 }],
  },
  {
    clip: 'clips/11-arrest.mp4',
    title: 'Another case: cardiac arrest',
    text: 'CPR, then a 200 J shock. Whether the heart restarts depends on the simulated state of the heart muscle.',
    parts: [{ from: 1, to: 19.6 }, { at: 19.6, hold: 1.5 }],
  },
];

export const totalFrames = INTRO + SCENES.reduce((n, s) => n + sceneFrames(s), 0) + OUTRO;
