# Local document detector

`best.onnx` is the supplied Ultralytics object-detection export. Its embedded
metadata declares a 640 × 640 input, four classes, and an output tensor of
`[1, 8, 8400]` without non-maximum suppression:

| Model class | Privacy category in the extension |
| --- | --- |
| `id_docs` | `identity_card` |
| `fingerprints` | `private_document` |
| `signatures` | `signature` |
| `financial` | `financial_document` |

SHA-256: `cef9f1d18e6dd3e56341a2828fc71b2d7b0e13298f7cc74c835d9d76ababbda3`

The embedded model metadata identifies the Ultralytics AGPL-3.0 license. Check
that license and any applicable commercial terms before distributing this
extension. The model is run locally through ONNX Runtime Web; images and model
outputs do not leave the browser.

