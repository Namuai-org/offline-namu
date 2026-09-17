// Strict RFC 8259 JSON parser used for signed descriptors (SIG-003).
// Differences from JSON.parse: duplicate object keys at any depth are an
// error, depth is bounded, and integers are reported exactly.
// Reference implementation for the Kotlin and Swift parsers
// (docs/engineering/native-contract.md §4.1).

const MAX_DEPTH = 16;

export class StrictJsonError extends Error {}

export function parseStrictJson(text) {
  if (typeof text !== 'string') {
    throw new StrictJsonError('input must be a string');
  }
  let i = 0;
  const n = text.length;

  const fail = message => {
    throw new StrictJsonError(`${message} at ${i}`);
  };
  const skipWs = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
        i++;
      } else {
        break;
      }
    }
  };

  const parseString = () => {
    i++; // opening quote
    let out = '';
    while (true) {
      if (i >= n) {
        fail('unterminated string');
      }
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return out;
      }
      if (c < 0x20) {
        fail('control character in string');
      }
      if (c === 0x5c) {
        i++;
        const e = text[i];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              fail('bad unicode escape');
            }
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail('bad escape');
        }
        i++;
      } else {
        out += text[i];
        i++;
      }
    }
  };

  const parseNumber = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(
      text.slice(i, i + 64),
    );
    if (!m) {
      fail('bad number');
    }
    i += m[0].length;
    const isInteger = m[2] === undefined && m[3] === undefined;
    const value = Number(m[0]);
    if (isInteger && !Number.isSafeInteger(value)) {
      fail('integer out of range');
    }
    return {__number: true, value, isInteger};
  };

  const parseValue = depth => {
    if (depth > MAX_DEPTH) {
      fail('too deep');
    }
    skipWs();
    if (i >= n) {
      fail('unexpected end');
    }
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = new Map();
      skipWs();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      while (true) {
        skipWs();
        if (text[i] !== '"') {
          fail('expected key');
        }
        const key = parseString();
        if (obj.has(key)) {
          fail(`duplicate key "${key}"`);
        }
        skipWs();
        if (text[i] !== ':') {
          fail('expected colon');
        }
        i++;
        obj.set(key, parseValue(depth + 1));
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      skipWs();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      while (true) {
        arr.push(parseValue(depth + 1));
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail('expected , or ]');
      }
    }
    if (c === '"') {
      return parseString();
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      return parseNumber();
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return fail('unexpected token');
  };

  const value = parseValue(1);
  skipWs();
  if (i !== n) {
    fail('trailing data');
  }
  return value;
}

export function getString(map, key) {
  const v = map.get(key);
  return typeof v === 'string' ? v : undefined;
}

export function getInteger(map, key) {
  const v = map.get(key);
  return v && v.__number && v.isInteger ? v.value : undefined;
}

export function getStringArray(map, key) {
  const v = map.get(key);
  if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) {
    return undefined;
  }
  return v;
}
