import type { BodyRegion } from '../types';

/** Region ids baked by scripts/assets/build-human.mjs */
export const REGION_BY_ID: BodyRegion[] = [
  'head',
  'face',
  'neck',
  'chest',
  'abdomen',
  'pelvis',
  'back',
  'leftArm',
  'rightArm',
  'leftHand',
  'rightHand',
  'leftLeg',
  'rightLeg',
  'leftFoot',
  'rightFoot',
  'face', // 15 = lips
];

export function regionFromId(id: number): BodyRegion {
  return REGION_BY_ID[id] ?? 'chest';
}
