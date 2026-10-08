import type { Detection } from '@mediapipe/tasks-vision';
import { PerceptionResultSchema, type PerceptionResult } from '../contracts';

// Model-native plausibility evidence. BlazeFace ships six facial keypoints
// (left eye, right eye, nose tip, mouth center, ear tragions) with every
// detection, as fractions of the input image. A real face has two clearly
// separated eyes above the nose and the mouth — geometry no login-page logo,
// texture or UI block can satisfy. The production path previously discarded
// these fields, which is how a half-page box over ordinary content could
// arrive as "Face 1" and be masked wholesale. Measured on a real 520px face
// box: eye separation 191px (0.37 of the box), eyes at y 202/240, nose 349,
// mouth 455.
const eyesAboveMouth = (detection: Detection, imageWidth: number, imageHeight: number) => {
  const box = detection.boundingBox;
  const points = (detection.keypoints ?? []).map(point => ({
    x: point.x * imageWidth, y: point.y * imageHeight,
  }));
  if (!box || points.length < 6) return false;
  // MediaPipe FaceDetector keypoint order: left eye, right eye, nose tip,
  // mouth center, left ear tragion, right ear tragion. (Measured on a real
  // face: nose sits between eye and mouth height; the ear targets flank it.)
  const [leftEye, rightEye, nose, mouth] = points;
  const span = Math.max(box.width, box.height);
  const separation = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
  // Two distinct eyes, face ordering (eyes and nose above the mouth), and an
  // eye-to-mouth span that fits the box. Clipped faces keep all of these.
  const eyeToMouth = mouth.y - Math.min(leftEye.y, rightEye.y);
  return separation >= span * .08 && leftEye.y < mouth.y && rightEye.y < mouth.y &&
    nose.y < mouth.y && eyeToMouth > 0 && eyeToMouth <= span * 1.2;
};

// MediaPipe returns boxes in input-image pixels. Clip edge faces to the image;
// never silently turn malformed or overflowing output into a successful scan.
export function normalizeFaces(detections: Detection[], observationId: string, width: number, height: number, elapsedMs: number): PerceptionResult {
  const regions = detections.flatMap(detection => {
    const b = detection.boundingBox;
    if (!b || ![b.originX, b.originY, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) throw new Error('FACE_INVALID_RESULT');
    const confidence = detection.categories[0]?.score;
    if (confidence === undefined) throw new Error('FACE_INVALID_RESULT');
    // A box without plausible facial geometry is a false positive, not a
    // private region: rejecting it here keeps it out of the panel overlay, the
    // redaction plan and the delivered screenshot alike.
    if (!eyesAboveMouth(detection, width, height)) return [];
    const x = Math.max(0, Math.floor(b.originX)), y = Math.max(0, Math.floor(b.originY));
    const right = Math.min(width, Math.ceil(b.originX + b.width)), bottom = Math.min(height, Math.ceil(b.originY + b.height));
    if (right <= x || bottom <= y) throw new Error('FACE_INVALID_RESULT');
    return [{ kind: 'face' as const, bounds: { x, y, width: right - x, height: bottom - y }, confidence }];
  });
  return PerceptionResultSchema.parse({ observationId, source: 'model', regions, elapsedMs });
}
