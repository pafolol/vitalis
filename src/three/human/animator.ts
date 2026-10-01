import * as THREE from 'three';
import type { AvatarVisualState } from '../types';
import type { HumanRig } from './buildHuman';
import { applyFrameDelta } from './pose';
import { applySkinPhysiology } from './skinMaterial';
import { hash01, snoise1 } from './noise';

/**
 * Drives the rig from the physiology-derived AvatarVisualState every frame.
 * Everything here is procedural and state-driven — there are no authored
 * animation clips. No React state is touched.
 */

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class HumanAnimator {
  private rig: HumanRig;
  private meshes: THREE.SkinnedMesh[];
  private smooth = {
    breath: 0,
    backrest: 15,
    eyesOpen: 1,
    handToChest: 0,
    headTurn: 0,
    seizure: 0,
    cpr: 0,
    airway: 0,
  };
  private lastShock = -1;
  private shockStart = -1;
  private nextBlink = 2;
  private blinkStart = -10;
  /** Offset applied to rig.root for CPR push / defib jolt (world units) */
  readonly rootOffset = new THREE.Vector3();
  private restRootPos = new THREE.Vector3();
  private eyeForward = new THREE.Vector3(0, 0, 1);

  constructor(rig: HumanRig) {
    this.rig = rig;
    this.meshes = [rig.body, ...rig.helpers];
    const eh = rig.landmarks.boneHead('eye.L');
    const et = rig.landmarks.boneTail('eye.L');
    this.eyeForward.copy(et).sub(eh).normalize();
  }

  setRestRootPosition(p: THREE.Vector3) {
    this.restRootPos.copy(p);
  }

  private setMorph(name: string, value: number) {
    for (const m of this.meshes) {
      const i = m.morphTargetDictionary?.[name];
      if (i !== undefined && m.morphTargetInfluences) m.morphTargetInfluences[i] = value;
    }
  }

  private local(name: string, axis: THREE.Vector3, angle: number) {
    const b = this.rig.bones[name];
    if (!b || Math.abs(angle) < 1e-6) return;
    b.quaternion.multiply(_q.setFromAxisAngle(axis, angle));
  }

  private frame(name: string, axis: THREE.Vector3, angle: number) {
    const b = this.rig.bones[name];
    if (!b || Math.abs(angle) < 1e-6) return;
    applyFrameDelta(b, _q.setFromAxisAngle(axis, angle));
  }

  update(vs: AvatarVisualState, dt: number, camera: THREE.Camera | null) {
    const rig = this.rig;
    const t = vs.clock;
    const s = this.smooth;
    const k = (rate: number) => 1 - Math.exp(-rate * Math.max(0, Math.min(dt, 0.1)));
    s.breath += (THREE.MathUtils.clamp(vs.breathPhase, 0, 1) - s.breath) * k(30);
    s.backrest += (vs.attachments.backrestDeg - s.backrest) * k(3);
    s.handToChest += (vs.handToChest - s.handToChest) * k(2.5);
    s.headTurn += (vs.headTurn - s.headTurn) * k(2);
    s.seizure += (vs.seizure - s.seizure) * k(6);
    s.cpr += (vs.cprCompression - s.cpr) * k(40);
    s.airway += ((vs.attachments.airwayManoeuvre ? 1 : 0) - s.airway) * k(4);

    // ------------------------------------------------------------ bones: reset to base pose
    for (const [n, q] of rig.pose.base) rig.bones[n].quaternion.copy(q);
    // right hand to chest (IK pose blend)
    if (s.handToChest > 0.001) {
      for (const [n, q] of rig.pose.handToChestR) rig.bones[n].quaternion.slerp(q, s.handToChest);
    }

    const v = s.breath * Math.max(0, vs.breathDepth);
    const acc = vs.passiveVentilation ? 0 : vs.accessoryMuscles;

    // backrest (hinge at the lumbar spine), counter-flex the neck a little
    const back = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(s.backrest, 0, 80));
    this.frame('spine05', X, -back * 0.0); // hips stay on the bed
    this.frame('spine04', X, back * 0.55);
    this.frame('spine03', X, back * 0.35);
    this.frame('spine02', X, back * 0.1);
    this.frame('neck01', X, -back * 0.25);

    // airway manoeuvre: head tilt (extension) + jaw thrust
    this.local('neck02', X, -0.18 * s.airway);
    this.local('head', X, -0.14 * s.airway);

    // head turn / lolling / agitation
    const agit = vs.agitation;
    const agHead = agit * 0.45 * snoise1(t * 0.35, 1);
    const turn = s.headTurn * 0.55 + agHead;
    this.local('neck02', Y, turn * 0.45);
    this.local('neck03', Y, turn * 0.25);
    this.local('head', Y, turn * 0.3);
    // unconscious: head rolls slightly with the turn
    this.local('head', Z, -s.headTurn * 0.12 * (1 - vs.eyesOpen));

    // accessory muscles: shoulders elevate and neck extends with each inspiration
    if (acc > 0.01) {
      this.local('clavicle.L', Z, 0.05 * acc * v);
      this.local('clavicle.R', Z, -0.05 * acc * v);
      this.local('neck01', X, -0.05 * acc * v);
    }

    // agitation: restless limbs
    // Supine, frame-X flexion lifts limbs off the bed, so it is kept small (hands shift a few cm, knees
    // stay under the sheet); restlessness shows mainly as forearm roll, wrist and ankle fidgeting.
    // A hand clutching the chest stays on the chest.
    if (agit > 0.01) {
      const freeR = 1 - s.handToChest;
      this.frame('upperarm01.L', X, 0.06 * agit * Math.max(0, snoise1(t * 0.4, 3)));
      this.frame('upperarm01.R', X, 0.06 * agit * freeR * Math.max(0, snoise1(t * 0.43, 4)));
      this.frame('lowerarm01.L', X, 0.12 * agit * Math.max(0, snoise1(t * 0.5, 5)));
      this.frame('lowerarm01.R', X, 0.12 * agit * freeR * Math.max(0, snoise1(t * 0.47, 6)));
      this.local('lowerarm02.L', Y, 0.35 * agit * snoise1(t * 0.6, 12));
      this.local('lowerarm02.R', Y, 0.35 * agit * freeR * snoise1(t * 0.57, 13));
      this.local('wrist.L', X, 0.25 * agit * snoise1(t * 0.9, 14));
      this.local('wrist.R', X, 0.25 * agit * (0.3 + 0.7 * freeR) * snoise1(t * 0.85, 15));
      const kneeL = 0.06 * agit * Math.max(0, snoise1(t * 0.3, 7));
      const kneeR = 0.06 * agit * Math.max(0, snoise1(t * 0.33, 8));
      this.frame('upperleg01.L', X, -kneeL * 0.6);
      this.frame('lowerleg01.L', X, kneeL);
      this.frame('upperleg01.R', X, -kneeR * 0.6);
      this.frame('lowerleg01.R', X, kneeR);
      this.frame('foot.L', X, 0.3 * agit * snoise1(t * 0.7, 16));
      this.frame('foot.R', X, 0.3 * agit * snoise1(t * 0.65, 17));
    }

    // generalised tonic–clonic seizure: rhythmic flexor jerks, tonic neck extension
    const sz = s.seizure;
    if (sz > 0.01) {
      const f = 2.6 + 0.8 * snoise1(t * 0.2, 11);
      const phase = t * f * Math.PI * 2;
      const jerk = Math.pow(Math.max(0, Math.sin(phase)), 3);
      const jerk2 = Math.pow(Math.max(0, Math.sin(phase + 0.4)), 3);
      this.frame('upperarm01.L', X, sz * (0.18 + 0.28 * jerk));
      this.frame('upperarm01.R', X, sz * (0.18 + 0.28 * jerk2));
      this.frame('lowerarm01.L', X, sz * (0.5 + 0.45 * jerk));
      this.frame('lowerarm01.R', X, sz * (0.5 + 0.45 * jerk2));
      this.local('wrist.L', X, sz * 0.4 * jerk);
      this.local('wrist.R', X, sz * 0.4 * jerk2);
      this.frame('lowerleg01.L', X, sz * 0.18 * jerk2);
      this.frame('lowerleg01.R', X, sz * 0.18 * jerk);
      this.local('neck02', X, -sz * (0.12 + 0.08 * jerk));
      this.local('head', Y, sz * 0.12 * Math.sin(phase * 0.5));
      this.local('spine03', X, -sz * 0.04 * jerk);
    }

    // fine tremor (sympathetic / hypoglycaemia / withdrawal)
    if (vs.tremor > 0.01) {
      const tr = vs.tremor * 0.045;
      this.local('wrist.L', X, tr * Math.sin(t * 2 * Math.PI * 8.7));
      this.local('wrist.R', X, tr * Math.sin(t * 2 * Math.PI * 9.1 + 1));
      for (let fi = 2; fi <= 5; fi++) {
        this.local(`finger${fi}-1.L`, Z, tr * 0.7 * Math.sin(t * 2 * Math.PI * 8.7 + fi));
        this.local(`finger${fi}-1.R`, Z, tr * 0.7 * Math.sin(t * 2 * Math.PI * 9.1 + fi));
      }
      this.local('head', Y, vs.tremor * 0.008 * Math.sin(t * 2 * Math.PI * 5.3));
    }

    // defibrillation jolt: brief generalised muscle contraction
    if (vs.lastShockAt !== this.lastShock) {
      if (this.lastShock !== -1 || vs.lastShockAt >= 0) this.shockStart = t;
      this.lastShock = vs.lastShockAt;
    }
    let jolt = 0;
    if (this.shockStart >= 0) {
      const dtS = t - this.shockStart;
      if (dtS >= 0 && dtS < 0.8) jolt = Math.exp(-dtS / 0.09) * (dtS < 0.03 ? dtS / 0.03 : 1);
      else this.shockStart = -1;
    }
    if (jolt > 0.001) {
      this.frame('upperarm01.L', X, 0.35 * jolt);
      this.frame('upperarm01.R', X, 0.35 * jolt);
      this.frame('lowerarm01.L', X, 0.5 * jolt);
      this.frame('lowerarm01.R', X, 0.5 * jolt);
      this.frame('spine03', X, 0.08 * jolt);
      this.frame('upperleg01.L', X, -0.12 * jolt);
      this.frame('upperleg01.R', X, -0.12 * jolt);
      this.local('neck02', X, 0.12 * jolt);
    }

    // eyes: gaze follows the camera when alert
    const eyesMove = vs.gazeFollow * vs.eyesOpen;
    for (const side of ['L', 'R'] as const) {
      const eye = rig.bones[`eye.${side}`];
      if (!eye) continue;
      eye.quaternion.identity();
      const sacc = agit * 0.25 * snoise1(Math.floor(t * 2.2) + (side === 'L' ? 0 : 0), 21);
      if (camera && eyesMove > 0.01) {
        eye.parent!.updateWorldMatrix(true, false);
        camera.getWorldPosition(_v);
        eye.getWorldPosition(_w);
        _m.copy(eye.parent!.matrixWorld).invert();
        _v.applyMatrix4(_m);
        _w.applyMatrix4(_m);
        const dir = _v.sub(_w).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(this.eyeForward, dir);
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
        const maxA = 0.45;
        if (angle > maxA) q.slerp(new THREE.Quaternion(), 1 - maxA / angle);
        eye.quaternion.slerp(q, eyesMove);
      }
      if (sacc) eye.quaternion.multiply(_q.setFromAxisAngle(Y, sacc));
      if (vs.eyesOpen < 0.35) eye.quaternion.multiply(_q.setFromAxisAngle(X, -0.25 * (1 - vs.eyesOpen))); // Bell's phenomenon-ish upward roll
    }

    // ------------------------------------------------------------ morph targets
    s.eyesOpen += (vs.eyesOpen - s.eyesOpen) * k(6);
    // blinking when awake
    if (t > this.nextBlink && s.eyesOpen > 0.5) {
      this.blinkStart = t;
      this.nextBlink = t + 2.2 + 4 * hash01(Math.floor(t * 10)) - agit * 1.5;
    }
    const bt = (t - this.blinkStart) / 0.16;
    const blink = bt >= 0 && bt < 1 ? Math.sin(bt * Math.PI) : 0;
    const pain = vs.painExpression;
    const closure = THREE.MathUtils.clamp(1 - s.eyesOpen + blink * s.eyesOpen + pain * 0.15, 0, 1);
    this.setMorph('eye-left-closure', closure);
    this.setMorph('eye-right-closure', closure);
    this.setMorph('eye-left-slit', pain * 0.55);
    this.setMorph('eye-right-slit', pain * 0.55);
    this.setMorph('eyebrows-left-inner-up', pain * 0.9 + agit * 0.2);
    this.setMorph('eyebrows-right-inner-up', pain * 0.9 + agit * 0.2);
    this.setMorph('eyebrows-left-down', pain * 0.45);
    this.setMorph('eyebrows-right-down', pain * 0.45);
    const speak = vs.speaking * (0.18 + 0.22 * Math.max(0, Math.sin(t * 2 * Math.PI * 4.1) * 0.6 + snoise1(t * 7, 31) * 0.5));
    const mouthOpen = THREE.MathUtils.clamp(vs.jawOpen * 0.7 + speak + s.airway * 0.12 + acc * v * 0.12, 0, 1);
    this.setMorph('mouth-open', mouthOpen);
    this.setMorph('mouth-retraction', pain * 0.45);
    this.setMorph('mouth-compression', THREE.MathUtils.clamp(pain * 0.2 + sz * 0.7, 0, 1));
    this.setMorph('mouth-depression', pain * 0.3);
    this.setMorph('nose-compression', pain * 0.35);
    const flare = vs.nasalFlare * (0.25 + 0.75 * s.breath);
    this.setMorph('nose-left-dilatation', flare);
    this.setMorph('nose-right-dilatation', flare);
    this.setMorph('neck-platysma', THREE.MathUtils.clamp(acc * (0.2 + 0.8 * s.breath) + sz * 0.5 + pain * 0.2, 0, 1));
    const abd = THREE.MathUtils.clamp(vs.abdominalFraction, 0, 1);
    const chestAmt = v * (1 - abd * 0.55) * (vs.passiveVentilation ? 1.15 : 1);
    this.setMorph('breath-chest-left', THREE.MathUtils.clamp(chestAmt * vs.chestRiseLeft, 0, 3));
    this.setMorph('breath-chest-right', THREE.MathUtils.clamp(chestAmt * vs.chestRiseRight, 0, 3));
    this.setMorph('breath-abdomen', THREE.MathUtils.clamp(v * (0.35 + 0.8 * abd) * (vs.passiveVentilation ? 0.5 : 1), 0, 3));
    this.setMorph('cpr-compression', THREE.MathUtils.clamp(s.cpr, 0, 1.2));
    this.setMorph('angioedema', THREE.MathUtils.clamp(vs.angioedema, 0, 1.2));

    // ------------------------------------------------------------ pupils & skin
    rig.eyeUniforms.uPupilFrac.value = THREE.MathUtils.clamp(vs.pupilMm, 1, 9) / 11.5;
    const u = rig.skin.uniforms;
    u.uPallor.value = vs.pallor;
    u.uCyanC.value = vs.cyanosisCentral;
    u.uCyanP.value = vs.cyanosisPeripheral;
    u.uFlush.value = vs.flushing;
    u.uUrticaria.value = vs.urticaria;
    u.uMottling.value = vs.mottling;
    u.uDiaphoresis.value = vs.diaphoresis;
    applySkinPhysiology(rig.skin.material, u);
    rig.eyeUniforms.uScleraTint.value.setRGB(1, 1 - vs.flushing * 0.08, 1 - vs.flushing * 0.1);

    // ------------------------------------------------------------ root offsets (CPR push, jolt)
    this.rootOffset.set(0, -0.012 * s.cpr + 0.02 * jolt, 0);
    rig.root.position.copy(this.restRootPos).add(this.rootOffset);
  }
}
