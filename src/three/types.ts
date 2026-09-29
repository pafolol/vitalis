/**
 * Contract between the simulation/UI layer and the 3D rendering layer.
 *
 * The renderer never reads physiology directly. The client derives an
 * `AvatarVisualState` from the latest simulation snapshot (see
 * `src/client/visualState.ts`) and the 3D layer only animates what it is told.
 * This keeps the character replaceable without touching simulation logic.
 */

export type Sex = 'male' | 'female';

/** Parameters used to procedurally build the patient body mesh (once per case). */
export interface BodyShapeParams {
  sex: Sex;
  ageYears: number;
  heightM: number;
  /** -1 = very thin, 0 = average, +1 = obese */
  weightFactor: number;
  /** -1 = low muscle mass, 0 = average, +1 = very muscular */
  muscleFactor: number;
  /** 0 = very light skin, 1 = very dark skin */
  skinTone: number;
}

export type BodySide = 'left' | 'right';
export type Limb = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export type BodyRegion =
  | 'head'
  | 'face'
  | 'neck'
  | 'chest'
  | 'abdomen'
  | 'pelvis'
  | 'back'
  | 'leftArm'
  | 'rightArm'
  | 'leftHand'
  | 'rightHand'
  | 'leftLeg'
  | 'rightLeg'
  | 'leftFoot'
  | 'rightFoot';

/** Auscultation/examination zones (patient's left/right). */
export type ExamZone =
  | 'trachea'
  | 'rightUpperChest'
  | 'leftUpperChest'
  | 'rightLowerChest'
  | 'leftLowerChest'
  | 'rightAxilla'
  | 'leftAxilla'
  | 'aorticArea'
  | 'pulmonicArea'
  | 'tricuspidArea'
  | 'mitralArea'
  | 'epigastrium'
  | 'rightUpperQuadrant'
  | 'leftUpperQuadrant'
  | 'rightLowerQuadrant'
  | 'leftLowerQuadrant'
  | 'rightRadial'
  | 'leftRadial'
  | 'rightCarotid'
  | 'leftCarotid'
  | 'rightFemoral'
  | 'leftFemoral'
  | 'rightSecondICS'
  | 'leftSecondICS'
  | 'rightFifthICSAxillary'
  | 'leftFifthICSAxillary';

export interface BodyPointerHit {
  region: BodyRegion;
  zone: ExamZone | null;
  /** World-space hit point */
  point: [number, number, number];
  /** Screen-space position for placing popovers */
  screen: [number, number];
}

/**
 * Per-frame visual state, derived from physiology. All values are normalised
 * so the renderer never needs clinical knowledge. Updated in place (mutable
 * ref) — React does not re-render when it changes.
 */
export interface AvatarVisualState {
  /** Monotonic visual clock in seconds (already accounts for pause). */
  clock: number;

  // --- Breathing (driven by simulated RR / tidal volume / ventilation mode) ---
  /** 0..1 inspiratory fraction of the current breath (0 = end-expiration). */
  breathPhase: number;
  /** Tidal depth relative to a normal resting breath (0 = apnoea, 1 = normal, 2.5 = very deep). */
  breathDepth: number;
  /** Relative chest excursion per side (0 = none, 1 = normal). Pneumothorax reduces one side. */
  chestRiseLeft: number;
  chestRiseRight: number;
  /** 0 = chest breathing, 1 = abdominal breathing */
  abdominalFraction: number;
  /** Visible work of breathing: accessory muscle use 0..1 */
  accessoryMuscles: number;
  /** Nasal flaring 0..1 */
  nasalFlare: number;
  /** Positive pressure breath (BVM/ventilator) — chest rises passively, no accessory use. */
  passiveVentilation: boolean;

  // --- Cardiac ---
  /** 0..1 phase within the current cardiac cycle (0 = QRS). */
  cardiacPhase: number;
  /** Stroke-volume-ish visible pulse strength 0..1 (0 in cardiac arrest) */
  pulseStrength: number;
  heartRate: number;

