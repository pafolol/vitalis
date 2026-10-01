# Vitalis — Physiology Model

> **Educational use only.** This is a teaching model, not a medical device. Parameters are calibrated so that behaviour is *qualitatively and semi-quantitatively* plausible (right direction, right order of magnitude, right time course). They are not validated against patient data. Never use the simulator for clinical decisions.

The engine (`src/sim`) is a deterministic lumped-parameter model written in TypeScript. It advances at a fixed `dt = 0.1 s`. Each organ system reads the shared `PhysiologyState` and writes its own part of it. Pathologies never set vital signs directly. Instead they write **modifiers** (`PhysiologyModifiers` in `src/sim/types.ts`), such as bleeding rate, SVR factor, airway resistance, capillary leak, pleural air rate, coronary flow and drive factor. Mechanisms then turn those modifiers into signs.

## 1. Patient generation and calibration

`generatePatient(seed, constraints)` (`src/sim/patient/generator.ts`) draws demographics, anthropometrics (height, weight, BMI, lean body mass), history, medications, allergies, social history and **baseline physiology** from a seeded RNG, conditioned on the scenario's constraints:

- Heart rate and blood pressure depend on age, fitness and hypertension.
- Contractility falls with heart failure or an old infarct.
- Airway resistance rises with COPD or asthma.
- Renal and hepatic function, haemoglobin, bicarbonate (raised with COPD retention), glucose (raised with diabetes), coronary reserve and shunt fraction are also set here.

`calibrate()` (`src/sim/physiology/init.ts`) then solves for internal parameters so that the patient's resting state is an equilibrium:

- **Circulation:** SVR, compliances, unstressed volumes, Starling curves and MSFP.
- **Respiration:** VE₀, PaCO₂ set-point and CO₂ transfer.
- **Fluids:** Starling offsets, so that net filtration is zero at baseline.
- **Glucose:** hepatic output equals uptake.

This is why each generated person starts stable on their own terms. For example, a patient with COPD starts with a raised PaCO₂ and HCO₃⁻ and a low-normal SpO₂.

## 2. Cardiovascular (`cardiovascular.ts`)

**Circulation.** Two-sided Guyton model, integrated with ≥ 4 sub-steps per tick:

- Mean systemic filling pressure: `MSFP = (V_sys − V_unstressed) / C_sys`
- Venous return: `VR = (MSFP − RAP) / RVR`
- Stroke volume: `SV = SVmax · contractility · g(P_fill) · afterload · f_HR · f_rhythm`, where `g(P) = P² / (P² + P50²)` is a Frank–Starling curve.
  - RV filling pressure is transmural (`RAP − P_intrathoracic`), so tension pneumothorax, PEEP and auto-PEEP reduce preload.
  - LV filling pressure is LAP, from the volume of the pulmonary pool.
- RAP is solved by bisection so that RV output equals venous return. The pulmonary pool integrates `Q_R − Q_L`, so:
  - LV failure raises LAP, which leads to lung water.
  - RV infarction lowers LAP while RAP stays high.
- Pressures: `MAP = CO · SVR + RAP`. `PP = SV / C_art`, where arterial compliance falls at higher distending pressure and with α-tone, and PP widens with β1-driven ejection. `DBP = MAP − PP/3`.
- Diastolic filling time limits output at high rates. Fitter patients tolerate faster rates.

**Sinus rate.** `HR0 · (1 + 1.4 ΔE_β1) · e^{−0.7 ΔV}`, where ΔV is the change in vagal tone. The rate is then modified by:

- temperature (+8 %/°C);
- calcium-channel blockade, amiodarone and ketamine;
- hypoxia (bradycardia at PaO₂ < 35 mmHg);
- myocardial viability.

The rate saturates with a soft knee above 60 % of the age-predicted maximum, so pathological sinus tachycardia plateaus rather than reaching exercise rates.

**Contractility.** Scaled by:

- β1 activation;
- acidosis (pH < 7.2), ionised hypocalcaemia and hypothermia;
- territorial ischaemia and infarction;
- negative inotropes and post-arrest stunning.

**Vascular tone.**

