import { describe, expect, it } from 'vitest';
import { decodeOnnxOutput, nonMaxSuppression, onnxCategory } from '../../src/vision/onnx-utils';

describe('local ONNX document detector output', () => {
  it('maps model classes and letterboxed boxes back to source pixels', () => {
    const count = 2, values = new Float32Array(8 * count);
    // [cx, cy, width, height] are model-space values; class scores follow.
    values[0] = 320; values[count] = 320; values[2 * count] = 320; values[3 * count] = 160; values[4 * count] = .91;
    values[1] = 322; values[count + 1] = 320; values[2 * count + 1] = 318; values[3 * count + 1] = 158; values[4 * count + 1] = .7;
    const result = decodeOnnxOutput(values, count, 800, 400, .8, 0, 160);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('identity_card');
    expect(result[0].bounds).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  it('keeps different privacy classes while suppressing same-class overlap', () => {
    const a = { category: onnxCategory('signatures'), confidence: .8, bounds: { x: 0, y: 0, width: 100, height: 50 } };
    const b = { category: onnxCategory('signatures'), confidence: .5, bounds: { x: 2, y: 2, width: 100, height: 50 } };
    const c = { category: onnxCategory('financial'), confidence: .6, bounds: { x: 2, y: 2, width: 100, height: 50 } };
    expect(nonMaxSuppression([b, c, a])).toEqual([a, c]);
  });
});

