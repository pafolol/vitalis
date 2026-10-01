/**
 * One level of Catmull–Clark subdivision for the MakeHuman quad body mesh.
 *
 * Positions use the proper Catmull–Clark rules (with boundary handling);
 * per-vertex attributes (skin weights, masks, morph deltas) use the linear
 * stencil (face point = average of corners, edge point = average of end
 * points, vertex point = unchanged) which is standard practice for skinned
 * subdivision surfaces.
 */

export interface SubdivTopology {
  /** number of source vertices */
  nV: number;
  /** number of output vertices */
  nOut: number;
  /** output quads (4 indices each) */
  quads: Uint32Array;
  /** output triangles (6 per quad) */
  tris: Uint32Array;
  /** for each output vertex: up to 4 source vertices and weights (linear stencil) */
  stencilIdx: Uint32Array;
  stencilW: Float32Array;
  /** CC position rules evaluated by `subdividePositions` */
  faceStart: number;
  edgeStart: number;
  edges: Uint32Array; // pairs (a,b)
  edgeFaces: Int32Array; // pairs (f0,f1) (-1 = boundary)
  srcQuads: Uint32Array;
  /** vertex adjacency for vertex points */
  vertEdgeOffsets: Uint32Array;
  vertEdges: Uint32Array;
  vertFaceOffsets: Uint32Array;
  vertFaces: Uint32Array;
  /** source vertex that each output vertex is "attached" to (for region lookup) */
  primary: Uint32Array;
}

export function buildSubdivTopology(srcQuads: Uint32Array, nV: number): SubdivTopology {
  const nF = srcQuads.length / 4;
  const edgeMap = new Map<number, number>();
  const edgesArr: number[] = [];
  const edgeFacesArr: number[] = [];
  const faceEdges = new Uint32Array(nF * 4);
  const key = (a: number, b: number) => (a < b ? a * nV + b : b * nV + a);
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 4; k++) {
      const a = srcQuads[f * 4 + k];
      const b = srcQuads[f * 4 + ((k + 1) % 4)];
      const kk = key(a, b);
      let e = edgeMap.get(kk);
      if (e === undefined) {
        e = edgesArr.length / 2;
        edgeMap.set(kk, e);
        edgesArr.push(a, b);
        edgeFacesArr.push(f, -1);
      } else {
        edgeFacesArr[e * 2 + 1] = f;
      }
      faceEdges[f * 4 + k] = e;
    }
  }
  const nE = edgesArr.length / 2;
  const edges = new Uint32Array(edgesArr);
  const edgeFaces = new Int32Array(edgeFacesArr);

  // vertex adjacency (CSR)
  const vEdgeCount = new Uint32Array(nV);
  const vFaceCount = new Uint32Array(nV);
  for (let e = 0; e < nE; e++) {
    vEdgeCount[edges[e * 2]]++;
    vEdgeCount[edges[e * 2 + 1]]++;
  }
  for (let i = 0; i < srcQuads.length; i++) vFaceCount[srcQuads[i]]++;
  const vertEdgeOffsets = new Uint32Array(nV + 1);
  const vertFaceOffsets = new Uint32Array(nV + 1);
  for (let v = 0; v < nV; v++) {
    vertEdgeOffsets[v + 1] = vertEdgeOffsets[v] + vEdgeCount[v];
    vertFaceOffsets[v + 1] = vertFaceOffsets[v] + vFaceCount[v];
  }
  const vertEdges = new Uint32Array(vertEdgeOffsets[nV]);
  const vertFaces = new Uint32Array(vertFaceOffsets[nV]);
  const fillE = vertEdgeOffsets.slice(0, nV);
  const fillF = vertFaceOffsets.slice(0, nV);
  for (let e = 0; e < nE; e++) {
    vertEdges[fillE[edges[e * 2]]++] = e;
    vertEdges[fillE[edges[e * 2 + 1]]++] = e;
  }
  for (let f = 0; f < nF; f++) for (let k = 0; k < 4; k++) vertFaces[fillF[srcQuads[f * 4 + k]]++] = f;

  // output vertex layout: [vertex points (nV)] [face points (nF)] [edge points (nE)]
  const faceStart = nV;
  const edgeStart = nV + nF;
  const nOut = nV + nF + nE;
  const stencilIdx = new Uint32Array(nOut * 4);
  const stencilW = new Float32Array(nOut * 4);
  const primary = new Uint32Array(nOut);
  for (let v = 0; v < nV; v++) {
    stencilIdx[v * 4] = v;
    stencilW[v * 4] = 1;
    primary[v] = v;
  }
  for (let f = 0; f < nF; f++) {
    const o = faceStart + f;
    for (let k = 0; k < 4; k++) {
      stencilIdx[o * 4 + k] = srcQuads[f * 4 + k];
      stencilW[o * 4 + k] = 0.25;
    }
    primary[o] = srcQuads[f * 4];
  }
  for (let e = 0; e < nE; e++) {
    const o = edgeStart + e;
    stencilIdx[o * 4] = edges[e * 2];
    stencilIdx[o * 4 + 1] = edges[e * 2 + 1];
    stencilW[o * 4] = 0.5;
    stencilW[o * 4 + 1] = 0.5;
    primary[o] = edges[e * 2];
  }

  const quads = new Uint32Array(nF * 16);
  const tris = new Uint32Array(nF * 24);
  for (let f = 0; f < nF; f++) {
    const fp = faceStart + f;
    for (let k = 0; k < 4; k++) {
      const v = srcQuads[f * 4 + k];
      const eNext = edgeStart + faceEdges[f * 4 + k];
      const ePrev = edgeStart + faceEdges[f * 4 + ((k + 3) % 4)];
      const q = [v, eNext, fp, ePrev];
      quads.set(q, f * 16 + k * 4);
      tris.set([q[0], q[1], q[2], q[0], q[2], q[3]], f * 24 + k * 6);
    }
  }
  return {
    nV,
    nOut,
    quads,
    tris,
    stencilIdx,
    stencilW,
    faceStart,
    edgeStart,
    edges,
    edgeFaces,
    srcQuads,
    vertEdgeOffsets,
    vertEdges,
    vertFaceOffsets,
    vertFaces,
    primary,
  };
}

