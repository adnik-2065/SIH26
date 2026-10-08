# Bundled face detector

Google MediaPipe BlazeFace short-range, float16, version 1. Downloaded 2026-09-09 from:
https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite

SHA-256: `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`

Runtime: `@mediapipe/tasks-vision` 1.0.1 (Apache-2.0, pinned in package-lock.json).
Model information and model card: https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector#models

The build verifies the model checksum and copies the runtime, WASM, and weights into dist/vision. No runtime CDN or remote inference. This model locates faces; it does not identify people, recognize document types, or establish that an image is free of PII.
