/**
 * Zero-dependency JavaScript inference runtime for SIMPUL ATNT GNN-MAPPO Actor.
 * Mirrors PyTorch ATNTActor forward pass identically over Float32Array tensors
 * for offline/browser fallback inside simpul-interactive when FPGA/FastAPI are unavailable.
 */

function linearLayer(x, rows, inDim, weightObj, biasObj, activation = 'none') {
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

function matmul(a, rowsA, inner, b, colsB) {
  const out = new Float32Array(rowsA * colsB);
  for (let i = 0; i < rowsA; i++) {
    const aBase = i * inner;
    const oBase = i * colsB;
    for (let k = 0; k < inner; k++) {
      const aik = a[aBase + k];
      if (aik === 0) continue;
      const bBase = k * colsB;
      for (let j = 0; j < colsB; j++) {
        out[oBase + j] += aik * b[bBase + j];
      }
    }
  }
  return out;
}

function matmulTransposeA(a, rowsA, colsA, b, colsB) {
  // computes A^T (colsA x rowsA) @ B (rowsA x colsB) -> (colsA x colsB)
  const out = new Float32Array(colsA * colsB);
  for (let k = 0; k < rowsA; k++) {
    const aBase = k * colsA;
    const bBase = k * colsB;
    for (let i = 0; i < colsA; i++) {
      const aki = a[aBase + i];
      if (aki === 0) continue;
      const oBase = i * colsB;
      for (let j = 0; j < colsB; j++) {
        out[oBase + j] += aki * b[bBase + j];
      }
    }
  }
  return out;
}

function applyMask(x, mask, rows, dim) {
  for (let r = 0; r < rows; r++) {
    const m = mask[r];
    if (m === 1) continue;
    const base = r * dim;
    for (let d = 0; d < dim; d++) x[base + d] *= m;
  }
  return x;
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

export function inferATNTActorJS(weightsPayload, tensors) {
  const arch = weightsPayload.architecture;
  const sd = weightsPayload.state_dict;
  const H = arch.hidden_dim;
  const Ni = arch.tensor_limits.max_intersections;
  const Nr = arch.tensor_limits.max_roads;
  const Nm = arch.tensor_limits.max_movements;
  const Di = arch.tensor_limits.inter_feat_dim;
  const Dr = arch.tensor_limits.road_feat_dim;
  const Dm = arch.tensor_limits.mov_feat_dim;
  const A = arch.num_actions;

  const interX = Float32Array.from(tensors.inter_x);
  const roadX = Float32Array.from(tensors.road_x);
  const movX = Float32Array.from(tensors.mov_x);
  const interMask = Float32Array.from(tensors.inter_mask);
  const roadMask = Float32Array.from(tensors.road_mask);
  const movMask = Float32Array.from(tensors.mov_mask);
  const adjR2IIn = Float32Array.from(tensors.adj_r2i_in);
  const adjR2IOut = Float32Array.from(tensors.adj_r2i_out);
  const adjM2I = Float32Array.from(tensors.adj_m2i);
  const adjI2I = Float32Array.from(tensors.adj_i2i);
  const actionMask = Float32Array.from(tensors.action_mask);

  let hI;
  if (arch.encoder_type === 'mlp') {
    let h = linearLayer(interX, Ni, Di, sd['encoder.fc1.weight'], sd['encoder.fc1.bias'], 'relu');
    h = linearLayer(h, Ni, H, sd['encoder.fc2.weight'], sd['encoder.fc2.bias'], 'relu');
    hI = applyMask(linearLayer(h, Ni, H, sd['encoder.fc3.weight'], sd['encoder.fc3.bias'], 'relu'), interMask, Ni, H);
  } else {
    hI = applyMask(
      linearLayer(
        linearLayer(interX, Ni, Di, sd['encoder.inter_enc_1.weight'], sd['encoder.inter_enc_1.bias'], 'relu'),
        Ni, H, sd['encoder.inter_enc_2.weight'], sd['encoder.inter_enc_2.bias'], 'relu'
      ),
      interMask, Ni, H
    );
    let hR = applyMask(
      linearLayer(
        linearLayer(roadX, Nr, Dr, sd['encoder.road_enc_1.weight'], sd['encoder.road_enc_1.bias'], 'relu'),
        Nr, H, sd['encoder.road_enc_2.weight'], sd['encoder.road_enc_2.bias'], 'relu'
      ),
      roadMask, Nr, H
    );
    let hM = applyMask(
      linearLayer(
        linearLayer(movX, Nm, Dm, sd['encoder.mov_enc_1.weight'], sd['encoder.mov_enc_1.bias'], 'relu'),
        Nm, H, sd['encoder.mov_enc_2.weight'], sd['encoder.mov_enc_2.bias'], 'relu'
      ),
      movMask, Nm, H
    );

    for (let l = 0; l < arch.num_layers; l++) {
      const p = `encoder.mp_layers.${l}`;
      const gateR = linearLayer(hR, Nr, H, sd[`${p}.road_gate.weight`], sd[`${p}.road_gate.bias`], 'sigmoid');
      const mRIn = linearLayer(hR, Nr, H, sd[`${p}.road_in_msg.weight`], sd[`${p}.road_in_msg.bias`], 'relu');
      const mROut = linearLayer(hR, Nr, H, sd[`${p}.road_out_msg.weight`], sd[`${p}.road_out_msg.bias`], 'relu');
      for (let k = 0; k < mRIn.length; k++) {
        mRIn[k] *= gateR[k];
        mROut[k] *= gateR[k];
      }
      const mMov = linearLayer(hM, Nm, H, sd[`${p}.mov_msg.weight`], sd[`${p}.mov_msg.bias`], 'relu');
      const mNbr = linearLayer(hI, Ni, H, sd[`${p}.nbr_msg.weight`], sd[`${p}.nbr_msg.bias`], 'relu');

      const aggIn = matmul(adjR2IIn, Ni, Nr, mRIn, H);
      const aggOut = matmul(adjR2IOut, Ni, Nr, mROut, H);
      const aggMov = matmul(adjM2I, Ni, Nm, mMov, H);
      const aggNbr = matmul(adjI2I, Ni, Ni, mNbr, H);

      const catI = concatLast([hI, aggIn, aggOut, aggMov, aggNbr], Ni, [H, H, H, H, H]);
      const dhI = linearLayer(
        linearLayer(catI, Ni, H * 5, sd[`${p}.inter_up_1.weight`], sd[`${p}.inter_up_1.bias`], 'relu'),
        Ni, H, sd[`${p}.inter_up_2.weight`], sd[`${p}.inter_up_2.bias`], 'none'
      );
      const hINext = new Float32Array(Ni * H);
      for (let k = 0; k < hINext.length; k++) hINext[k] = hI[k] + dhI[k];
      applyMask(hINext, interMask, Ni, H);

      const adjSumR2I = new Float32Array(adjR2IIn.length);
      for (let k = 0; k < adjSumR2I.length; k++) adjSumR2I[k] = adjR2IIn[k] + adjR2IOut[k];
      const iToR = matmulTransposeA(adjSumR2I, Ni, Nr, hINext, H);
      for (let k = 0; k < iToR.length; k++) iToR[k] *= 0.5;
      const iToM = matmulTransposeA(adjM2I, Ni, Nm, hINext, H);

      const dR = linearLayer(concatLast([hR, iToR], Nr, [H, H]), Nr, H * 2, sd[`${p}.road_up.weight`], sd[`${p}.road_up.bias`], 'relu');
      const dM = linearLayer(concatLast([hM, iToM], Nm, [H, H]), Nm, H * 2, sd[`${p}.mov_up.weight`], sd[`${p}.mov_up.bias`], 'relu');
      for (let k = 0; k < hR.length; k++) hR[k] += dR[k];
      for (let k = 0; k < hM.length; k++) hM[k] += dM[k];
      applyMask(hR, roadMask, Nr, H);
      applyMask(hM, movMask, Nm, H);
      hI = hINext;
    }

    if (arch.use_temporal_forecast) {
      const roadFc = applyMask(
        linearLayer(hR, Nr, H, sd['encoder.forecast_head.weight'], sd['encoder.forecast_head.bias'], 'none'),
        roadMask, Nr, 2
      );
      const aggFc = matmul(adjR2IIn, Ni, Nr, roadFc, 2);
      hI = applyMask(
        linearLayer(concatLast([hI, aggFc], Ni, [H, 2]), Ni, H + 2, sd['encoder.forecast_fuse.weight'], sd['encoder.forecast_fuse.bias'], 'relu'),
        interMask, Ni, H
      );
    }
  }

  const hPolicy = linearLayer(hI, Ni, H, sd['head_1.weight'], sd['head_1.bias'], 'relu');
  const rawLogits = linearLayer(hPolicy, Ni, H, sd['head_2.weight'], sd['head_2.bias'], 'none');

  const maskedLogits = new Float32Array(Ni * A);
  const probs = new Float32Array(Ni * A);
  const actions = new Int32Array(Ni);

  for (let i = 0; i < Ni; i++) {
    const base = i * A;
    let maxL = -Infinity;
    for (let a = 0; a < A; a++) {
      const ml = rawLogits[base + a] + (1.0 - actionMask[base + a]) * -1e9;
      maskedLogits[base + a] = ml;
      if (ml > maxL) maxL = ml;
    }
    let expSum = 0;
    let bestA = 0;
    let bestP = -1;
    for (let a = 0; a < A; a++) {
      const e = Math.exp(maskedLogits[base + a] - maxL);
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

  return { maskedLogits, probs, actions };
}
