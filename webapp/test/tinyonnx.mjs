// A minimal ONNX writer (protobuf by hand): a model with the extractor's shapes and output layout,
// for tests and local demos. Not a test file (no .test.mjs suffix).

const varint = (n) => {
  const o = [];
  while (n > 0x7f) (o.push((n & 0x7f) | 0x80), (n = Math.floor(n / 128)));
  o.push(n);
  return o;
};
const key = (f, w) => varint((f << 3) | w);
const len = (f, bytes) => [...key(f, 2), ...varint(bytes.length), ...bytes];
const str = (f, s) => len(f, [...Buffer.from(s)]);
const num = (f, n) => [...key(f, 0), ...varint(n)];
const tensor = (name, dims, data) => [
  ...dims.flatMap((d) => num(1, d)), ...num(2, 1), ...str(8, name),
  ...len(9, [...Buffer.from(new Float32Array(data).buffer)]),
];
const info = (name, dims) =>
  [...str(1, name), ...len(2, len(1, [...num(1, 1), ...len(2, dims.flatMap((d) => len(1, typeof d === "number" ? num(1, d) : str(2, d))))]))];
const node = (op, ins, outs, attrs = []) => [
  ...ins.flatMap((i) => str(1, i)), ...outs.flatMap((o) => str(2, o)), ...str(4, op), ...attrs.flatMap((a) => len(5, a)),
];

export function tinyModel() {
  const W = (cols, seed) => Array.from({ length: 96 * cols }, (_, i) => Math.sin(i * 0.0137 + seed));
  const graph = [
    ...len(1, node("ReduceMean", ["X"], ["M"], [[...str(1, "axes"), ...num(20, 7), ...num(8, 1)], [...str(1, "keepdims"), ...num(20, 2), ...num(3, 0)]])),
    ...len(1, node("MatMul", ["M", "W400"], ["activations"])),
    ...len(1, node("MatMul", ["M", "W1280"], ["embedding"])),
    ...str(2, "tiny"),
    ...len(5, tensor("W400", [96, 400], W(400, 0.3))),
    ...len(5, tensor("W1280", [96, 1280], W(1280, 1.1))),
    ...len(11, info("X", ["batch", 128, 96])),
    ...len(12, info("activations", ["batch", 400])),
    ...len(12, info("embedding", ["batch", 1280])),
  ];
  return Uint8Array.from([...num(1, 8), ...len(8, num(2, 13)), ...len(7, graph)]);
}

