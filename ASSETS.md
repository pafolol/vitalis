# Asset register

Every third-party asset used by Vitalis, where it came from, its licence, and what we changed.
Raw source files live in `assets-src/` (git-ignored). `npm run assets` regenerates the runtime assets in `public/assets/` from them. The build scripts download missing MakeHuman files automatically; BodyParts3D has to be downloaded manually (see below).

No proprietary virtual-patient assets (e.g. Body Interact) were used or referenced.

---

## 1. MakeHuman base mesh, rig, weights, targets and eyes: CC0 1.0

| Item | Source path (makehumancommunity/makehuman, `makehuman/data/…`) | Licence |
|---|---|---|
| Base mesh `3dobjs/base.obj` (hm08) | https://github.com/makehumancommunity/makehuman | CC0 1.0 (`LICENSE.ASSETS.md`; the file headers say "explicitly released as CC0 in September 2020") |
| Skeleton `rigs/default.mhskel` (163 bones) | same | CC0 |
| Skin weights `rigs/default_weights.mhw` | same | CC0 |
| Macro targets `targets/macrodetails/universal-{sex}-{age}-{muscle}-{weight}.target` (36) and `{african,asian,caucasian}-{sex}-{age}.target` (12) | same | CC0 |
| Expression units `targets/expression/units/caucasian/*.target` (17) | same | CC0 |
| High-poly eyes `eyes/high-poly/high-poly.{obj,mhclo}` and iris texture `eyes/materials/brown_eye.png` | same | CC0 |

Copyright holders at the time of the CC0 release: Data Collection AB, Joel Palmius, Jonas Hauquier.

**Modifications** (script: `scripts/assets/build-human.mjs`, output: `public/assets/human/human.{json,bin}`, `eye_brown.png`):
- Converted from decimetres to metres and packed into a compact binary. Faces are triangulated; the body quads are kept for runtime Catmull–Clark subdivision.
- Macro targets quantised to int16. The three race targets are averaged at equal weight, so facial morphology does not depend on skin tone.
- Kept the top four skin weights per vertex.
- Added region IDs and shading masks per vertex (brows, lips, flush zones, knees, acral areas, etc.).
- Generated new procedural morph targets: `breath-chest-left`, `breath-chest-right`, `breath-abdomen`, `cpr-compression`, `angioedema`.
- Eyes are refitted to every patient through the original `.mhclo` proxy binding. The iris texture is unchanged; pupil size is changed in the shader.
- Teeth and tongue come from the base-mesh helper geometry.

**Not used:** hair, skin textures, eyebrow and eyelash proxies, and clothing. The only copies we found (third-party mirrors of `makehuman-assets`) are AGPL-licensed. Hair (short fur shells), eyebrows, lips, stubble, areolae, underwear and all skin colouring are generated procedurally in shaders (`src/three/human/skinMaterial.ts`, `hairShells.ts`).

---

## 2. BodyParts3D anatomy: CC BY 4.0 (headers state CC BY-SA 2.1 JP)

- **Dataset:** BodyParts3D 4.0, "part-of" OBJ set (`partof_BP3D_4.0_obj_99.zip`, plus `partof_parts_list_e.txt`, `partof_element_parts.txt` and `partof_inclusion_relation_list.txt`).
- **Source:** https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
- **Required attribution:** "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International" (per https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html).
- **Licence caution:** the individual OBJ file headers still say *Creative Commons Attribution-Share Alike 2.1 Japan*. To be safe, the derived anatomy meshes in `public/assets/anatomy/*.glb` are treated as **CC BY-SA** adaptations of BodyParts3D, and the attribution above must accompany any redistribution. Application source code is not affected.

**Modifications** (script: `scripts/assets/build-anatomy.mjs`, outputs: `public/assets/anatomy/{skeleton,muscle,superficial,cardiovascular,respiratory,digestive,nervous,organs}.glb` and `anatomy-index.json`):
- Selected 191 structures. Element files were merged per structure, re-axed to +Y up and +Z anterior, and converted to metres.
- Simplified with meshoptimizer.
- Quantised and compressed with `EXT_meshopt_compression` via glTF-Transform.
- Removed the urethra (it protruded outside the MakeHuman body), the male genital system, and the chest-wall branches of the axillary artery (they distorted across the shoulder mapping).
- **Derived surfaces.** These are not in BodyParts3D; each is flagged `derived: true` in the index and is an approximation:
  - **Lungs (left/right):** envelope around the real bronchial tree and intrapulmonary vessels of each lung, built with a distance field, morphological closing, surface nets and Taubin smoothing.
  - **Heart (myocardium):** the real ventricular cavities dilated by typical wall thickness (LV ≈ 11 mm, RV ≈ 5.5 mm) and united with the real atrial walls. Vertex colours mark the LV, RV and atrial regions.
  - **Spinal cord:** a tapered tube along the vertebral-canal centre line, detected from the real C1–L1 vertebrae.
- **At runtime** (`src/three/anatomy/fit.ts`), structures are non-rigidly mapped into each generated patient's body and skinned to the MakeHuman skeleton. Placement is plausible and educational, not patient-accurate.

---

## 3. Procedural and first-party content

The following are generated in code, with no external assets:

- the ER room, stretcher, sheet, IV pole and bag
- monitor arm and headwall
- all clinical equipment props: ECG electrodes and leads, defibrillator pads, masks, BVM, ETT, cannulae, drains, tourniquets and SpO₂ probe
- canvas textures
- the lighting environment: drei `<Lightformer>`s, with no HDR downloads

Libraries (three.js, @react-three/fiber, @react-three/drei, meshoptimizer, glTF-Transform) are MIT-licensed npm dependencies.