- `SVR = SVR₀ · (1 + 2.2 ΔE_α1·responsiveness)(1 + 1.2 V1)(1 − 0.35 ΔE_β2) …`. Further terms cover propofol, calcium-channel blockers, nitrates, magnesium, blood viscosity (Hct^0.55) and temperature.
- `responsiveness` falls with septic vasoplegia, anaphylaxis and acidaemia, so vasopressors are less effective in exactly those states.
- α1 activity and nitrates also change unstressed volume (venoconstriction or venodilation). Backrest angle and passive leg raise shift volume between the stressed and unstressed pools.
- PVR rises with alveolar hypoxia (hypoxic pulmonary vasoconstriction), acidaemia and lung collapse.

**Coronary circulation.** Each territory (LAD 45 %, LCx 25 %, RCA 30 % of the LV) has:

- supply ∝ `CPP/CPP₀ · reserve · occlusion · CaO₂`, where `CPP = DBP − max(RAP, 0.7·LAP)`;
- demand ∝ the rate–pressure product.

The supply/demand ratio then drives:

- **Ischaemia**, with first-order dynamics.
- **Infarction**, which accrues slowly while ischaemia exceeds about 0.35. Reperfusion stops it.
- **Troponin**, released into a pool and appearing with slow kinetics (a rise over hours, not minutes).
- **ECG changes:** ST elevation in the leads over the territory and reciprocal depression, Q waves, and hyperkalaemic T/P/QRS/PR changes. Hypokalaemia produces U waves, and QTc is prolonged by amiodarone, hypocalcaemia and hypothermia.

Global energetic **myocardial viability** falls when supply is below about 35 % of demand, for example in untreated VF or severe hypoxaemia. It feeds the rhythm hazards and the chance of defibrillation success.

**CPR.** Forward flow ≈ `quality · 0.3 · CO₀`, scaled by volume and reduced by raised intrathoracic pressure. Quality comes from the measured rate and depth, and pauses reduce it. CPP, EtCO₂ and myocardial viability follow from that flow.

## 3. Rhythm (`rhythm.ts`)

The rhythm is a state machine: sinus, AF, SVT, VT, VF, asystole, complete heart block and paced. Each rhythm has its own ventricular rate and stroke-volume factor.

- **Transitions** are hazards sampled from a seeded RNG. They depend on:
  - ischaemia and myocardial viability;
  - hyperkalaemia and hypokalaemia;
  - hypothermia below 30 °C;
  - hypoxia and acidosis;
  - drugs (amiodarone, magnesium, calcium membrane stabilisation).
- **PEA is emergent, not a rhythm.** It appears when an organised rhythm produces SBP < 50 or CO < 0.6 L/min.
- **Shock success** depends on energy, rhythm duration, viability, potassium, temperature and amiodarone. A synchronised shock is required for organised tachycardias, and a shock does not convert asystole.
- **Adenosine** terminates re-entrant SVT with a probability that depends on the effect-site concentration at its peak.
- **Transcutaneous pacing** captures when the current exceeds a per-patient threshold, which rises with hyperkalaemia. Mechanical capture also requires myocardial viability.

## 4. Autonomic control (`autonomic.ts`)

Sympathetic outflow is set by:

- the baroreflex (−2 × fractional MAP error) and low-pressure receptors (RAP);
- the chemoreflex (hypoxaemia, hypercapnia, acidaemia);
- pain, anxiety, dyspnoea, hypoglycaemia, cold, withdrawal and seizures;
- pathology input, such as sepsis.

It is depressed by sedation and severe brain injury. Vagal tone mirrors the baroreflex, and nausea and vasovagal inputs add to it.

**Arousal (central command).** Pain, fear, air hunger and withdrawal form a "stress" signal that:

- withdraws vagal tone. Baroreflex and arousal withdrawal are not additive: the stronger one prevails, so a hypotensive, frightened patient is not doubly tachycardic;
- slightly resets the baroreflex upward, which lets a distressed patient be tachycardic and mildly hypertensive rather than having the reflex buffer it away. The reset never amplifies the response to hypotension.

**Endogenous catecholamine tone** goes through the same receptor channels as drugs (§7): neuronal noradrenaline acts on α1, β1 and β2, plus adrenal adrenaline released during hypoglycaemia or extreme stress. As a result:

