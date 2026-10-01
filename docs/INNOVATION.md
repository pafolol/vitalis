# Vitalis — Innovation Statement

**A 3D human on the web whose every movement is computed from a live physiological simulation.**

## What is new

Most virtual patients are decision trees with a character on top: the learner picks an option, a branch plays, and the vital signs are numbers an author typed in. Vitalis removes the tree. A deterministic physiology engine runs in the browser ten times per second, and everything the learner sees is derived from its state.

- **The body is animated by physiology, not keyframes.** Breathing rate, depth and left–right chest asymmetry, skin pallor, cyanosis, sweat and rash, facial expression, pupil size, tremor, seizures and the jolt of a defibrillator shock are all driven by the simulation. So is the internal anatomy: the heart beats and each lung inflates at the simulated rates, and a collapsed lung visibly stops moving.
- **The patient is generated, and arrives in a computed state.** A seed produces a person with their own body shape, history and resting physiology. The engine then simulates the hours before arrival, so the presentation is an outcome of the model.
- **Wrong treatment fails for the right reason.** Nothing is scripted, so a tourniquet on the wrong leg does not stop bleeding, and adrenaline injected into muscle works slowly in a patient with poor circulation.
- **AI that cannot change the outcome.** A language model voices the patient, tutors, writes new cases and narrates the debrief. It only produces text. It is told what the patient could know or feel, never the diagnosis, and cases it writes must pass the simulator's own validator before they can run. The biology stays deterministic: the same seed and the same actions always give the same case.

## How it is built

The engine, the pharmacology (about 50 drugs) and 14 composable disease mechanisms are written in TypeScript and run in a Web Worker. The 3D layer uses Three.js through React Three Fiber: a human built per patient from MakeHuman data, with 191 BodyParts3D anatomical structures fitted to that body. The OpenAI Responses API is called from a small Node server with strict structured outputs. Without a server the simulator still runs, using scripted fallbacks.

## Potential impact

High-fidelity patient simulation normally needs a manikin, a simulation centre and an instructor. Vitalis needs a browser. A student can meet a deteriorating patient at home, make mistakes safely, replay the same case with a different decision and see exactly what changed. Because cases are data and the AI can draft them within validated limits, an instructor can describe a scenario in a sentence and get a runnable case.

The same approach applies to nursing and paramedic training, pharmacology teaching and patient education. The engine sits behind an interface, so a validated engine such as Pulse could replace it without changing the 3D or AI layers.

## Limits

Vitalis is an educational prototype. Its physiology is simplified and not clinically validated, and it must not be used for decisions about real patients.