/** Catmull–Clark positions. `src` must contain at least `topo.nV` xyz triples. */
export function subdividePositions(topo: SubdivTopology, src: Float32Array): Float32Array {
  const { nV, faceStart, edgeStart, edges, edgeFaces, srcQuads } = topo;
  const nF = srcQuads.length / 4;
  const nE = edges.length / 2;
  const out = new Float32Array(topo.nOut * 3);
  // face points
  for (let f = 0; f < nF; f++) {
    const o = (faceStart + f) * 3;
    for (let k = 0; k < 4; k++) {
      const v = srcQuads[f * 4 + k] * 3;
      out[o] += src[v] * 0.25;
      out[o + 1] += src[v + 1] * 0.25;
      out[o + 2] += src[v + 2] * 0.25;
    }
  }
  // edge points
  const boundaryV = new Uint8Array(nV);
  for (let e = 0; e < nE; e++) {
    const a = edges[e * 2] * 3;
    const b = edges[e * 2 + 1] * 3;
    const o = (edgeStart + e) * 3;
    const f1 = edgeFaces[e * 2 + 1];
    if (f1 < 0) {
      boundaryV[edges[e * 2]] = 1;
      boundaryV[edges[e * 2 + 1]] = 1;
      out[o] = (src[a] + src[b]) / 2;
      out[o + 1] = (src[a + 1] + src[b + 1]) / 2;
      out[o + 2] = (src[a + 2] + src[b + 2]) / 2;
    } else {
      const fa = (faceStart + edgeFaces[e * 2]) * 3;
      const fb = (faceStart + f1) * 3;
      out[o] = (src[a] + src[b] + out[fa] + out[fb]) / 4;
      out[o + 1] = (src[a + 1] + src[b + 1] + out[fa + 1] + out[fb + 1]) / 4;
      out[o + 2] = (src[a + 2] + src[b + 2] + out[fa + 2] + out[fb + 2]) / 4;
    }
  }
  // vertex points
  for (let v = 0; v < nV; v++) {
    const e0 = topo.vertEdgeOffsets[v];
    const e1 = topo.vertEdgeOffsets[v + 1];
    const n = e1 - e0;
    const o = v * 3;
    if (n === 0) {
      out[o] = src[o];
      out[o + 1] = src[o + 1];
      out[o + 2] = src[o + 2];
      continue;
    }
    if (boundaryV[v]) {
      // boundary rule: (6P + b1 + b2) / 8 using boundary neighbours
      let sx = 0, sy = 0, sz = 0, c = 0;
      for (let i = e0; i < e1; i++) {
        const e = topo.vertEdges[i];
        if (edgeFaces[e * 2 + 1] >= 0) continue;
        const other = (edges[e * 2] === v ? edges[e * 2 + 1] : edges[e * 2]) * 3;
        sx += src[other];
        sy += src[other + 1];
        sz += src[other + 2];
        c++;
      }
      if (c === 2) {
        out[o] = (6 * src[o] + sx) / 8;
        out[o + 1] = (6 * src[o + 1] + sy) / 8;
        out[o + 2] = (6 * src[o + 2] + sz) / 8;
      } else {
        out[o] = src[o];
        out[o + 1] = src[o + 1];
        out[o + 2] = src[o + 2];
      }
      continue;
    }
    let fx = 0, fy = 0, fz = 0;
    const f0 = topo.vertFaceOffsets[v];
    const f1 = topo.vertFaceOffsets[v + 1];
    for (let i = f0; i < f1; i++) {
      const fp = (faceStart + topo.vertFaces[i]) * 3;
      fx += out[fp];
      fy += out[fp + 1];
      fz += out[fp + 2];
    }
    const nf = f1 - f0;
    fx /= nf;
    fy /= nf;
    fz /= nf;
    let rx = 0, ry = 0, rz = 0;
    for (let i = e0; i < e1; i++) {
      const e = topo.vertEdges[i];
      const a = edges[e * 2] * 3;
      const b = edges[e * 2 + 1] * 3;
      rx += (src[a] + src[b]) / 2;
      ry += (src[a + 1] + src[b + 1]) / 2;
      rz += (src[a + 2] + src[b + 2]) / 2;
    }
    rx /= n;
    ry /= n;
    rz /= n;
    out[o] = (fx + 2 * rx + (n - 3) * src[o]) / n;
    out[o + 1] = (fy + 2 * ry + (n - 3) * src[o + 1]) / n;
    out[o + 2] = (fz + 2 * rz + (n - 3) * src[o + 2]) / n;
  }
  return out;
}