- β-blockers blunt compensatory tachycardia;
- exogenous catecholamines add to the endogenous tone rather than replacing it;
- a patient on β-blockers hides the tachycardia of hypovolaemia.

## 5. Respiratory (`respiratory.ts`)

**Pleura.** Each hemithorax (~2.6 L, scaled by height) collects air and blood from the pathology rates. Positive-pressure ventilation triples the leak rate.

- Lung expansion is `1 − 1.15·occupancy`.
- Occupancy above ~45 % produces tension: up to +20 mmHg of intrathoracic pressure, felt by the heart as obstructive shock.
- A needle decompression vents the pleura to about 25 % occupancy. It can kink or occlude (a hazard), and the wrong site or side does not help.
- A chest drain removes air and drains blood, and the drain output is recorded.

**Upper airway.**

- Patency is `(1 − tongue)(1 − oedema)(1 − vomit)(1 − seizure)`.
- Tongue obstruction depends on consciousness and neuromuscular block. Manoeuvres and adjuncts relieve it.
- An OPA is rejected by a patient with intact reflexes.
- Stridor emerges from upper-airway oedema.

**Mechanics.**

- Resistance: `R = R₀(1 + spasm + fixed)`, where spasm is relieved by β2 agonists (systemic and nebulised lung depot), antimuscarinics, magnesium and ketamine.
- Compliance falls with lung water, collapse and obesity.
- Lung water has two sources:
  - hydrostatic, from `smoothstep(LAP 18→32 mmHg)`;
  - pathological (pneumonia, ARDS-like leak, aspiration).

**Control of breathing.** The chemical drive combines:

- central CO₂, around the patient's own set-point;
- [H⁺], using the patient's baseline so that chronic compensation is honoured;
- hypoxic drive.

The drive is capped at about 8× (MVV) and lags by a few seconds. It is then:

- increased by pulmonary irritant receptors (bronchoconstriction) and J-receptors (interstitial lung water), which also favour a faster rate. This gives the early tachypnoea with a normal or low PaCO₂ seen in asthma, pulmonary oedema and pneumonia;
- multiplied by pain, anxiety, fever and withdrawal;
- **depressed by μ-opioids and GABAergic drugs** through a Minto-type interaction (`U = C_μ/EC50_μ + C_GABA/EC50_GABA`), which reproduces opioid–benzodiazepine synergy;
- abolished by neuromuscular block, severe brain injury and arrest (agonal breathing → apnoea).

**Achieved ventilation.** `VE = smooth-min(VE_demand, VE_max)`.

- `VE_max ∝ fitness · size / R^0.9 · compliance^0.4 · (1 − fatigue)`. This is expiratory flow limitation: an asthmatic patient cannot "just breathe more".
- Respiratory rate follows achieved ventilation plus "air hunger", with a ceiling set by resistance and compliance.
- Fatigue accumulates while the work of breathing stays high, and faster when hypoxaemic or acidaemic. Rising PaCO₂ in a tiring asthmatic is therefore a late, ominous sign.

**Delivered ventilation.**

- Spontaneous breathing is scaled by airway patency.
- A bag-valve mask depends on seal, which depends on patency and oedema.
- A ventilator (VC mode, rate, VT, PEEP, FiO₂) is used only with a secured airway.
- Auto-PEEP ∝ `(R − 1.6)·VE`, and is worse with high set rates.
- Plateau, peak and mean airway pressures are computed. Mean airway pressure raises intrathoracic pressure, so over-bagging a hypovolaemic or asthmatic patient drops their blood pressure.

**Gas exchange** (after the circulation step):

- **O₂.** FiO₂ comes from the device model: nasal cannula, simple mask and NRB are entrained according to minute ventilation, and HFNO has its own model.
  - FRC acts as an **alveolar O₂ store** that integrates `V_A·(FiO₂ − F_AO₂) − uptake`. This gives realistic apnoeic desaturation, a benefit from pre-oxygenation, and apnoeic oxygenation with a patent airway.
  - Arterial content: `CaO₂ = (1 − Qs − Qm)·Cc' + Qm·C_lowVQ + Qs·C_vO₂`.
    - Qs is shunt, from lung water, collapse and aspiration, reduced by recruitment with PEEP.
    - Qm is V/Q mismatch, from bronchospasm and pathology.
    - A diffusion limitation applies when there is lung water.
  - PaO₂ is back-calculated from content, and SaO₂ uses Severinghaus/Kelman with pH, temperature and PCO₂ shifts.
  - Venous O₂ content integrates delivery minus consumption, giving SvO₂.
