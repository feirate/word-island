// A small shared budget for the world and its single companion preview.
export function createRenderPolicy({ coarsePointer = false, devicePixelRatio = 1 } = {}) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Object.freeze({
    activeFps: coarsePointer ? 30 : 60,
    idleFps: coarsePointer ? 12 : 20,
    idleAfterMs: 5000,
    shadowSize: coarsePointer ? 512 : 1024,
    shadowIntervalMs: coarsePointer ? 250 : 150,
    maxPixelRatio: Math.min(ratio, coarsePointer ? 1 : 1.5),
    maxPixels: coarsePointer ? 900000 : 1800000,
  });
}

export function renderPixelRatio(policy, width, height) {
  const area = Math.max(1, width * height || 1);
  return Math.min(policy.maxPixelRatio, Math.sqrt(policy.maxPixels / area));
}

export function renderIntervalMs(policy, { now, lastInteractionAt, busy = false }) {
  return 1000 / (busy || now - lastInteractionAt < policy.idleAfterMs ? policy.activeFps : policy.idleFps);
}
