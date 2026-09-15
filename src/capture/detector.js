/**
 * Detector — README §2.4.
 *
 * MediaPipe Tasks Vision ObjectDetector with EfficientDet-Lite0 on the GPU
 * delegate. It carries the COCO classes, which include `horse` and `person`.
 *
 * Kept behind a ONE-FUNCTION interface so the upgrade to a fine-tuned YOLOv8n
 * is contained to this file:
 *
 *   detect(image, {roi}) -> [{category, score, x, y, w, h}]   // frame pixels
 */

export const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
export const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';

export async function createMediaPipeDetector({ scoreThreshold = 0.3, maxResults = 8 } = {}) {
  const { FilesetResolver, ObjectDetector } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
  let detector = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    scoreThreshold,
    maxResults,
    runningMode: 'VIDEO',
  }).catch(async (err) => {
    // Plenty of Android GPUs refuse the delegate. CPU is slower but alive.
    console.warn('GPU delegate unavailable, falling back to CPU', err);
    return ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      scoreThreshold,
      maxResults,
      runningMode: 'VIDEO',
    });
  });

  return {
    /**
     * @param {ImageBitmap|VideoFrame|OffscreenCanvas} image  the ROI crop
     * @param {{timestampMs:number, offsetX:number, offsetY:number, scale:number}} ctx
     * @returns {Array<{category:string, score:number, x:number, y:number, w:number, h:number}>}
     *          boxes mapped back into FULL-FRAME pixel coordinates
     */
    detect(image, { timestampMs, offsetX = 0, offsetY = 0, scale = 1 }) {
      const result = detector.detectForVideo(image, timestampMs);
      return (result.detections ?? []).map((d) => {
        const box = d.boundingBox;
        const top = d.categories?.[0] ?? { categoryName: 'unknown', score: 0 };
        return {
          category: top.categoryName,
          score: top.score,
          x: offsetX + box.originX * scale,
          y: offsetY + box.originY * scale,
          w: box.width * scale,
          h: box.height * scale,
        };
      });
    },
    close() {
      detector?.close?.();
      detector = null;
    },
  };
}

/**
 * Deterministic stand-in used by the offline tuning harness and the tests
 * (build order step 3): replays a scripted track so the whole control loop can
 * be exercised without a model download or a camera.
 */
export function createScriptedDetector(frames) {
  let i = 0;
  return {
    detect() {
      return frames[Math.min(i++, frames.length - 1)] ?? [];
    },
    close() {},
  };
}