- **CO₂.**
  - A body/venous CO₂ store integrates production minus elimination.
  - Elimination is perfusion–ventilation limited: `P_A = g·Q·P_v / (g·Q + V_A')`.
  - Alveolar dead space rises as pulmonary flow falls. So EtCO₂ collapses during low-flow states, tracks CPR quality, and jumps at ROSC, while PaCO₂ rises in hypoventilation.

## 6. Fluids, blood, kidneys and coagulation (`fluids.ts`)

**Compartments.** Plasma, red-cell volume, interstitial fluid (ISF) and intracellular fluid (ICF), with solute masses (Na, K, Cl, HCO₃, glucose) and protein.

**Starling exchange.**

- Filtration: `J = Kf·leak·[(Pc − Pif) − σ(πp − πi)] − lymph`.
- Capillary pressure follows arterial and venous pressures. Oncotic pressure uses the Landis–Pappenheimer polynomial.
- Consequences:
  - crystalloid redistributes, with about ¼ remaining intravascular after an hour;
  - albumin stays longer;
  - sepsis and anaphylaxis leak through `σ` and `Kf`;
  - after haemorrhage, the ISF refills plasma, so haemodilution appears over time.
- Osmotic ECF ↔ ICF water shifts follow effective osmolality (e.g. hyperglycaemia).

**Infusions** carry their electrolyte, glucose, protein, red-cell, platelet and factor content, **and their temperature**: cold blood and room-temperature crystalloid cool the patient unless warmed. Lactate and acetate buffers become bicarbonate according to liver function. Citrate in blood products lowers ionised Ca.

**Haemorrhage** removes whole blood, consumes clotting factors, fibrinogen and platelets beyond dilution, and is reduced by:

- tourniquet, direct pressure, pelvic binder and surgical haemostasis, when applied to the right site;
- `clotEfficacy()`, a lethal-triad term covering acidosis, hypothermia, coagulopathy and platelets, with a TXA effect.

**Kidneys.**

- GFR is autoregulated over MAP 80–160 mmHg, falls with volume depletion and sympathetic tone, and carries an AKI factor that accrues with sustained hypoperfusion.
- Urine flow depends on GFR, volume and ADH (a Hct/osmolality proxy), with osmotic diuresis above the glucose threshold and natriuresis from loop diuretics.
- Creatinine and urea follow production/clearance kinetics. K⁺ excretion depends on GFR, and dialysis removes K⁺ and volume.

## 7. Pharmacology (`pharmacology/`)

**PK.** One- or two-compartment models (`V1`, `V2`, `Q`, `CL`) with an effect site (`ke0`), and about 50 drugs.

- **Clearance** scales with:
  - weight and age (−0.6 %/year over 40);
  - hepatic function and flow, for flow-limited drugs;
  - renal function via GFR;
  - temperature (−7 %/°C below 37).
- **Routes:**
  - IV/IO act immediately;
  - IM, SC, PO, IN and buccal use depots with first-order absorption `ka`. IM and SC absorption depend on **perfusion**, so it is slow in shock and in the cold;
  - nebulised drugs go into a lung depot with a local airway effect and systemic spill-over.
- Infusions take dose units (mcg/kg/min, mg/h, units/h …). Direct-chemistry agents (dextrose, KCl, Ca, NaHCO₃, Mg) add mass to the chemistry state.

**PD.** Drugs act on **channels**, including:

| Group | Channels |
|---|---|
| Adrenergic, vasopressin, muscarinic | α1, β1, β2, β2-airway, V1, muscarinic |
| Opioid, sedative, anaesthetic | μ, GABA, NMDA, propofol-CV |
| Neuromuscular | NM block |
| Antiarrhythmic and vasodilator | CCB, amiodarone, nitrate |
| Endocrine | insulin, glucagon, steroid |
| Anti-inflammatory, antiemetic, analgesic | antihistamine, antiemetic, antipyretic, analgesic |
| Blood | antiplatelet, anticoagulant, fibrinolytic, antifibrinolytic |
| Other | diuretic, antibiotic |