/** Applies the linear stencil to an attribute with `size` components per source vertex. */
export function subdivideLinear(topo: SubdivTopology, src: ArrayLike<number>, size: number): Float32Array {
  const out = new Float32Array(topo.nOut * size);
  for (let o = 0; o < topo.nOut; o++) {
    for (let k = 0; k < 4; k++) {
      const w = topo.stencilW[o * 4 + k];
      if (!w) continue;
      const s = topo.stencilIdx[o * 4 + k] * size;
      for (let c = 0; c < size; c++) out[o * size + c] += src[s + c] * w;
    }
  }
  return out;
}

/** Subdivides top-4 skin weights (bone index/weight pairs) and renormalises. */
export function subdivideSkin(topo: SubdivTopology, idx: ArrayLike<number>, w: ArrayLike<number>, wScale: number) {
  const outIdx = new Uint16Array(topo.nOut * 4);
  const outW = new Float32Array(topo.nOut * 4);
  const acc = new Map<number, number>();
  for (let o = 0; o < topo.nOut; o++) {
    acc.clear();
    for (let k = 0; k < 4; k++) {
      const sw = topo.stencilW[o * 4 + k];
      if (!sw) continue;
      const s = topo.stencilIdx[o * 4 + k] * 4;
      for (let j = 0; j < 4; j++) {
        const ww = w[s + j] * wScale * sw;
        if (ww <= 0) continue;
        acc.set(idx[s + j], (acc.get(idx[s + j]) ?? 0) + ww);
      }
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, e) => s + e[1], 0) || 1;
    top.forEach(([b, ww], j) => {
      outIdx[o * 4 + j] = b;
      outW[o * 4 + j] = ww / sum;
    });
  }
  return { idx: outIdx, w: outW };
}
