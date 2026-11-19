/**
 * Zero-dependency sparse JavaScript inference runtime for SIMPUL ATNT GNN-MAPPO ActorV2.
 * Mirrors PyTorch HeteroSpatioTemporalGNNEncoder + ATNTActorV2 (including learned mov_head)
 * over sparse incidence lists of any graph size (single study area or connected 3-region graph).
 */

function linearSparse(x, rows, inDim, weightObj, biasObj, activation = 'none') {
  const outDim = weightObj.shape[0];
  const w = weightObj.data;
  const b = biasObj.data;
  const out = new Float32Array(rows * outDim);
  for (let r = 0; r < rows; r++) {
    const xBase = r * inDim;
    const oBase = r * outDim;
    for (let o = 0; o < outDim; o++) {
      let acc = b[o];
      const wBase = o * inDim;
      for (let k = 0; k < inDim; k++) {
        acc += x[xBase + k] * w[wBase + k];
      }
      if (activation === 'relu') {
        acc = acc > 0 ? acc : 0;
      } else if (activation === 'sigmoid') {
        acc = 1 / (1 + Math.exp(-Math.max(-60, Math.min(60, acc))));
      }
      out[oBase + o] = acc;
    }
  }
  return out;
}

function sparseAgg(srcH, adjRows, dim) {
  const rows = adjRows.length;
  const out = new Float32Array(rows * dim);
  for (let r = 0; r < rows; r++) {
    const nbrs = adjRows[r];
    if (!nbrs || !nbrs.length) continue;
    const oBase = r * dim;
    for (let j = 0; j < nbrs.length; j++) {
      const [srcIdx, weight] = nbrs[j];
      const sBase = srcIdx * dim;
      for (let d = 0; d < dim; d++) {
        out[oBase + d] += weight * srcH[sBase + d];
      }
    }
  }
  return out;
}

function concatLast(arrays, rows, dims) {
  const totalDim = dims.reduce((s, d) => s + d, 0);
  const out = new Float32Array(rows * totalDim);
  for (let r = 0; r < rows; r++) {
    let offset = 0;
    for (let aIdx = 0; aIdx < arrays.length; aIdx++) {
      const arr = arrays[aIdx];
      const d = dims[aIdx];
      const srcBase = r * d;
      const dstBase = r * totalDim + offset;
      for (let k = 0; k < d; k++) out[dstBase + k] = arr[srcBase + k];
      offset += d;
    }
  }
  return out;
}