On each channel the agonists sum in potency-normalised units (Minto-type) and competitive antagonists divide them (naloxone at μ; metoprolol at β1/β2):

```
U = Σ Ce_i / EC50_i  ÷  (1 + Σ Ce_j / Ki_j)
E = Emax_mix · U^γ / (1 + U^γ)
```

- Endogenous tone enters the same sum (§4).
- Opioid tolerance scales the μ EC50.
- Aspirin irreversibly latches its antiplatelet effect.
- Antibiotics act on the sepsis pathogen load, weighted by spectrum and coverage.
- **Allergies** are checked on administration: an agent in the patient's allergy class triggers the anaphylaxis module.

**Examples of behaviour that emerges:**

- Naloxone reverses opioid depression, which wears off before long-acting opioids do (re-narcotisation).
- Midazolam plus fentanyl causes apnoea at doses that are safe alone.
- IM adrenaline works slowly in profound shock.
- Propofol at induction drops MAP in a hypovolaemic patient.
- Salbutamol lowers K⁺ and raises lactate slightly.
- Insulin drops K⁺ in about 15–30 min, but calcium does not lower K⁺: it stabilises the membrane.

## 8. Metabolism, glucose, electrolytes and acid–base (`metabolic.ts`)

**Oxygen and lactate.**

- **VO₂ demand** scales with temperature (Q10 ≈ 2), shivering, sympathetic tone, seizures, work of breathing and sepsis.
- **O₂ debt** (demand − supply) produces lactate. Hepatic clearance depends on flow and function.

**Acid–base.**

- Lactate and ketoacids consume bicarbonate. Lactate spreads over about 62 % of the ECF, and ketoacids are buffered 1:1.
- The CO₂ generated goes to the CO₂ store.
- The kidneys regenerate HCO₃⁻, with limited capacity.
- pH comes from Henderson–Hasselbalch using the simulated HCO₃⁻ and PaCO₂. Base excess uses Van Slyke, and the anion gap is computed.

**Glucose and insulin (Bergman-style).**

- Hepatic glucose output is split between glycogenolysis and gluconeogenesis. It is suppressed by insulin action and stimulated by catecholamines, glucagon and cortisol, and glycogen can be depleted.
- Brain uptake is insulin-independent. Other uptake depends on insulin through a remote-action compartment that lags plasma insulin.
- Glucose above the renal threshold is lost in urine, causing osmotic diuresis.
- Insulin deficiency drives ketogenesis (DKA).
- Counter-regulation raises glucose through adrenal adrenaline and glucagon.
- Hypoglycaemia leads to adrenergic symptoms (sweating, tremor, tachycardia) and then neuroglycopenia (confusion, seizures, coma).

**Potassium.** The ECF/ICF split is shifted by insulin, β2 activity, acidaemia and cell lysis, with a capped shift rate. Renal excretion depends on GFR.

## 9. Temperature, neuro and symptoms (`neuro.ts`)

**Temperature.**

- Core temperature integrates metabolic heat (VO₂ × 20.1 kJ/L) minus losses to the environment, which depend on skin perfusion, exposure, warming blankets, and the heat needed to warm infusions.
- The hypothalamic set-point is raised by pyrogens and lowered by antipyretics. The difference drives shivering or sweating.

**Consciousness.** Cerebral O₂ delivery comes from cerebral perfusion pressure (autoregulated above about 50 mmHg), CO₂ reactivity and CaO₂. It is combined with:

- glucose (neuroglycopenia) and hyperosmolality, and hypercapnic narcosis;
- temperature and sodium;
- drug effects (GABA, μ, NMDA, propofol);
- seizures and the post-ictal state;
- brain injury, which accrues from sustained cerebral hypoxia.

Consciousness maps to AVPU, GCS (E/V/M), pupils (opioid miosis, hypoxic or brain-injury dilatation, anticholinergic effects), airway reflexes, confusion, agitation and the ability to speak (full sentences, phrases, words or none, limited by breathlessness).