  // --- Neuro / behaviour ---
  /** 0 = closed, 1 = fully open */
  eyesOpen: number;
  /** 0..1 where 1 = eyes track the camera */
  gazeFollow: number;
  /** -1 = head turned to patient's right, +1 = left */
  headTurn: number;
  /** 0..1 slack jaw */
  jawOpen: number;
  /** 0..1 facial pain/distress */
  painExpression: number;
  /** 0..1 restlessness/agitation */
  agitation: number;
  /** 0..1 fine tremor */
  tremor: number;
  /** 0..1 generalised tonic-clonic activity */
  seizure: number;
  /** 0..1 how much the patient is speaking right now (lip movement) */
  speaking: number;
  /** Hand held over chest (ischaemic pain) 0..1 */
  handToChest: number;
  /** Pupil diameter in mm (1.5 pinpoint … 8 blown) */
  pupilMm: number;

  // --- Skin / appearance (physiology-driven shader parameters, 0..1) ---
  pallor: number;
  /** Central cyanosis (lips/face) */
  cyanosisCentral: number;
  /** Peripheral cyanosis (fingers/toes) */
  cyanosisPeripheral: number;
  /** Diffuse flushing */
  flushing: number;
  /** Urticarial wheals */
  urticaria: number;
  /** Mottling (livedo) of knees/legs */
  mottling: number;
  /** Sweat sheen */
  diaphoresis: number;
  /** Lip/facial swelling (angioedema) */
  angioedema: number;

  // --- Resuscitation ---
  /** 0..1 current chest compression depth (animated by the CPR controller) */
  cprCompression: number;
  /** Visual clock time of last defibrillation shock (jolt animation), or -1 */
  lastShockAt: number;

  // --- Attachments reflecting active interventions ---
  attachments: AvatarAttachments;

  // --- Anatomy overlays (physiology -> anatomy) ---
  anatomy: AnatomyPhysiologyOverlay;
}

export interface AvatarAttachments {
  ecgLeads: boolean;
  spo2Probe: boolean;
  bpCuff: boolean;
  ivLeftArm: boolean;
  ivRightArm: boolean;
  ioAccess: boolean;
  nasalCannula: boolean;
  faceMask: boolean;
  nonRebreather: boolean;
  bvm: boolean;
  ett: boolean;
  opa: boolean;
  defibPads: boolean;
  tourniquet: Limb | null;
  chestTube: BodySide | null;
  needleDecompression: BodySide | null;
  /** Visible bleeding wound */
  bleeding: { region: BodyRegion; intensity: number } | null;
  /** Fluid bag hanging on the IV pole */
  ivBag: { label: string; fraction: number; running: boolean; isBlood: boolean } | null;
  /** Head-tilt/chin-lift or jaw thrust */
  airwayManoeuvre: boolean;
  /** Patient positioned upright/semi-recumbent (degrees of backrest) */
  backrestDeg: number;
}

export interface AnatomyPhysiologyOverlay {
  /** 0..1 inflation of each lung (collapse from pneumothorax lowers one side) */
  lungInflationLeft: number;
  lungInflationRight: number;
  /** 0..1 pulmonary oedema / consolidation */
  lungOedema: number;
  /** 0..1 bronchoconstriction severity */
  bronchospasm: number;
  /** 0..1 myocardial ischaemia severity */
  myocardialIschaemia: number;
  /** Arterial oxygen saturation 0..1 (vessel colouring) */
  arterialSat: number;
  /** 0..1 cerebral oxygen delivery adequacy */
  brainPerfusion: number;
  /** 0..1 renal perfusion adequacy */
  renalPerfusion: number;
  /** 0..1 hepatic/splanchnic perfusion adequacy */
  splanchnicPerfusion: number;
  /** 0..1 contractile vigour (0 in arrest without CPR) */
  cardiacContractility: number;
  /** Air in the pleural space (0..1 of hemithorax) */
  pleuralAirLeft: number;
  pleuralAirRight: number;
}