export function inferATNTActorJS(weightsPayload, graphAndFeatures) {
  const arch = weightsPayload.architecture;
  const sd = weightsPayload.state_dict;
  const H = arch.hidden_dim;
  const Di = arch.tensor_limits.inter_feat_dim;
  const Dr = arch.tensor_limits.road_feat_dim;
  const Dm = arch.tensor_limits.mov_feat_dim;
  const A = arch.num_actions;

  const {
    nI, nR, nM,
    interX, roadX, movX,
    adjR2IIn, adjR2IOut, adjI2RT, adjI2I, adjM2I, adjI2MT,
    movFrom, movTo, movGroups, movClosed, actionMask,
  } = graphAndFeatures;

  let hI = linearSparse(
    linearSparse(interX, nI, Di, sd['encoder.inter_enc_1.weight'], sd['encoder.inter_enc_1.bias'], 'relu'),
    nI, H, sd['encoder.inter_enc_2.weight'], sd['encoder.inter_enc_2.bias'], 'relu',
  );
  const hR = linearSparse(
    linearSparse(roadX, nR, Dr, sd['encoder.road_enc_1.weight'], sd['encoder.road_enc_1.bias'], 'relu'),
    nR, H, sd['encoder.road_enc_2.weight'], sd['encoder.road_enc_2.bias'], 'relu',
  );
  const hM = linearSparse(
    linearSparse(movX, nM, Dm, sd['encoder.mov_enc_1.weight'], sd['encoder.mov_enc_1.bias'], 'relu'),
    nM, H, sd['encoder.mov_enc_2.weight'], sd['encoder.mov_enc_2.bias'], 'relu',
  );

  for (let l = 0; l < arch.num_layers; l++) {
    const p = `encoder.mp_layers.${l}`;
    const gateR = linearSparse(hR, nR, H, sd[`${p}.road_gate.weight`], sd[`${p}.road_gate.bias`], 'sigmoid');
    const mRIn = linearSparse(hR, nR, H, sd[`${p}.road_in_msg.weight`], sd[`${p}.road_in_msg.bias`], 'relu');
    const mROut = linearSparse(hR, nR, H, sd[`${p}.road_out_msg.weight`], sd[`${p}.road_out_msg.bias`], 'relu');
    for (let k = 0; k < mRIn.length; k++) {
      mRIn[k] *= gateR[k];
      mROut[k] *= gateR[k];
    }
    const mMov = linearSparse(hM, nM, H, sd[`${p}.mov_msg.weight`], sd[`${p}.mov_msg.bias`], 'relu');
    const mNbr = linearSparse(hI, nI, H, sd[`${p}.nbr_msg.weight`], sd[`${p}.nbr_msg.bias`], 'relu');

    const aggIn = sparseAgg(mRIn, adjR2IIn, H);
    const aggOut = sparseAgg(mROut, adjR2IOut, H);
    const aggMov = sparseAgg(mMov, adjM2I, H);
    const aggNbr = sparseAgg(mNbr, adjI2I, H);

    const catI = concatLast([hI, aggIn, aggOut, aggMov, aggNbr], nI, [H, H, H, H, H]);
    const dhI = linearSparse(
      linearSparse(catI, nI, H * 5, sd[`${p}.inter_up_1.weight`], sd[`${p}.inter_up_1.bias`], 'relu'),
      nI, H, sd[`${p}.inter_up_2.weight`], sd[`${p}.inter_up_2.bias`], 'none',
    );
    const hINext = new Float32Array(nI * H);
    for (let k = 0; k < hINext.length; k++) hINext[k] = hI[k] + dhI[k];

    const iToR = sparseAgg(hINext, adjI2RT, H);
    const iToM = sparseAgg(hINext, adjI2MT, H);
    const dR = linearSparse(concatLast([hR, iToR], nR, [H, H]), nR, H * 2, sd[`${p}.road_up.weight`], sd[`${p}.road_up.bias`], 'relu');
    const dM = linearSparse(concatLast([hM, iToM], nM, [H, H]), nM, H * 2, sd[`${p}.mov_up.weight`], sd[`${p}.mov_up.bias`], 'relu');
    for (let k = 0; k < hR.length; k++) hR[k] += dR[k];
    for (let k = 0; k < hM.length; k++) hM[k] += dM[k];
    hI = hINext;
  }

  if (arch.use_temporal_forecast) {
    const roadFc = linearSparse(hR, nR, H, sd['encoder.forecast_head.weight'], sd['encoder.forecast_head.bias'], 'none');
    const aggFc = sparseAgg(roadFc, adjR2IIn, 2);
    hI = linearSparse(
      concatLast([hI, aggFc], nI, [H, 2]),
      nI, H + 2, sd['encoder.forecast_fuse.weight'], sd['encoder.forecast_fuse.bias'], 'relu',
    );
  }

  const hPolicy = linearSparse(hI, nI, H, sd['head_1.weight'], sd['head_1.bias'], 'relu');
  const rawLogits = linearSparse(hPolicy, nI, H, sd['head_2.weight'], sd['head_2.bias'], 'none');

  const probs = new Float32Array(nI * A);
  const actions = new Int32Array(nI);
  for (let i = 0; i < nI; i++) {
    const base = i * A;
    let maxL = -Infinity;
    for (let a = 0; a < A; a++) {
      const maskVal = actionMask ? actionMask[base + a] : 1;
      const ml = rawLogits[base + a] + (1 - maskVal) * -1e9;
      if (ml > maxL) maxL = ml;
    }
    let expSum = 0;
    let bestA = 0;
    let bestP = -1;
    for (let a = 0; a < A; a++) {
      const maskVal = actionMask ? actionMask[base + a] : 1;
      const ml = rawLogits[base + a] + (1 - maskVal) * -1e9;
      const e = Math.exp(ml - maxL);
      probs[base + a] = e;
      expSum += e;
    }
    for (let a = 0; a < A; a++) {
      probs[base + a] /= Math.max(1e-12, expSum);
      if (probs[base + a] > bestP) {
        bestP = probs[base + a];
        bestA = a;
      }
    }
    actions[i] = bestA;
  }

  // ATNTActorV2 learned movement routing scores
  let movScores = null;
  const hasMovHead = Boolean(arch.has_mov_head && sd['mov_head_1.weight'] && sd['mov_head_2.weight']);
  if (hasMovHead && nM > 0) {
    const movCat = new Float32Array(nM * H * 3);
    for (let m = 0; m < nM; m++) {
      const dst = m * H * 3;
      const mOff = m * H;
      const fOff = movFrom[m] * H;
      const tOff = movTo[m] * H;
      for (let d = 0; d < H; d++) {
        movCat[dst + d] = hM[mOff + d];
        movCat[dst + H + d] = hR[fOff + d];
        movCat[dst + H * 2 + d] = hR[tOff + d];
      }
    }
    const hMov = linearSparse(movCat, nM, H * 3, sd['mov_head_1.weight'], sd['mov_head_1.bias'], 'relu');
    const movLogits = linearSparse(hMov, nM, H, sd['mov_head_2.weight'], sd['mov_head_2.bias'], 'none');
    movScores = new Float32Array(nM);
    for (const grp of movGroups || []) {
      const openIdx = grp.filter(m => !movClosed?.[m]);
      if (!openIdx.length) continue;
      let maxV = -Infinity;
      for (const m of openIdx) {
        const v = movLogits[m];
        if (v > maxV) maxV = v;
      }
      let denom = 0;
      for (const m of openIdx) {
        const ev = Math.exp(Math.max(-20, Math.min(20, movLogits[m] - maxV)));
        movScores[m] = ev;
        denom += ev;
      }
      for (const m of openIdx) {
        movScores[m] = Math.max(0.01, Math.min(1, movScores[m] / Math.max(1e-9, denom)));
      }
    }
  }

  return { probs, actions, movScores, hasMovHead };
}
