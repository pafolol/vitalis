import * as THREE from 'three';

/** Small procedural textures for the room (no external image assets needed). */
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = 1, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRoomMaterials() {
  const rnd = mulberry(7);
  // speckled hospital vinyl floor
  const floorMap = canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = '#c9ced1';
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 9000; i++) {
        const v = 150 + Math.floor(rnd() * 90);
        g.fillStyle = `rgba(${v},${v + 4},${v + 8},${0.35 + rnd() * 0.4})`;
        const s = 1 + rnd() * 2.2;
        g.fillRect(rnd() * 512, rnd() * 512, s, s);
      }
      // welded seams
      g.fillStyle = 'rgba(120,128,134,0.5)';
      g.fillRect(0, 0, 512, 2);
      g.fillRect(0, 0, 2, 512);
    },
    6,
  );
  const floor = new THREE.MeshPhysicalMaterial({ map: floorMap, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3 });

  const wallMap = canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#dfe4e3';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 3000; i++) {
        const v = 215 + Math.floor(rnd() * 20);
        g.fillStyle = `rgba(${v},${v + 3},${v + 2},0.25)`;
        g.fillRect(rnd() * 256, rnd() * 256, 2, 2);
      }
    },
    3,
  );
  const wall = new THREE.MeshStandardMaterial({ map: wallMap, roughness: 0.9 });
  const wallAccent = new THREE.MeshStandardMaterial({ color: new THREE.Color('#5d7f86'), roughness: 0.85 });
  const headwall = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#e9ecec'), roughness: 0.35, clearcoat: 0.4 });
  const steel = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#c3c8cc'), metalness: 0.9, roughness: 0.28 });
  const darkPlastic = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#2a2f35'), roughness: 0.45 });
  const lightPlastic = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#e7e9ea'), roughness: 0.4, clearcoat: 0.2 });
  const mattress = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#3f5f78'), roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color('#6d8ca5') });
  const sheetMap = canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#eef1f3';
      g.fillRect(0, 0, 256, 256);
      g.strokeStyle = 'rgba(160,185,205,0.35)';
      for (let i = 0; i < 256; i += 4) {
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i, 256);
        g.stroke();
      }
      g.strokeStyle = 'rgba(150,170,190,0.18)';
      for (let i = 0; i < 256; i += 3) {
        g.beginPath();
        g.moveTo(0, i);
        g.lineTo(256, i);
        g.stroke();
      }
    },
    10,
  );
  const sheet = new THREE.MeshPhysicalMaterial({
    map: sheetMap,
    color: new THREE.Color('#f4f6f7'),
    roughness: 0.92,
    sheen: 0.7,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color('#cfdbe6'),
    side: THREE.DoubleSide,
  });
  const blanket = new THREE.MeshPhysicalMaterial({
    map: sheetMap,
    color: new THREE.Color('#dfe8ef'),
    roughness: 0.96,
    sheen: 0.5,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color('#f3f7fa'),
    side: THREE.DoubleSide,
  });
  const pillow = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#f3f5f6'), roughness: 0.9, sheen: 0.6, sheenColor: new THREE.Color('#dde6ee') });
  const screen = new THREE.MeshBasicMaterial({ color: new THREE.Color('#0b1116') });
  const o2 = new THREE.MeshStandardMaterial({ color: new THREE.Color('#1f8f4e'), roughness: 0.4 });
  const air = new THREE.MeshStandardMaterial({ color: new THREE.Color('#e9e9e9'), roughness: 0.4 });
  const vac = new THREE.MeshStandardMaterial({ color: new THREE.Color('#e6c21a'), roughness: 0.4 });
  const all = [floor, wall, wallAccent, headwall, steel, darkPlastic, lightPlastic, mattress, sheet, blanket, pillow, screen, o2, air, vac];
  return {
    floor,
    wall,
    wallAccent,
    headwall,
    steel,
    darkPlastic,
    lightPlastic,
    mattress,
    sheet,
    blanket,
    pillow,
    screen,
    o2,
    air,
    vac,
    dispose() {
      for (const m of all) {
        const mm = m as THREE.MeshStandardMaterial;
        mm.map?.dispose();
        m.dispose();
      }
    },
  };
}

export type RoomMaterials = ReturnType<typeof createRoomMaterials>;