export type AnatomyLayerId =
  | 'skin'
  | 'superficial'
  | 'muscle'
  | 'skeleton'
  | 'cardiovascular'
  | 'respiratory'
  | 'digestive'
  | 'nervous'
  | 'organs';

export interface AnatomyLayerSetting {
  visible: boolean;
  opacity: number;
}

export type AnatomyLayerSettings = Record<AnatomyLayerId, AnatomyLayerSetting>;

export interface AnatomyStructureInfo {
  id: string;
  name: string;
  layer: AnatomyLayerId;
  system: string;
  fmaId?: string;
  description?: string;
}

export type CameraPreset = 'full' | 'head' | 'chest' | 'abdomen' | 'arms' | 'legs';

export function createDefaultVisualState(): AvatarVisualState {
  return {
    clock: 0,
    breathPhase: 0,
    breathDepth: 1,
    chestRiseLeft: 1,
    chestRiseRight: 1,
    abdominalFraction: 0.5,
    accessoryMuscles: 0,
    nasalFlare: 0,
    passiveVentilation: false,
    cardiacPhase: 0,
    pulseStrength: 1,
    heartRate: 75,
    eyesOpen: 1,
    gazeFollow: 1,
    headTurn: 0,
    jawOpen: 0,
    painExpression: 0,
    agitation: 0,
    tremor: 0,
    seizure: 0,
    speaking: 0,
    handToChest: 0,
    pupilMm: 4,
    pallor: 0,
    cyanosisCentral: 0,
    cyanosisPeripheral: 0,
    flushing: 0,
    urticaria: 0,
    mottling: 0,
    diaphoresis: 0,
    angioedema: 0,
    cprCompression: 0,
    lastShockAt: -1,
    attachments: {
      ecgLeads: false,
      spo2Probe: false,
      bpCuff: false,
      ivLeftArm: false,
      ivRightArm: false,
      ioAccess: false,
      nasalCannula: false,
      faceMask: false,
      nonRebreather: false,
      bvm: false,
      ett: false,
      opa: false,
      defibPads: false,
      tourniquet: null,
      chestTube: null,
      needleDecompression: null,
      bleeding: null,
      ivBag: null,
      airwayManoeuvre: false,
      backrestDeg: 15,
    },
    anatomy: {
      lungInflationLeft: 1,
      lungInflationRight: 1,
      lungOedema: 0,
      bronchospasm: 0,
      myocardialIschaemia: 0,
      arterialSat: 0.98,
      brainPerfusion: 1,
      renalPerfusion: 1,
      splanchnicPerfusion: 1,
      cardiacContractility: 1,
      pleuralAirLeft: 0,
      pleuralAirRight: 0,
    },
  };
}

export const ANATOMY_LAYERS: { id: AnatomyLayerId; label: string }[] = [
  { id: 'skin', label: 'Skin' },
  { id: 'superficial', label: 'Superficial vessels' },
  { id: 'muscle', label: 'Muscle' },
  { id: 'skeleton', label: 'Skeleton' },
  { id: 'cardiovascular', label: 'Cardiovascular' },
  { id: 'respiratory', label: 'Respiratory' },
  { id: 'digestive', label: 'Digestive' },
  { id: 'nervous', label: 'Nervous' },
  { id: 'organs', label: 'Urinary & endocrine' },
];

export function createDefaultLayerSettings(): AnatomyLayerSettings {
  return {
    skin: { visible: true, opacity: 1 },
    superficial: { visible: false, opacity: 1 },
    muscle: { visible: false, opacity: 1 },
    skeleton: { visible: false, opacity: 1 },
    cardiovascular: { visible: false, opacity: 1 },
    respiratory: { visible: false, opacity: 1 },
    digestive: { visible: false, opacity: 1 },
    nervous: { visible: false, opacity: 1 },
    organs: { visible: false, opacity: 1 },
  };
}