**Symptoms.** Pain, dyspnoea, nausea, anxiety, tremor and withdrawal are simulated states that feed the autonomic model, the AI patient context and the 3D facial expression. Vomiting can cause aspiration if airway reflexes are depressed.

## 10. Pathology modules (`src/sim/pathology/modules.ts`)

Each module has typed parameters (zod), its own internal state, an onset time relative to arrival, and a `step()` that writes modifiers. Modules compose: for example, an anaphylaxis can develop during a sepsis case.

| Module | Mechanism (writes) | Responds to |
|---|---|---|
| `hemorrhage` | Bleeding rate at a site (limbs, abdomen, pelvis, chest→pleural blood, external) × clot efficacy × MAP | Tourniquet/pressure/binder/surgery (site-specific), TXA, products, lethal triad |
| `anaphylaxis` | Mediator load → capillary leak, vasodilation, bronchospasm, upper-airway oedema, urticaria, low vasopressor responsiveness; biphasic potential | Adrenaline (α1/β2 and mast-cell stabilisation), fluids, antihistamine (skin only), steroid (late), airway |
| `asthma` | Airway resistance building up over time, V/Q mismatch, anxiety | β2 agonists (neb/IV), ipratropium, Mg, steroids (hours), ketamine, ventilation strategy |
| `opioidToxicity` | Heroin/methadone doses given through the real PK route (not "set RR = 6") | Naloxone (competitive, shorter half-life), ventilation |
| `sepsis` | Pathogen load vs immune clearance → inflammation → vasoplegia, leak, fever, lactate, low vasopressor response, AKI | Appropriate antibiotics (coverage/timing), fluids, noradrenaline/vasopressin, source |
| `hypoglycemia` | Insulin/sulfonylurea excess via insulin PK | Dextrose (IV), glucose gel (if swallowing), glucagon (needs glycogen) |
| `dka` | Absolute insulin deficiency → hyperglycaemia, ketoacidosis, osmotic diuresis, K⁺ shift out with total-body depletion | Fluids, insulin (fixed rate), K⁺ replacement (hypokalaemia risk) |
| `dehydration` | GI/water loss with solutes, K⁺ loss | Fluids, antiemetic |
| `tensionPneumothorax` | Pleural air accumulation (worse with PPV) | Needle (correct side/site; can occlude), chest drain |
| `myocardialIschemia` | Territorial coronary occlusion/stenosis | Reperfusion (PCI/lysis), aspirin/heparin, nitrates (careful in RV infarct), O₂ if hypoxaemic |
| `arrhythmia` | Pathological rhythm with substrate | Vagal manoeuvres, adenosine, rate control, cardioversion, pacing, atropine |
| `cardiacArrest` | Primary VF/asystole with a cause | CPR quality, defibrillation, adrenaline, amiodarone, reversible causes |
| `hyperkalemia` | K⁺ load / failure of excretion / shift | Calcium (stabilisation), insulin+dextrose, salbutamol, bicarbonate (if acidotic), dialysis |
| `hypothermia` | Environmental cold exposure | Active warming, warmed fluids, gentle handling; arrhythmia threshold |

## 11. Library scenarios

These 19 cases are composed from the modules above:

1. Found unresponsive
2. Short of breath
3. Itchy and breathless
4. Penetrating injury
5. Road traffic collision
6. Motorcycle crash
7. Chest pain
8. Epigastric pain and faintness
9. Fever and confusion
10. Cough and breathlessness
11. Vomiting and drowsy
12. Strange behaviour
13. Palpitations
14. Dizzy spells
15. Collapse at the gym
16. Weak and nauseous
17. Diarrhoea and vomiting
18. Found outdoors
19. Breathless and fluttery

Titles describe the presentation only, never the diagnosis (this is enforced by the validator). Before arrival, each case is simulated forward from its onset, up to 24 h for DKA.

## 12. Diagnostics

- **Sample timing.** A specimen captures the state when it is *collected* (after the collection delay). The result appears after the turnaround time. Point-of-care tests take seconds to minutes, and laboratory tests take 20–60 min.
- **Simulated results** are derived from state with analytical noise and reference ranges. They include:
  - glucose, VBG/ABG, ketones and lactate;
  - FBC, U&E, LFT and coagulation;
  - troponin, urinalysis and the 12-lead ECG (rendered from the ECG morphology state).
