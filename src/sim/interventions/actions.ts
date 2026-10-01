import { z } from 'zod';

/**
 * Every clinician action is a serialisable, validated `SimAction`. Actions are
 * queued and applied at the next fixed simulation tick and recorded in the
 * action log, which (with the seed) is sufficient to replay a case exactly.
 */

const limb = z.enum(['leftArm', 'rightArm', 'leftLeg', 'rightLeg']);
const side = z.enum(['left', 'right']);
const route = z.enum(['IV', 'IO', 'IM', 'SC', 'IN', 'PO', 'SL', 'NEB']);

export const SimActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('monitor.attach'), devices: z.array(z.enum(['ecg', 'spo2', 'nibp', 'etco2', 'temp'])).min(1) }),
  z.object({ type: z.literal('monitor.detach'), devices: z.array(z.enum(['ecg', 'spo2', 'nibp', 'etco2', 'temp'])).min(1) }),
  z.object({ type: z.literal('nibp.measure') }),
  z.object({ type: z.literal('nibp.interval'), minutes: z.number().min(0).max(60) }),
  z.object({ type: z.literal('oxygen.set'), device: z.enum(['none', 'nasalCannula', 'simpleMask', 'nonRebreather', 'highFlowNasal']), flowLpm: z.number().min(0).max(70), fio2: z.number().min(0.21).max(1).optional() }),
  z.object({ type: z.literal('airway.manoeuvre'), manoeuvre: z.enum(['none', 'headTiltChinLift', 'jawThrust']) }),
  z.object({ type: z.literal('airway.adjunct'), adjunct: z.enum(['none', 'opa', 'npa']) }),
  z.object({ type: z.literal('airway.suction') }),
  z.object({ type: z.literal('airway.recoveryPosition'), on: z.boolean() }),
  z.object({ type: z.literal('airway.intubate'), tubeSize: z.number().min(6).max(9).default(7.5) }),
  z.object({ type: z.literal('airway.extubate') }),
  z.object({ type: z.literal('airway.cricothyrotomy') }),
  z.object({ type: z.literal('bvm.set'), active: z.boolean(), rate: z.number().min(0).max(40).default(10), vt: z.number().min(0).max(1200).default(500) }),
  z.object({
    type: z.literal('ventilator.set'),
    on: z.boolean(),
    vt: z.number().min(200).max(1000).default(450),
    rr: z.number().min(4).max(40).default(16),
    peep: z.number().min(0).max(24).default(5),
    fio2: z.number().min(0.21).max(1).default(1),
    ieRatio: z.number().min(1).max(5).default(2),
  }),
  z.object({ type: z.literal('access.iv'), site: z.enum(['leftArm', 'rightArm']) }),
  z.object({ type: z.literal('access.io') }),
  z.object({ type: z.literal('fluid.start'), fluidId: z.string(), volumeMl: z.number().positive().max(5000), rateMlH: z.number().positive().max(20000), warmed: z.boolean().default(false) }),
  z.object({ type: z.literal('infusion.stop'), infusionId: z.string() }),
  z.object({ type: z.literal('infusion.rate'), infusionId: z.string(), rate: z.number().min(0) }),
  z.object({ type: z.literal('drug.bolus'), drugId: z.string(), dose: z.number().positive(), unit: z.string(), route }),
  z.object({ type: z.literal('drug.infusion'), drugId: z.string(), rate: z.number().positive(), unit: z.string() }),
  z.object({ type: z.literal('cpr.start'), mode: z.enum(['manual', 'mechanical']).default('manual') }),
  z.object({ type: z.literal('cpr.stop') }),
  z.object({ type: z.literal('cpr.compressions'), count: z.number().int().min(0).max(100), meanIntervalMs: z.number().min(0).max(5000), depthQuality: z.number().min(0).max(1), windowMs: z.number().min(100).max(10000) }),
  z.object({ type: z.literal('defib.pads'), on: z.boolean() }),
  z.object({ type: z.literal('defib.energy'), joules: z.number().min(0).max(360) }),
  z.object({ type: z.literal('defib.sync'), on: z.boolean() }),
  z.object({ type: z.literal('defib.charge') }),
  z.object({ type: z.literal('defib.shock') }),
  z.object({ type: z.literal('defib.disarm') }),
  z.object({ type: z.literal('pacing.set'), on: z.boolean(), rate: z.number().min(30).max(180).default(70), mA: z.number().min(0).max(200).default(60) }),
  z.object({ type: z.literal('procedure.vagal') }),
  z.object({ type: z.literal('procedure.needleDecompression'), side, site: z.enum(['2ICS-MCL', '5ICS-AAL']) }),
  z.object({ type: z.literal('procedure.chestTube'), side }),
  z.object({ type: z.literal('procedure.tourniquet'), limb: limb.nullable() }),
  z.object({ type: z.literal('procedure.directPressure'), on: z.boolean() }),
  z.object({ type: z.literal('procedure.pelvicBinder'), on: z.boolean() }),
  z.object({ type: z.literal('procedure.hemostasis') }),
  z.object({ type: z.literal('procedure.reperfusion') }),
  z.object({ type: z.literal('procedure.dialysis') }),
  z.object({ type: z.literal('procedure.warming'), on: z.boolean() }),
  z.object({ type: z.literal('procedure.expose'), on: z.boolean() }),
  z.object({ type: z.literal('procedure.legRaise'), on: z.boolean() }),
  z.object({ type: z.literal('procedure.backrest'), degrees: z.number().min(0).max(80) }),
  z.object({ type: z.literal('procedure.arterialLine') }),
  z.object({ type: z.literal('diagnostic.order'), testId: z.string() }),
  z.object({ type: z.literal('exam.perform'), exam: z.string(), zone: z.string().optional(), detail: z.string().optional() }),
  z.object({ type: z.literal('note'), text: z.string().max(500) }),
  z.object({ type: z.literal('case.end'), reason: z.string().max(200), diagnosis: z.string().max(300).optional() }),
]);

export type SimAction = z.infer<typeof SimActionSchema>;
export type SimActionType = SimAction['type'];

export interface ActionResult {
  ok: boolean;
  message: string;
}
