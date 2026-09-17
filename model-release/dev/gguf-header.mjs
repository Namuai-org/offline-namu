// Bounded GGUF header reader (reference for native-contract.md §6.4 step 3).
// Walks only the metadata key/value section; never touches tensor data.
import fs from 'node:fs';

const MAX_KV = 4096;
const MAX_TENSORS = 65536;
const MAX_STRING = 1 << 20; // keys/architecture strings; large arrays are skipped by size
const HEADER_WINDOW = 64 * 1024 * 1024;

const SCALAR_SIZE = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8};

export class GgufError extends Error {}

export function readGgufArchitecture(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const window = Buffer.alloc(Math.min(size, HEADER_WINDOW));
    fs.readSync(fd, window, 0, window.length, 0);
    let o = 0;
    const need = n => {
      if (o + n > window.length) {
        throw new GgufError('metadata exceeds header window');
      }
    };
    const u32 = () => { need(4); const v = window.readUInt32LE(o); o += 4; return v; };
    const u64 = () => {
      need(8);
      const v = window.readBigUInt64LE(o);
      o += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new GgufError('length out of range');
      }
      return Number(v);
    };
    const str = limit => {
      const len = u64();
      if (len > limit) {
        throw new GgufError('string too long');
      }
      need(len);
      const s = window.toString('utf8', o, o + len);
      o += len;
      return s;
    };
    const skipValue = (type, depth) => {
      if (type in SCALAR_SIZE) {
        need(SCALAR_SIZE[type]);
        o += SCALAR_SIZE[type];
      } else if (type === 8) {
        const len = u64();
        need(len);
        o += len;
      } else if (type === 9) {
        if (depth > 1) {
          throw new GgufError('nested arrays not allowed');
        }
        const inner = u32();
        const count = u64();
        if (inner in SCALAR_SIZE) {
          const bytes = SCALAR_SIZE[inner] * count;
          need(bytes);
          o += bytes;
        } else {
          for (let i = 0; i < count; i++) {
            skipValue(inner, depth + 1);
          }
        }
      } else {
        throw new GgufError(`unknown value type ${type}`);
      }
    };

    need(4);
    if (window.toString('latin1', 0, 4) !== 'GGUF') {
      throw new GgufError('bad magic');
    }
    o = 4;
    const version = u32();
    if (version !== 2 && version !== 3) {
      throw new GgufError(`unsupported version ${version}`);
    }
    const tensors = u64();
    const kvCount = u64();
    if (tensors > MAX_TENSORS || kvCount > MAX_KV) {
      throw new GgufError('counts out of bounds');
    }
    for (let i = 0; i < kvCount; i++) {
      const key = str(MAX_STRING);
      const type = u32();
      if (key === 'general.architecture') {
        if (type !== 8) {
          throw new GgufError('architecture is not a string');
        }
        return str(256);
      }
      skipValue(type, 0);
    }
    throw new GgufError('general.architecture missing');
  } finally {
    fs.closeSync(fd);
  }
}