- **Semi-simulated imaging:**
  - CXR from pleural air and blood, lung water and ETT position;
  - POCUS: lung sliding, B-lines, free fluid, LV/RV function and IVC.
- **Authored** results (for example toxicology findings or a CT head read) come from the scenario and are marked as such in the UI.

## 13. Validation performed

- Unit tests (`tests/`, 48 tests) cover:
  - determinism (identical seed and actions give an identical state hash; the replay matches);
  - invariants: no NaN, volumes conserved, bounded pressures, and every scenario arrives alive;
  - intervention directionality: naloxone, IM adrenaline, tourniquet (and wrong limb), needle decompression (and wrong side), adenosine, dextrose, defibrillation (asystole unaffected), calcium vs insulin, fluid redistribution, allergy, RSI;
  - pharmacology (half-lives, antagonism, synergy);
  - scenario schema and diagnosis-leak validation, AI schemas, save/load and timeline ordering.
- `scripts/simcheck.ts`, `baseline.ts`, `trace.ts` and `chem.ts` print physiological traces. They were used to tune time courses against textbook expectations, for example:
  - untreated tension pneumothorax, which becomes peri-arrest within tens of minutes;
  - class III haemorrhage, which is tachycardic with a narrow pulse pressure before hypotension;
  - naloxone reversal within 1–2 min IV and 3–5 min IM;
  - troponin, which becomes positive over 1–3 h.

## 14. Known limitations

- **Circulation.** The circulation is lumped: there is no pulsatile ventricular pressure–volume loop, and waveforms are synthesised from beat-level values. There are no regional circulations apart from the coronary, cerebral and renal abstractions, and no valve disease.
- **Lungs.** The lungs are a single-compartment model with shunt and V/Q terms, not a multi-compartment V/Q distribution, and ventilator modes are limited to volume control.
- **Endocrine and inflammatory.** Endocrine and inflammatory models are highly reduced, and sepsis uses a single pathogen load.
- **Neuro.** There is no ICP model, no intracranial haemorrhage expansion, and no pupil asymmetry beyond simple rules.
- **Pharmacology.** Parameters are literature-inspired but simplified. There are no active metabolites except where approximated, and paediatrics and pregnancy are not supported.
- **Coverage.** Many conditions are not modelled, including PE, tamponade, aortic dissection, stroke, burns and toxidromes other than opioids.
- **Accuracy.** Numbers are illustrative. Instructors should review cases before teaching with them.

## 15. References (used as modelling sources)

- Guyton AC, Coleman TG, Granger HJ. *Circulation: overall regulation.* Annu Rev Physiol 1972.
- Guyton AC, Jones CE, Coleman TG. *Circulatory Physiology: Cardiac Output and its Regulation.* 1973.
- Severinghaus JW. *Simple, accurate equations for human blood O₂ dissociation computations.* J Appl Physiol 1979.
- Kelman GR. *Digital computer subroutine for the conversion of oxygen tension into saturation.* J Appl Physiol 1966.
- Landis EM, Pappenheimer JR. *Exchange of substances through the capillary walls.* Handbook of Physiology 1963.
- Levick JR, Michel CC. *Microvascular fluid exchange and the revised Starling principle.* Cardiovasc Res 2010.
- Hahn RG. *Volume kinetics for infusion fluids.* Anesthesiology 2010.
- Minto CF et al. *Response surface model for anesthetic drug interactions.* Anesthesiology 2000.
- Sheiner LB et al. *Simultaneous modeling of pharmacokinetics and pharmacodynamics (effect compartment).* Clin Pharmacol Ther 1979.
- Bergman RN et al. *Quantitative estimation of insulin sensitivity (minimal model).* Am J Physiol 1979.
- Kitware. *Pulse Physiology Engine — methodology reports* (cardiovascular, respiratory, drugs, energy). pulse.kitware.com.
- West JB. *Respiratory Physiology: The Essentials.* Lumb AB. *Nunn's Applied Respiratory Physiology.*
- Resuscitation Council UK / ERC 2021 and AHA 2020 guidelines, and Resus Council UK anaphylaxis 2021 (for expected treatment responses and debrief logic).
