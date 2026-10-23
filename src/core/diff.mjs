/** Line diff with common prefix/suffix trimming, then LCS on the middle. */
export function lineDiff(beforeText = '', afterText = '') {
  const a = beforeText.split('\n');
  const b = afterText.split('\n');

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: 'eq', a: i, b: i, line: a[i] });

  const LIMIT = 1800;
  if (aMid.length > LIMIT || bMid.length > LIMIT) {
    aMid.forEach((l, i) => ops.push({ t: 'del', a: pre + i, line: l }));
    bMid.forEach((l, i) => ops.push({ t: 'add', b: pre + i, line: l }));
  } else {
    const m = aMid.length, n = bMid.length;
    const dp = new Uint32Array((m + 1) * (n + 1));
    const at = (i, j) => i * (n + 1) + j;
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[at(i, j)] = aMid[i] === bMid[j]
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) { ops.push({ t: 'eq', a: pre + i, b: pre + j, line: aMid[i] }); i++; j++; }
      else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { ops.push({ t: 'del', a: pre + i, line: aMid[i] }); i++; }
      else { ops.push({ t: 'add', b: pre + j, line: bMid[j] }); j++; }
    }
    while (i < m) { ops.push({ t: 'del', a: pre + i, line: aMid[i] }); i++; }
    while (j < n) { ops.push({ t: 'add', b: pre + j, line: bMid[j] }); j++; }
  }

  for (let i = 0; i < suf; i++) {
    const ai = a.length - suf + i;
    ops.push({ t: 'eq', a: ai, b: b.length - suf + i, line: a[ai] });
  }
  return ops;
}

/** Collapse to hunks with `context` equal lines around each change. */
export function hunks(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.t === 'eq') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let cur = null;
  keep.forEach((k, i) => {
    if (k) { if (!cur) { cur = []; out.push(cur); } cur.push(ops[i]); }
    else cur = null;
  });
  return out;
}

export function diffStats(ops) {
  let added = 0, removed = 0;
  for (const op of ops) { if (op.t === 'add') added++; else if (op.t === 'del') removed++; }
  return { added, removed, changed: added + removed };
}
