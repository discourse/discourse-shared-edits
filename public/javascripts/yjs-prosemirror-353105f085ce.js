var require = ((discourseRequire) => (name) => {
  const ns = window.__sharedEditsProseMirror || {};
  const pmModules = {
    'prosemirror-state': ns.pmState,
    'prosemirror-view': ns.pmView,
    'prosemirror-model': ns.pmModel,
    'prosemirror-transform': ns.pmTransform,
    'prosemirror-commands': ns.pmCommands,
    'prosemirror-history': ns.pmHistory,
    'prosemirror-inputrules': ns.pmInputrules,
    'prosemirror-keymap': ns.pmKeymap,
    'yjs': (window.SharedEditsYjs && window.SharedEditsYjs.Y) || window.Y
  };
  if (pmModules[name]) return pmModules[name];
  if (discourseRequire) return discourseRequire(name);
  throw new Error("Could not find module " + name);
})(window.require || window.requirejs);

(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __copyProps = (to, from2, except, desc) => {
    if (from2 && typeof from2 === "object" || typeof from2 === "function") {
      for (let key of __getOwnPropNames(from2))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from2[key], enumerable: !(desc = __getOwnPropDesc(from2, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/plugins/cursor-plugin.js
  var Y4 = __toESM(__require("yjs"), 1);
  var import_prosemirror_view2 = __require("prosemirror-view");
  var import_prosemirror_state3 = __require("prosemirror-state");

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/math.js
  var floor = Math.floor;
  var abs = Math.abs;
  var min = (a, b) => a < b ? a : b;
  var max = (a, b) => a > b ? a : b;
  var isNaN = Number.isNaN;
  var isNegativeZero = (n) => n !== 0 ? n < 0 : 1 / n < 0;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/binary.js
  var BIT7 = 64;
  var BIT8 = 128;
  var BIT18 = 1 << 17;
  var BIT19 = 1 << 18;
  var BIT20 = 1 << 19;
  var BIT21 = 1 << 20;
  var BIT22 = 1 << 21;
  var BIT23 = 1 << 22;
  var BIT24 = 1 << 23;
  var BIT25 = 1 << 24;
  var BIT26 = 1 << 25;
  var BIT27 = 1 << 26;
  var BIT28 = 1 << 27;
  var BIT29 = 1 << 28;
  var BIT30 = 1 << 29;
  var BIT31 = 1 << 30;
  var BIT32 = 1 << 31;
  var BITS6 = 63;
  var BITS7 = 127;
  var BITS17 = BIT18 - 1;
  var BITS18 = BIT19 - 1;
  var BITS19 = BIT20 - 1;
  var BITS20 = BIT21 - 1;
  var BITS21 = BIT22 - 1;
  var BITS22 = BIT23 - 1;
  var BITS23 = BIT24 - 1;
  var BITS24 = BIT25 - 1;
  var BITS25 = BIT26 - 1;
  var BITS26 = BIT27 - 1;
  var BITS27 = BIT28 - 1;
  var BITS28 = BIT29 - 1;
  var BITS29 = BIT30 - 1;
  var BITS30 = BIT31 - 1;
  var BITS31 = 2147483647;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/number.js
  var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
  var MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
  var LOWEST_INT32 = 1 << 31;
  var isInteger = Number.isInteger || ((num) => typeof num === "number" && isFinite(num) && floor(num) === num);
  var isNaN2 = Number.isNaN;
  var parseInt = Number.parseInt;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/set.js
  var create = () => /* @__PURE__ */ new Set();

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/array.js
  var from = Array.from;
  var isArray = Array.isArray;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/string.js
  var fromCharCode = String.fromCharCode;
  var fromCodePoint = String.fromCodePoint;
  var MAX_UTF16_CHARACTER = fromCharCode(65535);
  var toLowerCase = (s) => s.toLowerCase();
  var trimLeftRegex = /^\s*/g;
  var trimLeft = (s) => s.replace(trimLeftRegex, "");
  var fromCamelCaseRegex = /([A-Z])/g;
  var fromCamelCase = (s, separator) => trimLeft(s.replace(fromCamelCaseRegex, (match) => `${separator}${toLowerCase(match)}`));
  var _encodeUtf8Polyfill = (str) => {
    const encodedString = unescape(encodeURIComponent(str));
    const len = encodedString.length;
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      buf[i] = /** @type {number} */
      encodedString.codePointAt(i);
    }
    return buf;
  };
  var utf8TextEncoder = (
    /** @type {TextEncoder} */
    typeof TextEncoder !== "undefined" ? new TextEncoder() : null
  );
  var _encodeUtf8Native = (str) => utf8TextEncoder.encode(str);
  var encodeUtf8 = utf8TextEncoder ? _encodeUtf8Native : _encodeUtf8Polyfill;
  var utf8TextDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (utf8TextDecoder && utf8TextDecoder.decode(new Uint8Array()).length === 1) {
    utf8TextDecoder = null;
  }

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/encoding.js
  var Encoder = class {
    constructor() {
      this.cpos = 0;
      this.cbuf = new Uint8Array(100);
      this.bufs = [];
    }
  };
  var createEncoder = () => new Encoder();
  var encode = (f) => {
    const encoder = createEncoder();
    f(encoder);
    return toUint8Array(encoder);
  };
  var length = (encoder) => {
    let len = encoder.cpos;
    for (let i = 0; i < encoder.bufs.length; i++) {
      len += encoder.bufs[i].length;
    }
    return len;
  };
  var toUint8Array = (encoder) => {
    const uint8arr = new Uint8Array(length(encoder));
    let curPos = 0;
    for (let i = 0; i < encoder.bufs.length; i++) {
      const d = encoder.bufs[i];
      uint8arr.set(d, curPos);
      curPos += d.length;
    }
    uint8arr.set(new Uint8Array(encoder.cbuf.buffer, 0, encoder.cpos), curPos);
    return uint8arr;
  };
  var verifyLen = (encoder, len) => {
    const bufferLen = encoder.cbuf.length;
    if (bufferLen - encoder.cpos < len) {
      encoder.bufs.push(new Uint8Array(encoder.cbuf.buffer, 0, encoder.cpos));
      encoder.cbuf = new Uint8Array(max(bufferLen, len) * 2);
      encoder.cpos = 0;
    }
  };
  var write = (encoder, num) => {
    const bufferLen = encoder.cbuf.length;
    if (encoder.cpos === bufferLen) {
      encoder.bufs.push(encoder.cbuf);
      encoder.cbuf = new Uint8Array(bufferLen * 2);
      encoder.cpos = 0;
    }
    encoder.cbuf[encoder.cpos++] = num;
  };
  var writeVarUint = (encoder, num) => {
    while (num > BITS7) {
      write(encoder, BIT8 | BITS7 & num);
      num = floor(num / 128);
    }
    write(encoder, BITS7 & num);
  };
  var writeVarInt = (encoder, num) => {
    const isNegative = isNegativeZero(num);
    if (isNegative) {
      num = -num;
    }
    write(encoder, (num > BITS6 ? BIT8 : 0) | (isNegative ? BIT7 : 0) | BITS6 & num);
    num = floor(num / 64);
    while (num > 0) {
      write(encoder, (num > BITS7 ? BIT8 : 0) | BITS7 & num);
      num = floor(num / 128);
    }
  };
  var _strBuffer = new Uint8Array(3e4);
  var _maxStrBSize = _strBuffer.length / 3;
  var _writeVarStringNative = (encoder, str) => {
    if (str.length < _maxStrBSize) {
      const written = utf8TextEncoder.encodeInto(str, _strBuffer).written || 0;
      writeVarUint(encoder, written);
      for (let i = 0; i < written; i++) {
        write(encoder, _strBuffer[i]);
      }
    } else {
      writeVarUint8Array(encoder, encodeUtf8(str));
    }
  };
  var _writeVarStringPolyfill = (encoder, str) => {
    const encodedString = unescape(encodeURIComponent(str));
    const len = encodedString.length;
    writeVarUint(encoder, len);
    for (let i = 0; i < len; i++) {
      write(
        encoder,
        /** @type {number} */
        encodedString.codePointAt(i)
      );
    }
  };
  var writeVarString = utf8TextEncoder && /** @type {any} */
  utf8TextEncoder.encodeInto ? _writeVarStringNative : _writeVarStringPolyfill;
  var writeUint8Array = (encoder, uint8Array) => {
    const bufferLen = encoder.cbuf.length;
    const cpos = encoder.cpos;
    const leftCopyLen = min(bufferLen - cpos, uint8Array.length);
    const rightCopyLen = uint8Array.length - leftCopyLen;
    encoder.cbuf.set(uint8Array.subarray(0, leftCopyLen), cpos);
    encoder.cpos += leftCopyLen;
    if (rightCopyLen > 0) {
      encoder.bufs.push(encoder.cbuf);
      encoder.cbuf = new Uint8Array(max(bufferLen * 2, rightCopyLen));
      encoder.cbuf.set(uint8Array.subarray(leftCopyLen));
      encoder.cpos = rightCopyLen;
    }
  };
  var writeVarUint8Array = (encoder, uint8Array) => {
    writeVarUint(encoder, uint8Array.byteLength);
    writeUint8Array(encoder, uint8Array);
  };
  var writeOnDataView = (encoder, len) => {
    verifyLen(encoder, len);
    const dview = new DataView(encoder.cbuf.buffer, encoder.cpos, len);
    encoder.cpos += len;
    return dview;
  };
  var writeFloat32 = (encoder, num) => writeOnDataView(encoder, 4).setFloat32(0, num, false);
  var writeFloat64 = (encoder, num) => writeOnDataView(encoder, 8).setFloat64(0, num, false);
  var writeBigInt64 = (encoder, num) => (
    /** @type {any} */
    writeOnDataView(encoder, 8).setBigInt64(0, num, false)
  );
  var floatTestBed = new DataView(new ArrayBuffer(4));
  var isFloat32 = (num) => {
    floatTestBed.setFloat32(0, num);
    return floatTestBed.getFloat32(0) === num;
  };
  var writeAny = (encoder, data) => {
    switch (typeof data) {
      case "string":
        write(encoder, 119);
        writeVarString(encoder, data);
        break;
      case "number":
        if (isInteger(data) && abs(data) <= BITS31) {
          write(encoder, 125);
          writeVarInt(encoder, data);
        } else if (isFloat32(data)) {
          write(encoder, 124);
          writeFloat32(encoder, data);
        } else {
          write(encoder, 123);
          writeFloat64(encoder, data);
        }
        break;
      case "bigint":
        write(encoder, 122);
        writeBigInt64(encoder, data);
        break;
      case "object":
        if (data === null) {
          write(encoder, 126);
        } else if (isArray(data)) {
          write(encoder, 117);
          writeVarUint(encoder, data.length);
          for (let i = 0; i < data.length; i++) {
            writeAny(encoder, data[i]);
          }
        } else if (data instanceof Uint8Array) {
          write(encoder, 116);
          writeVarUint8Array(encoder, data);
        } else {
          write(encoder, 118);
          const keys2 = Object.keys(data);
          writeVarUint(encoder, keys2.length);
          for (let i = 0; i < keys2.length; i++) {
            const key = keys2[i];
            writeVarString(encoder, key);
            writeAny(encoder, data[key]);
          }
        }
        break;
      case "boolean":
        write(encoder, data ? 120 : 121);
        break;
      default:
        write(encoder, 127);
    }
  };

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/error.js
  var create2 = (s) => new Error(s);
  var methodUnimplemented = () => {
    throw create2("Method unimplemented");
  };
  var unexpectedCase = () => {
    throw create2("Unexpected case");
  };

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/map.js
  var create3 = () => /* @__PURE__ */ new Map();
  var setIfUndefined = (map, key, createT) => {
    let set = map.get(key);
    if (set === void 0) {
      map.set(key, set = createT());
    }
    return set;
  };

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/object.js
  var keys = Object.keys;
  var every = (obj, f) => {
    for (const key in obj) {
      if (!f(obj[key], key)) {
        return false;
      }
    }
    return true;
  };

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/function.js
  var isOneOf = (value, options) => options.includes(value);

  // node_modules/.pnpm/y-protocols@1.0.7_yjs@13.6.27/node_modules/y-protocols/awareness.js
  var Y = __toESM(__require("yjs"), 1);

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/mutex.js
  var createMutex = () => {
    let token = true;
    return (f, g) => {
      if (token) {
        token = false;
        try {
          f();
        } finally {
          token = true;
        }
      } else if (g !== void 0) {
        g();
      }
    };
  };

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/plugins/sync-plugin.js
  var PModel = __toESM(__require("prosemirror-model"), 1);
  var import_prosemirror_state2 = __require("prosemirror-state");

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/diff.js
  var highSurrogateRegex = /[\uD800-\uDBFF]/;
  var lowSurrogateRegex = /[\uDC00-\uDFFF]/;
  var simpleDiffString = (a, b) => {
    let left = 0;
    let right = 0;
    while (left < a.length && left < b.length && a[left] === b[left]) {
      left++;
    }
    if (left > 0 && highSurrogateRegex.test(a[left - 1])) left--;
    while (right + left < a.length && right + left < b.length && a[a.length - right - 1] === b[b.length - right - 1]) {
      right++;
    }
    if (right > 0 && lowSurrogateRegex.test(a[a.length - right])) right--;
    return {
      index: left,
      remove: a.length - left - right,
      insert: b.slice(left, b.length - right)
    };
  };
  var simpleDiff = simpleDiffString;

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/plugins/keys.js
  var import_prosemirror_state = __require("prosemirror-state");
  var ySyncPluginKey = new import_prosemirror_state.PluginKey("y-sync");
  var yUndoPluginKey = new import_prosemirror_state.PluginKey("y-undo");
  var yCursorPluginKey = new import_prosemirror_state.PluginKey("yjs-cursor");

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/plugins/sync-plugin.js
  var Y2 = __toESM(__require("yjs"), 1);

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/random.js
  var rand = Math.random;
  var oneOf = (arr) => arr[floor(rand() * arr.length)];
  var uuidv4Template = "10000000-1000-4000-8000" + -1e11;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/conditions.js
  var undefinedToNull = (v) => v === void 0 ? null : v;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/storage.js
  var VarStoragePolyfill = class {
    constructor() {
      this.map = /* @__PURE__ */ new Map();
    }
    /**
     * @param {string} key
     * @param {any} newValue
     */
    setItem(key, newValue) {
      this.map.set(key, newValue);
    }
    /**
     * @param {string} key
     */
    getItem(key) {
      return this.map.get(key);
    }
  };
  var _localStorage = new VarStoragePolyfill();
  var usePolyfill = true;
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      _localStorage = localStorage;
      usePolyfill = false;
    }
  } catch (e) {
  }
  var varStorage = _localStorage;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/environment.js
  var isNode = typeof process !== "undefined" && process.release && /node|io\.js/.test(process.release.name) && Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]";
  var isBrowser = typeof window !== "undefined" && typeof document !== "undefined" && !isNode;
  var isMac = typeof navigator !== "undefined" ? /Mac/.test(navigator.platform) : false;
  var params;
  var args = [];
  var computeParams = () => {
    if (params === void 0) {
      if (isNode) {
        params = create3();
        const pargs = process.argv;
        let currParamName = null;
        for (let i = 0; i < pargs.length; i++) {
          const parg = pargs[i];
          if (parg[0] === "-") {
            if (currParamName !== null) {
              params.set(currParamName, "");
            }
            currParamName = parg;
          } else {
            if (currParamName !== null) {
              params.set(currParamName, parg);
              currParamName = null;
            } else {
              args.push(parg);
            }
          }
        }
        if (currParamName !== null) {
          params.set(currParamName, "");
        }
      } else if (typeof location === "object") {
        params = create3();
        (location.search || "?").slice(1).split("&").forEach((kv) => {
          if (kv.length !== 0) {
            const [key, value] = kv.split("=");
            params.set(`--${fromCamelCase(key, "-")}`, value);
            params.set(`-${fromCamelCase(key, "-")}`, value);
          }
        });
      } else {
        params = create3();
      }
    }
    return params;
  };
  var hasParam = (name) => computeParams().has(name);
  var getVariable = (name) => isNode ? undefinedToNull(process.env[name.toUpperCase().replaceAll("-", "_")]) : undefinedToNull(varStorage.getItem(name));
  var hasConf = (name) => hasParam("--" + name) || getVariable(name) !== null;
  var production = hasConf("production");
  var forceColor = isNode && isOneOf(process.env.FORCE_COLOR, ["true", "1", "2"]);
  var supportsColor = forceColor || !hasParam("--no-colors") && // @todo deprecate --no-colors
  !hasConf("no-color") && (!isNode || process.stdout.isTTY) && (!isNode || hasParam("--color") || getVariable("COLORTERM") !== null || (getVariable("TERM") || "").includes("color"));

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/dom.js
  var doc = (
    /** @type {Document} */
    typeof document !== "undefined" ? document : {}
  );
  var domParser = (
    /** @type {DOMParser} */
    typeof DOMParser !== "undefined" ? new DOMParser() : null
  );
  var ELEMENT_NODE = doc.ELEMENT_NODE;
  var TEXT_NODE = doc.TEXT_NODE;
  var CDATA_SECTION_NODE = doc.CDATA_SECTION_NODE;
  var COMMENT_NODE = doc.COMMENT_NODE;
  var DOCUMENT_NODE = doc.DOCUMENT_NODE;
  var DOCUMENT_TYPE_NODE = doc.DOCUMENT_TYPE_NODE;
  var DOCUMENT_FRAGMENT_NODE = doc.DOCUMENT_FRAGMENT_NODE;

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/eventloop.js
  var createTimeoutClass = (clearFunction) => class TT {
    /**
     * @param {number} timeoutId
     */
    constructor(timeoutId) {
      this._ = timeoutId;
    }
    destroy() {
      clearFunction(this._);
    }
  };
  var Timeout = createTimeoutClass(clearTimeout);
  var timeout = (timeout2, callback) => new Timeout(setTimeout(callback, timeout2));
  var Interval = createTimeoutClass(clearInterval);
  var Animation = createTimeoutClass((arg) => typeof requestAnimationFrame !== "undefined" && cancelAnimationFrame(arg));
  var Idle = createTimeoutClass((arg) => typeof cancelIdleCallback !== "undefined" && cancelIdleCallback(arg));

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/hash/sha256.js
  var rotr = (w, shift) => w >>> shift | w << 32 - shift;
  var sum0to256 = (x) => rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
  var sum1to256 = (x) => rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
  var sigma0to256 = (x) => rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3;
  var sigma1to256 = (x) => rotr(x, 17) ^ rotr(x, 19) ^ x >>> 10;
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var HINIT = new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var Hasher = class {
    constructor() {
      const buf = new ArrayBuffer(64 + 64 * 4);
      this._H = new Uint32Array(buf, 0, 8);
      this._H.set(HINIT);
      this._W = new Uint32Array(buf, 64, 64);
    }
    _updateHash() {
      const H = this._H;
      const W = this._W;
      for (let t = 16; t < 64; t++) {
        W[t] = sigma1to256(W[t - 2]) + W[t - 7] + sigma0to256(W[t - 15]) + W[t - 16];
      }
      let a = H[0];
      let b = H[1];
      let c = H[2];
      let d = H[3];
      let e = H[4];
      let f = H[5];
      let g = H[6];
      let h = H[7];
      for (let tt = 0, T1, T2; tt < 64; tt++) {
        T1 = h + sum1to256(e) + (e & f ^ ~e & g) + K[tt] + W[tt] >>> 0;
        T2 = sum0to256(a) + (a & b ^ a & c ^ b & c) >>> 0;
        h = g;
        g = f;
        f = e;
        e = d + T1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = T1 + T2 >>> 0;
      }
      H[0] += a;
      H[1] += b;
      H[2] += c;
      H[3] += d;
      H[4] += e;
      H[5] += f;
      H[6] += g;
      H[7] += h;
    }
    /**
     * Returns a 32-byte hash.
     *
     * @param {Uint8Array} data
     */
    digest(data) {
      let i = 0;
      for (; i + 56 <= data.length; ) {
        let j2 = 0;
        for (; j2 < 16 && i + 3 < data.length; j2++) {
          this._W[j2] = data[i++] << 24 | data[i++] << 16 | data[i++] << 8 | data[i++];
        }
        if (i % 64 !== 0) {
          this._W.fill(0, j2, 16);
          while (i < data.length) {
            this._W[j2] |= data[i] << (3 - i % 4) * 8;
            i++;
          }
          this._W[j2] |= BIT8 << (3 - i % 4) * 8;
        }
        this._updateHash();
      }
      const isPaddedWith1 = i % 64 !== 0;
      this._W.fill(0, 0, 16);
      let j = 0;
      for (; i < data.length; j++) {
        for (let ci = 3; ci >= 0 && i < data.length; ci--) {
          this._W[j] |= data[i++] << ci * 8;
        }
      }
      if (!isPaddedWith1) {
        this._W[j - (i % 4 === 0 ? 0 : 1)] |= BIT8 << (3 - i % 4) * 8;
      }
      this._W[14] = data.byteLength / BIT30;
      this._W[15] = data.byteLength * 8;
      this._updateHash();
      const dv = new Uint8Array(32);
      for (let i2 = 0; i2 < this._H.length; i2++) {
        for (let ci = 0; ci < 4; ci++) {
          dv[i2 * 4 + ci] = this._H[i2] >>> (3 - ci) * 8;
        }
      }
      return dv;
    }
  };
  var digest = (data) => new Hasher().digest(data);

  // node_modules/.pnpm/lib0@0.2.114/node_modules/lib0/buffer.js
  var toBase64Browser = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      s += fromCharCode(bytes[i]);
    }
    return btoa(s);
  };
  var toBase64Node = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  var toBase64 = isBrowser ? toBase64Browser : toBase64Node;
  var encodeAny = (data) => encode((encoder) => writeAny(encoder, data));

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/utils.js
  var _convolute = (digest2) => {
    const N = 6;
    for (let i = N; i < digest2.length; i++) {
      digest2[i % N] = digest2[i % N] ^ digest2[i];
    }
    return digest2.slice(0, N);
  };
  var hashOfJSON = (json) => toBase64(_convolute(digest(encodeAny(json))));

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/plugins/sync-plugin.js
  var isVisible = (item, snapshot2) => snapshot2 === void 0 ? !item.deleted : snapshot2.sv.has(item.id.client) && /** @type {number} */
  snapshot2.sv.get(item.id.client) > item.id.clock && !Y2.isDeleted(snapshot2.ds, item.id);
  var defaultColors = [{ light: "#ecd44433", dark: "#ecd444" }];
  var getUserColor = (colorMapping, colors, user) => {
    if (!colorMapping.has(user)) {
      if (colorMapping.size < colors.length) {
        const usedColors = create();
        colorMapping.forEach((color) => usedColors.add(color));
        colors = colors.filter((color) => !usedColors.has(color));
      }
      colorMapping.set(user, oneOf(colors));
    }
    return (
      /** @type {ColorDef} */
      colorMapping.get(user)
    );
  };
  var ySyncPlugin = (yXmlFragment, {
    colors = defaultColors,
    colorMapping = /* @__PURE__ */ new Map(),
    permanentUserData = null,
    onFirstRender = () => {
    },
    mapping
  } = {}) => {
    let initialContentChanged = false;
    const binding = new ProsemirrorBinding(yXmlFragment, mapping);
    const plugin = new import_prosemirror_state2.Plugin({
      props: {
        editable: (state) => {
          const syncState = ySyncPluginKey.getState(state);
          return syncState.snapshot == null && syncState.prevSnapshot == null;
        }
      },
      key: ySyncPluginKey,
      state: {
        /**
         * @returns {any}
         */
        init: (_initargs, _state) => {
          return {
            type: yXmlFragment,
            doc: yXmlFragment.doc,
            binding,
            snapshot: null,
            prevSnapshot: null,
            isChangeOrigin: false,
            isUndoRedoOperation: false,
            addToHistory: true,
            colors,
            colorMapping,
            permanentUserData
          };
        },
        apply: (tr, pluginState) => {
          const change = tr.getMeta(ySyncPluginKey);
          if (change !== void 0) {
            pluginState = Object.assign({}, pluginState);
            for (const key in change) {
              pluginState[key] = change[key];
            }
          }
          pluginState.addToHistory = tr.getMeta("addToHistory") !== false;
          pluginState.isChangeOrigin = change !== void 0 && !!change.isChangeOrigin;
          pluginState.isUndoRedoOperation = change !== void 0 && !!change.isChangeOrigin && !!change.isUndoRedoOperation;
          if (binding.prosemirrorView !== null) {
            if (change !== void 0 && (change.snapshot != null || change.prevSnapshot != null)) {
              timeout(0, () => {
                if (binding.prosemirrorView == null) {
                  return;
                }
                if (change.restore == null) {
                  binding._renderSnapshot(
                    change.snapshot,
                    change.prevSnapshot,
                    pluginState
                  );
                } else {
                  binding._renderSnapshot(
                    change.snapshot,
                    change.snapshot,
                    pluginState
                  );
                  delete pluginState.restore;
                  delete pluginState.snapshot;
                  delete pluginState.prevSnapshot;
                  binding.mux(() => {
                    binding._prosemirrorChanged(
                      binding.prosemirrorView.state.doc
                    );
                  });
                }
              });
            }
          }
          return pluginState;
        }
      },
      view: (view) => {
        binding.initView(view);
        if (mapping == null) {
          binding._forceRerender();
        }
        onFirstRender();
        return {
          update: () => {
            const pluginState = plugin.getState(view.state);
            if (pluginState.snapshot == null && pluginState.prevSnapshot == null) {
              if (
                // If the content doesn't change initially, we don't render anything to Yjs
                // If the content was cleared by a user action, we want to catch the change and
                // represent it in Yjs
                initialContentChanged || view.state.doc.content.findDiffStart(
                  view.state.doc.type.createAndFill().content
                ) !== null
              ) {
                initialContentChanged = true;
                if (pluginState.addToHistory === false && !pluginState.isChangeOrigin) {
                  const yUndoPluginState = yUndoPluginKey.getState(view.state);
                  const um = yUndoPluginState && yUndoPluginState.undoManager;
                  if (um) {
                    um.stopCapturing();
                  }
                }
                binding.mux(() => {
                  pluginState.doc.transact((tr) => {
                    tr.meta.set("addToHistory", pluginState.addToHistory);
                    binding._prosemirrorChanged(view.state.doc);
                  }, ySyncPluginKey);
                });
              }
            }
          },
          destroy: () => {
            binding.destroy();
          }
        };
      }
    });
    return plugin;
  };
  var restoreRelativeSelection = (tr, relSel, binding) => {
    if (relSel !== null && relSel.anchor !== null && relSel.head !== null) {
      if (relSel.type === "all") {
        tr.setSelection(new import_prosemirror_state2.AllSelection(tr.doc));
      } else if (relSel.type === "node") {
        const anchor = relativePositionToAbsolutePosition(
          binding.doc,
          binding.type,
          relSel.anchor,
          binding.mapping
        );
        tr.setSelection(import_prosemirror_state2.NodeSelection.create(tr.doc, anchor));
      } else {
        const anchor = relativePositionToAbsolutePosition(
          binding.doc,
          binding.type,
          relSel.anchor,
          binding.mapping
        );
        const head = relativePositionToAbsolutePosition(
          binding.doc,
          binding.type,
          relSel.head,
          binding.mapping
        );
        if (anchor !== null && head !== null) {
          const sel = import_prosemirror_state2.TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head));
          tr.setSelection(sel);
        }
      }
    }
  };
  var getRelativeSelection = (pmbinding, state) => ({
    type: (
      /** @type {any} */
      state.selection.jsonID
    ),
    anchor: absolutePositionToRelativePosition(
      state.selection.anchor,
      pmbinding.type,
      pmbinding.mapping
    ),
    head: absolutePositionToRelativePosition(
      state.selection.head,
      pmbinding.type,
      pmbinding.mapping
    )
  });
  var ProsemirrorBinding = class {
    /**
     * @param {Y.XmlFragment} yXmlFragment The bind source
     * @param {ProsemirrorMapping} mapping
     */
    constructor(yXmlFragment, mapping = /* @__PURE__ */ new Map()) {
      this.type = yXmlFragment;
      this.prosemirrorView = null;
      this.mux = createMutex();
      this.mapping = mapping;
      this.isOMark = /* @__PURE__ */ new Map();
      this._observeFunction = this._typeChanged.bind(this);
      this.doc = yXmlFragment.doc;
      this.beforeTransactionSelection = null;
      this.beforeAllTransactions = () => {
        if (this.beforeTransactionSelection === null && this.prosemirrorView != null) {
          this.beforeTransactionSelection = getRelativeSelection(
            this,
            this.prosemirrorView.state
          );
        }
      };
      this.afterAllTransactions = () => {
        this.beforeTransactionSelection = null;
      };
      this._domSelectionInView = null;
    }
    /**
     * Create a transaction for changing the prosemirror state.
     *
     * @returns
     */
    get _tr() {
      return this.prosemirrorView.state.tr.setMeta("addToHistory", false);
    }
    _isLocalCursorInView() {
      if (!this.prosemirrorView.hasFocus()) return false;
      if (isBrowser && this._domSelectionInView === null) {
        timeout(0, () => {
          this._domSelectionInView = null;
        });
        this._domSelectionInView = this._isDomSelectionInView();
      }
      return this._domSelectionInView;
    }
    _isDomSelectionInView() {
      const selection = this.prosemirrorView._root.getSelection();
      if (selection == null || selection.anchorNode == null) return false;
      const range = this.prosemirrorView._root.createRange();
      range.setStart(selection.anchorNode, selection.anchorOffset);
      range.setEnd(selection.focusNode, selection.focusOffset);
      const rects = range.getClientRects();
      if (rects.length === 0) {
        if (range.startContainer && range.collapsed) {
          range.selectNodeContents(range.startContainer);
        }
      }
      const bounding = range.getBoundingClientRect();
      const documentElement = doc.documentElement;
      return bounding.bottom >= 0 && bounding.right >= 0 && bounding.left <= (window.innerWidth || documentElement.clientWidth || 0) && bounding.top <= (window.innerHeight || documentElement.clientHeight || 0);
    }
    /**
     * @param {Y.Snapshot} snapshot
     * @param {Y.Snapshot} prevSnapshot
     */
    renderSnapshot(snapshot2, prevSnapshot) {
      if (!prevSnapshot) {
        prevSnapshot = Y2.createSnapshot(Y2.createDeleteSet(), /* @__PURE__ */ new Map());
      }
      this.prosemirrorView.dispatch(
        this._tr.setMeta(ySyncPluginKey, { snapshot: snapshot2, prevSnapshot })
      );
    }
    unrenderSnapshot() {
      this.mapping.clear();
      this.mux(() => {
        const fragmentContent = this.type.toArray().map(
          (t) => createNodeFromYElement(
            /** @type {Y.XmlElement} */
            t,
            this.prosemirrorView.state.schema,
            this
          )
        ).filter((n) => n !== null);
        const tr = this._tr.replace(
          0,
          this.prosemirrorView.state.doc.content.size,
          new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0)
        );
        tr.setMeta(ySyncPluginKey, { snapshot: null, prevSnapshot: null });
        this.prosemirrorView.dispatch(tr);
      });
    }
    _forceRerender() {
      this.mapping.clear();
      this.mux(() => {
        const sel = this.beforeTransactionSelection !== null ? null : this.prosemirrorView.state.selection;
        const fragmentContent = this.type.toArray().map(
          (t) => createNodeFromYElement(
            /** @type {Y.XmlElement} */
            t,
            this.prosemirrorView.state.schema,
            this
          )
        ).filter((n) => n !== null);
        const tr = this._tr.replace(
          0,
          this.prosemirrorView.state.doc.content.size,
          new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0)
        );
        if (sel) {
          const clampedAnchor = min(max(sel.anchor, 0), tr.doc.content.size);
          const clampedHead = min(max(sel.head, 0), tr.doc.content.size);
          tr.setSelection(import_prosemirror_state2.TextSelection.create(tr.doc, clampedAnchor, clampedHead));
        }
        this.prosemirrorView.dispatch(
          tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, binding: this })
        );
      });
    }
    /**
     * @param {Y.Snapshot|Uint8Array} snapshot
     * @param {Y.Snapshot|Uint8Array} prevSnapshot
     * @param {Object} pluginState
     */
    _renderSnapshot(snapshot2, prevSnapshot, pluginState) {
      let historyDoc = this.doc;
      let historyType = this.type;
      if (!snapshot2) {
        snapshot2 = Y2.snapshot(this.doc);
      }
      if (snapshot2 instanceof Uint8Array || prevSnapshot instanceof Uint8Array) {
        if (!(snapshot2 instanceof Uint8Array) || !(prevSnapshot instanceof Uint8Array)) {
          unexpectedCase();
        }
        historyDoc = new Y2.Doc({ gc: false });
        Y2.applyUpdateV2(historyDoc, prevSnapshot);
        prevSnapshot = Y2.snapshot(historyDoc);
        Y2.applyUpdateV2(historyDoc, snapshot2);
        snapshot2 = Y2.snapshot(historyDoc);
        if (historyType._item === null) {
          const rootKey = Array.from(this.doc.share.keys()).find(
            (key) => this.doc.share.get(key) === this.type
          );
          historyType = historyDoc.getXmlFragment(rootKey);
        } else {
          const historyStructs = historyDoc.store.clients.get(historyType._item.id.client) ?? [];
          const itemIndex = Y2.findIndexSS(
            historyStructs,
            historyType._item.id.clock
          );
          const item = (
            /** @type {Y.Item} */
            historyStructs[itemIndex]
          );
          const content = (
            /** @type {Y.ContentType} */
            item.content
          );
          historyType = /** @type {Y.XmlFragment} */
          content.type;
        }
      }
      this.mapping.clear();
      this.mux(() => {
        historyDoc.transact((transaction) => {
          const pud = pluginState.permanentUserData;
          if (pud) {
            pud.dss.forEach((ds) => {
              Y2.iterateDeletedStructs(transaction, ds, (_item) => {
              });
            });
          }
          const computeYChange = (type, id) => {
            const user = type === "added" ? pud.getUserByClientId(id.client) : pud.getUserByDeletedId(id);
            return {
              user,
              type,
              color: getUserColor(
                pluginState.colorMapping,
                pluginState.colors,
                user
              )
            };
          };
          const fragmentContent = Y2.typeListToArraySnapshot(
            historyType,
            new Y2.Snapshot(prevSnapshot.ds, snapshot2.sv)
          ).map((t) => {
            if (!t._item.deleted || isVisible(t._item, snapshot2) || isVisible(t._item, prevSnapshot)) {
              return createNodeFromYElement(
                t,
                this.prosemirrorView.state.schema,
                { mapping: /* @__PURE__ */ new Map(), isOMark: /* @__PURE__ */ new Map() },
                snapshot2,
                prevSnapshot,
                computeYChange
              );
            } else {
              return null;
            }
          }).filter((n) => n !== null);
          const tr = this._tr.replace(
            0,
            this.prosemirrorView.state.doc.content.size,
            new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0)
          );
          this.prosemirrorView.dispatch(
            tr.setMeta(ySyncPluginKey, { isChangeOrigin: true })
          );
        }, ySyncPluginKey);
      });
    }
    /**
     * @param {Array<Y.YEvent<any>>} events
     * @param {Y.Transaction} transaction
     */
    _typeChanged(events, transaction) {
      if (this.prosemirrorView == null) return;
      const syncState = ySyncPluginKey.getState(this.prosemirrorView.state);
      if (events.length === 0 || syncState.snapshot != null || syncState.prevSnapshot != null) {
        this.renderSnapshot(syncState.snapshot, syncState.prevSnapshot);
        return;
      }
      this.mux(() => {
        const delType = (_, type) => this.mapping.delete(type);
        Y2.iterateDeletedStructs(
          transaction,
          transaction.deleteSet,
          (struct) => {
            if (struct.constructor === Y2.Item) {
              const type = (
                /** @type {Y.ContentType} */
                /** @type {Y.Item} */
                struct.content.type
              );
              type && this.mapping.delete(type);
            }
          }
        );
        transaction.changed.forEach(delType);
        transaction.changedParentTypes.forEach(delType);
        const fragmentContent = this.type.toArray().map(
          (t) => createNodeIfNotExists(
            /** @type {Y.XmlElement | Y.XmlHook} */
            t,
            this.prosemirrorView.state.schema,
            this
          )
        ).filter((n) => n !== null);
        let tr = this._tr.replace(
          0,
          this.prosemirrorView.state.doc.content.size,
          new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0)
        );
        restoreRelativeSelection(tr, this.beforeTransactionSelection, this);
        tr = tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: transaction.origin instanceof Y2.UndoManager });
        if (this.beforeTransactionSelection !== null && this._isLocalCursorInView() && transaction.origin !== "remote") {
          tr.scrollIntoView();
        }
        this.prosemirrorView.dispatch(tr);
      });
    }
    /**
     * @param {import('prosemirror-model').Node} doc
     */
    _prosemirrorChanged(doc2) {
      this.doc.transact(() => {
        updateYFragment(this.doc, this.type, doc2, this);
        this.beforeTransactionSelection = getRelativeSelection(
          this,
          this.prosemirrorView.state
        );
      }, ySyncPluginKey);
    }
    /**
     * View is ready to listen to changes. Register observers.
     * @param {any} prosemirrorView
     */
    initView(prosemirrorView) {
      if (this.prosemirrorView != null) this.destroy();
      this.prosemirrorView = prosemirrorView;
      this.doc.on("beforeAllTransactions", this.beforeAllTransactions);
      this.doc.on("afterAllTransactions", this.afterAllTransactions);
      this.type.observeDeep(this._observeFunction);
    }
    destroy() {
      if (this.prosemirrorView == null) return;
      this.prosemirrorView = null;
      this.type.unobserveDeep(this._observeFunction);
      this.doc.off("beforeAllTransactions", this.beforeAllTransactions);
      this.doc.off("afterAllTransactions", this.afterAllTransactions);
    }
  };
  var createNodeIfNotExists = (el, schema, meta, snapshot2, prevSnapshot, computeYChange) => {
    const node = (
      /** @type {PModel.Node} */
      meta.mapping.get(el)
    );
    if (node === void 0) {
      if (el instanceof Y2.XmlElement) {
        return createNodeFromYElement(
          el,
          schema,
          meta,
          snapshot2,
          prevSnapshot,
          computeYChange
        );
      } else {
        throw methodUnimplemented();
      }
    }
    return node;
  };
  var createNodeFromYElement = (el, schema, meta, snapshot2, prevSnapshot, computeYChange) => {
    const children = [];
    const createChildren = (type) => {
      if (type instanceof Y2.XmlElement) {
        const n = createNodeIfNotExists(
          type,
          schema,
          meta,
          snapshot2,
          prevSnapshot,
          computeYChange
        );
        if (n !== null) {
          children.push(n);
        }
      } else {
        const nextytext = (
          /** @type {Y.ContentType} */
          type._item.right?.content?.type
        );
        if (nextytext instanceof Y2.Text && !nextytext._item.deleted && nextytext._item.id.client === nextytext.doc.clientID) {
          type.applyDelta([
            { retain: type.length },
            ...nextytext.toDelta()
          ]);
          nextytext.doc.transact((tr) => {
            nextytext._item.delete(tr);
          });
        }
        const ns = createTextNodesFromYText(
          type,
          schema,
          meta,
          snapshot2,
          prevSnapshot,
          computeYChange
        );
        if (ns !== null) {
          ns.forEach((textchild) => {
            if (textchild !== null) {
              children.push(textchild);
            }
          });
        }
      }
    };
    if (snapshot2 === void 0 || prevSnapshot === void 0) {
      el.toArray().forEach(createChildren);
    } else {
      Y2.typeListToArraySnapshot(el, new Y2.Snapshot(prevSnapshot.ds, snapshot2.sv)).forEach(createChildren);
    }
    try {
      const attrs = el.getAttributes(snapshot2);
      if (snapshot2 !== void 0) {
        if (!isVisible(
          /** @type {Y.Item} */
          el._item,
          snapshot2
        )) {
          attrs.ychange = computeYChange ? computeYChange(
            "removed",
            /** @type {Y.Item} */
            el._item.id
          ) : { type: "removed" };
        } else if (!isVisible(
          /** @type {Y.Item} */
          el._item,
          prevSnapshot
        )) {
          attrs.ychange = computeYChange ? computeYChange(
            "added",
            /** @type {Y.Item} */
            el._item.id
          ) : { type: "added" };
        }
      }
      const node = schema.node(el.nodeName, attrs, children);
      meta.mapping.set(el, node);
      return node;
    } catch (e) {
      el.doc.transact((transaction) => {
        el._item.delete(transaction);
      }, ySyncPluginKey);
      meta.mapping.delete(el);
      return null;
    }
  };
  var createTextNodesFromYText = (text, schema, _meta, snapshot2, prevSnapshot, computeYChange) => {
    const nodes = [];
    const deltas = text.toDelta(snapshot2, prevSnapshot, computeYChange);
    try {
      for (let i = 0; i < deltas.length; i++) {
        const delta = deltas[i];
        nodes.push(schema.text(delta.insert, attributesToMarks(delta.attributes, schema)));
      }
    } catch (e) {
      text.doc.transact((transaction) => {
        text._item.delete(transaction);
      }, ySyncPluginKey);
      return null;
    }
    return nodes;
  };
  var createTypeFromTextNodes = (nodes, meta) => {
    const type = new Y2.XmlText();
    const delta = nodes.map((node) => ({
      // @ts-ignore
      insert: node.text,
      attributes: marksToAttributes(node.marks, meta)
    }));
    type.applyDelta(delta);
    meta.mapping.set(type, nodes);
    return type;
  };
  var createTypeFromElementNode = (node, meta) => {
    const type = new Y2.XmlElement(node.type.name);
    for (const key in node.attrs) {
      const val = node.attrs[key];
      if (val !== null && key !== "ychange") {
        type.setAttribute(key, val);
      }
    }
    type.insert(
      0,
      normalizePNodeContent(node).map(
        (n) => createTypeFromTextOrElementNode(n, meta)
      )
    );
    meta.mapping.set(type, node);
    return type;
  };
  var createTypeFromTextOrElementNode = (node, meta) => node instanceof Array ? createTypeFromTextNodes(node, meta) : createTypeFromElementNode(node, meta);
  var isObject = (val) => typeof val === "object" && val !== null;
  var equalAttrs = (pattrs, yattrs) => {
    const keys2 = Object.keys(pattrs).filter((key) => pattrs[key] !== null);
    let eq = keys2.length === (yattrs == null ? 0 : Object.keys(yattrs).filter((key) => yattrs[key] !== null).length);
    for (let i = 0; i < keys2.length && eq; i++) {
      const key = keys2[i];
      const l = pattrs[key];
      const r = yattrs[key];
      eq = key === "ychange" || l === r || isObject(l) && isObject(r) && equalAttrs(l, r);
    }
    return eq;
  };
  var normalizePNodeContent = (pnode) => {
    const c = pnode.content.content;
    const res = [];
    for (let i = 0; i < c.length; i++) {
      const n = c[i];
      if (n.isText) {
        const textNodes = [];
        for (let tnode = c[i]; i < c.length && tnode.isText; tnode = c[++i]) {
          textNodes.push(tnode);
        }
        i--;
        res.push(textNodes);
      } else {
        res.push(n);
      }
    }
    return res;
  };
  var equalYTextPText = (ytext, ptexts) => {
    const delta = ytext.toDelta();
    return delta.length === ptexts.length && delta.every(
      /** @type {(d:any,i:number) => boolean} */
      (d, i) => d.insert === /** @type {any} */
      ptexts[i].text && keys(d.attributes || {}).length === ptexts[i].marks.length && every(d.attributes, (attr, yattrname) => {
        const markname = yattr2markname(yattrname);
        const pmarks = ptexts[i].marks;
        return equalAttrs(attr, pmarks.find(
          /** @param {any} mark */
          (mark) => mark.type.name === markname
        )?.attrs);
      })
    );
  };
  var equalYTypePNode = (ytype, pnode) => {
    if (ytype instanceof Y2.XmlElement && !(pnode instanceof Array) && matchNodeName(ytype, pnode)) {
      const normalizedContent = normalizePNodeContent(pnode);
      return ytype._length === normalizedContent.length && equalAttrs(ytype.getAttributes(), pnode.attrs) && ytype.toArray().every(
        (ychild, i) => equalYTypePNode(ychild, normalizedContent[i])
      );
    }
    return ytype instanceof Y2.XmlText && pnode instanceof Array && equalYTextPText(ytype, pnode);
  };
  var mappedIdentity = (mapped, pcontent) => mapped === pcontent || mapped instanceof Array && pcontent instanceof Array && mapped.length === pcontent.length && mapped.every(
    (a, i) => pcontent[i] === a
  );
  var computeChildEqualityFactor = (ytype, pnode, meta) => {
    const yChildren = ytype.toArray();
    const pChildren = normalizePNodeContent(pnode);
    const pChildCnt = pChildren.length;
    const yChildCnt = yChildren.length;
    const minCnt = min(yChildCnt, pChildCnt);
    let left = 0;
    let right = 0;
    let foundMappedChild = false;
    for (; left < minCnt; left++) {
      const leftY = yChildren[left];
      const leftP = pChildren[left];
      if (mappedIdentity(meta.mapping.get(leftY), leftP)) {
        foundMappedChild = true;
      } else if (!equalYTypePNode(leftY, leftP)) {
        break;
      }
    }
    for (; left + right < minCnt; right++) {
      const rightY = yChildren[yChildCnt - right - 1];
      const rightP = pChildren[pChildCnt - right - 1];
      if (mappedIdentity(meta.mapping.get(rightY), rightP)) {
        foundMappedChild = true;
      } else if (!equalYTypePNode(rightY, rightP)) {
        break;
      }
    }
    return {
      equalityFactor: left + right,
      foundMappedChild
    };
  };
  var ytextTrans = (ytext) => {
    let str = "";
    let n = ytext._start;
    const nAttrs = {};
    while (n !== null) {
      if (!n.deleted) {
        if (n.countable && n.content instanceof Y2.ContentString) {
          str += n.content.str;
        } else if (n.content instanceof Y2.ContentFormat) {
          nAttrs[n.content.key] = null;
        }
      }
      n = n.right;
    }
    return {
      str,
      nAttrs
    };
  };
  var updateYText = (ytext, ptexts, meta) => {
    meta.mapping.set(ytext, ptexts);
    const { nAttrs, str } = ytextTrans(ytext);
    const content = ptexts.map((p) => ({
      insert: (
        /** @type {any} */
        p.text
      ),
      attributes: Object.assign({}, nAttrs, marksToAttributes(p.marks, meta))
    }));
    const { insert, remove, index } = simpleDiff(
      str,
      content.map((c) => c.insert).join("")
    );
    ytext.delete(index, remove);
    ytext.insert(index, insert);
    ytext.applyDelta(
      content.map((c) => ({ retain: c.insert.length, attributes: c.attributes }))
    );
  };
  var hashedMarkNameRegex = /(.*)(--[a-zA-Z0-9+/=]{8})$/;
  var yattr2markname = (attrName) => hashedMarkNameRegex.exec(attrName)?.[1] ?? attrName;
  var attributesToMarks = (attrs, schema) => {
    const marks = [];
    for (const markName in attrs) {
      marks.push(schema.mark(yattr2markname(markName), attrs[markName]));
    }
    return marks;
  };
  var marksToAttributes = (marks, meta) => {
    const pattrs = {};
    marks.forEach((mark) => {
      if (mark.type.name !== "ychange") {
        const isOverlapping = setIfUndefined(meta.isOMark, mark.type, () => !mark.type.excludes(mark.type));
        pattrs[isOverlapping ? `${mark.type.name}--${hashOfJSON(mark.toJSON())}` : mark.type.name] = mark.attrs;
      }
    });
    return pattrs;
  };
  var updateYFragment = (y, yDomFragment, pNode, meta) => {
    if (yDomFragment instanceof Y2.XmlElement && yDomFragment.nodeName !== pNode.type.name) {
      throw new Error("node name mismatch!");
    }
    meta.mapping.set(yDomFragment, pNode);
    if (yDomFragment instanceof Y2.XmlElement) {
      const yDomAttrs = yDomFragment.getAttributes();
      const pAttrs = pNode.attrs;
      for (const key in pAttrs) {
        if (pAttrs[key] !== null) {
          if (yDomAttrs[key] !== pAttrs[key] && key !== "ychange") {
            yDomFragment.setAttribute(key, pAttrs[key]);
          }
        } else {
          yDomFragment.removeAttribute(key);
        }
      }
      for (const key in yDomAttrs) {
        if (pAttrs[key] === void 0) {
          yDomFragment.removeAttribute(key);
        }
      }
    }
    const pChildren = normalizePNodeContent(pNode);
    const pChildCnt = pChildren.length;
    const yChildren = yDomFragment.toArray();
    const yChildCnt = yChildren.length;
    const minCnt = min(pChildCnt, yChildCnt);
    let left = 0;
    let right = 0;
    for (; left < minCnt; left++) {
      const leftY = yChildren[left];
      const leftP = pChildren[left];
      if (!mappedIdentity(meta.mapping.get(leftY), leftP)) {
        if (equalYTypePNode(leftY, leftP)) {
          meta.mapping.set(leftY, leftP);
        } else {
          break;
        }
      }
    }
    for (; right + left < minCnt; right++) {
      const rightY = yChildren[yChildCnt - right - 1];
      const rightP = pChildren[pChildCnt - right - 1];
      if (!mappedIdentity(meta.mapping.get(rightY), rightP)) {
        if (equalYTypePNode(rightY, rightP)) {
          meta.mapping.set(rightY, rightP);
        } else {
          break;
        }
      }
    }
    y.transact(() => {
      while (yChildCnt - left - right > 0 && pChildCnt - left - right > 0) {
        const leftY = yChildren[left];
        const leftP = pChildren[left];
        const rightY = yChildren[yChildCnt - right - 1];
        const rightP = pChildren[pChildCnt - right - 1];
        if (leftY instanceof Y2.XmlText && leftP instanceof Array) {
          if (!equalYTextPText(leftY, leftP)) {
            updateYText(leftY, leftP, meta);
          }
          left += 1;
        } else {
          let updateLeft = leftY instanceof Y2.XmlElement && matchNodeName(leftY, leftP);
          let updateRight = rightY instanceof Y2.XmlElement && matchNodeName(rightY, rightP);
          if (updateLeft && updateRight) {
            const equalityLeft = computeChildEqualityFactor(
              /** @type {Y.XmlElement} */
              leftY,
              /** @type {PModel.Node} */
              leftP,
              meta
            );
            const equalityRight = computeChildEqualityFactor(
              /** @type {Y.XmlElement} */
              rightY,
              /** @type {PModel.Node} */
              rightP,
              meta
            );
            if (equalityLeft.foundMappedChild && !equalityRight.foundMappedChild) {
              updateRight = false;
            } else if (!equalityLeft.foundMappedChild && equalityRight.foundMappedChild) {
              updateLeft = false;
            } else if (equalityLeft.equalityFactor < equalityRight.equalityFactor) {
              updateLeft = false;
            } else {
              updateRight = false;
            }
          }
          if (updateLeft) {
            updateYFragment(
              y,
              /** @type {Y.XmlFragment} */
              leftY,
              /** @type {PModel.Node} */
              leftP,
              meta
            );
            left += 1;
          } else if (updateRight) {
            updateYFragment(
              y,
              /** @type {Y.XmlFragment} */
              rightY,
              /** @type {PModel.Node} */
              rightP,
              meta
            );
            right += 1;
          } else {
            meta.mapping.delete(yDomFragment.get(left));
            yDomFragment.delete(left, 1);
            yDomFragment.insert(left, [
              createTypeFromTextOrElementNode(leftP, meta)
            ]);
            left += 1;
          }
        }
      }
      const yDelLen = yChildCnt - left - right;
      if (yChildCnt === 1 && pChildCnt === 0 && yChildren[0] instanceof Y2.XmlText) {
        meta.mapping.delete(yChildren[0]);
        yChildren[0].delete(0, yChildren[0].length);
      } else if (yDelLen > 0) {
        yDomFragment.slice(left, left + yDelLen).forEach((type) => meta.mapping.delete(type));
        yDomFragment.delete(left, yDelLen);
      }
      if (left + right < pChildCnt) {
        const ins = [];
        for (let i = left; i < pChildCnt - right; i++) {
          ins.push(createTypeFromTextOrElementNode(pChildren[i], meta));
        }
        yDomFragment.insert(left, ins);
      }
    }, ySyncPluginKey);
  };
  var matchNodeName = (yElement, pNode) => !(pNode instanceof Array) && yElement.nodeName === pNode.type.name;

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/lib.js
  var Y3 = __toESM(__require("yjs"), 1);
  var import_prosemirror_view = __require("prosemirror-view");
  var import_prosemirror_model = __require("prosemirror-model");
  var viewsToUpdate = null;
  var updateMetas = () => {
    const ups = (
      /** @type {Map<EditorView, Map<any, any>>} */
      viewsToUpdate
    );
    viewsToUpdate = null;
    ups.forEach((metas, view) => {
      const tr = view.state.tr;
      const syncState = ySyncPluginKey.getState(view.state);
      if (syncState && syncState.binding && !syncState.binding.isDestroyed) {
        metas.forEach((val, key) => {
          tr.setMeta(key, val);
        });
        view.dispatch(tr);
      }
    });
  };
  var setMeta = (view, key, value) => {
    if (!viewsToUpdate) {
      viewsToUpdate = /* @__PURE__ */ new Map();
      timeout(0, updateMetas);
    }
    setIfUndefined(viewsToUpdate, view, create3).set(key, value);
  };
  var absolutePositionToRelativePosition = (pos, type, mapping) => {
    if (pos === 0) {
      return Y3.createRelativePositionFromTypeIndex(type, 0, type.length === 0 ? -1 : 0);
    }
    let n = type._first === null ? null : (
      /** @type {Y.ContentType} */
      type._first.content.type
    );
    while (n !== null && type !== n) {
      if (n instanceof Y3.XmlText) {
        if (n._length >= pos) {
          return Y3.createRelativePositionFromTypeIndex(n, pos, type.length === 0 ? -1 : 0);
        } else {
          pos -= n._length;
        }
        if (n._item !== null && n._item.next !== null) {
          n = /** @type {Y.ContentType} */
          n._item.next.content.type;
        } else {
          do {
            n = n._item === null ? null : n._item.parent;
            pos--;
          } while (n !== type && n !== null && n._item !== null && n._item.next === null);
          if (n !== null && n !== type) {
            n = n._item === null ? null : (
              /** @type {Y.ContentType} */
              /** @type Y.Item */
              n._item.next.content.type
            );
          }
        }
      } else {
        const pNodeSize = (
          /** @type {any} */
          (mapping.get(n) || { nodeSize: 0 }).nodeSize
        );
        if (n._first !== null && pos < pNodeSize) {
          n = /** @type {Y.ContentType} */
          n._first.content.type;
          pos--;
        } else {
          if (pos === 1 && n._length === 0 && pNodeSize > 1) {
            return new Y3.RelativePosition(n._item === null ? null : n._item.id, n._item === null ? Y3.findRootTypeKey(n) : null, null);
          }
          pos -= pNodeSize;
          if (n._item !== null && n._item.next !== null) {
            n = /** @type {Y.ContentType} */
            n._item.next.content.type;
          } else {
            if (pos === 0) {
              n = n._item === null ? n : n._item.parent;
              return new Y3.RelativePosition(n._item === null ? null : n._item.id, n._item === null ? Y3.findRootTypeKey(n) : null, null);
            }
            do {
              n = /** @type {Y.Item} */
              n._item.parent;
              pos--;
            } while (n !== type && /** @type {Y.Item} */
            n._item.next === null);
            if (n !== type) {
              n = /** @type {Y.ContentType} */
              /** @type {Y.Item} */
              /** @type {Y.Item} */
              n._item.next.content.type;
            }
          }
        }
      }
      if (n === null) {
        throw unexpectedCase();
      }
      if (pos === 0 && n.constructor !== Y3.XmlText && n !== type) {
        return createRelativePosition(n._item.parent, n._item);
      }
    }
    return Y3.createRelativePositionFromTypeIndex(type, type._length, type.length === 0 ? -1 : 0);
  };
  var createRelativePosition = (type, item) => {
    let typeid = null;
    let tname = null;
    if (type._item === null) {
      tname = Y3.findRootTypeKey(type);
    } else {
      typeid = Y3.createID(type._item.id.client, type._item.id.clock);
    }
    return new Y3.RelativePosition(typeid, tname, item.id);
  };
  var relativePositionToAbsolutePosition = (y, documentType, relPos, mapping) => {
    const decodedPos = Y3.createAbsolutePositionFromRelativePosition(relPos, y);
    if (decodedPos === null || decodedPos.type !== documentType && !Y3.isParentOf(documentType, decodedPos.type._item)) {
      return null;
    }
    let type = decodedPos.type;
    let pos = 0;
    if (type.constructor === Y3.XmlText) {
      pos = decodedPos.index;
    } else if (type._item === null || !type._item.deleted) {
      let n = type._first;
      let i = 0;
      while (i < type._length && i < decodedPos.index && n !== null) {
        if (!n.deleted) {
          const t = (
            /** @type {Y.ContentType} */
            n.content.type
          );
          i++;
          if (t instanceof Y3.XmlText) {
            pos += t._length;
          } else {
            pos += /** @type {any} */
            mapping.get(t).nodeSize;
          }
        }
        n = /** @type {Y.Item} */
        n.right;
      }
      pos += 1;
    }
    while (type !== documentType && type._item !== null) {
      const parent = type._item.parent;
      if (parent._item === null || !parent._item.deleted) {
        pos += 1;
        let n = (
          /** @type {Y.AbstractType} */
          parent._first
        );
        while (n !== null) {
          const contentType = (
            /** @type {Y.ContentType} */
            n.content.type
          );
          if (contentType === type) {
            break;
          }
          if (!n.deleted) {
            if (contentType instanceof Y3.XmlText) {
              pos += contentType._length;
            } else {
              pos += /** @type {any} */
              mapping.get(contentType).nodeSize;
            }
          }
          n = n.right;
        }
      }
      type = /** @type {Y.AbstractType} */
      parent;
    }
    return pos - 1;
  };
  function prosemirrorToYXmlFragment(doc2, xmlFragment) {
    const type = xmlFragment || new Y3.XmlFragment();
    const ydoc = type.doc ? type.doc : { transact: (transaction) => transaction(void 0) };
    updateYFragment(ydoc, type, doc2, { mapping: /* @__PURE__ */ new Map(), isOMark: /* @__PURE__ */ new Map() });
    return type;
  }

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/plugins/cursor-plugin.js
  var defaultAwarenessStateFilter = (currentClientId, userClientId, _user) => currentClientId !== userClientId;
  var defaultCursorBuilder = (user) => {
    const cursor = document.createElement("span");
    cursor.classList.add("ProseMirror-yjs-cursor");
    cursor.setAttribute("style", `border-color: ${user.color}`);
    const userDiv = document.createElement("div");
    userDiv.setAttribute("style", `background-color: ${user.color}`);
    userDiv.insertBefore(document.createTextNode(user.name), null);
    const nonbreakingSpace1 = document.createTextNode("\u2060");
    const nonbreakingSpace2 = document.createTextNode("\u2060");
    cursor.insertBefore(nonbreakingSpace1, null);
    cursor.insertBefore(userDiv, null);
    cursor.insertBefore(nonbreakingSpace2, null);
    return cursor;
  };
  var defaultSelectionBuilder = (user) => {
    return {
      style: `background-color: ${user.color}70`,
      class: "ProseMirror-yjs-selection"
    };
  };
  var rxValidColor = /^#[0-9a-fA-F]{6}$/;
  var createDecorations = (state, awareness, awarenessFilter, createCursor, createSelection) => {
    const ystate = ySyncPluginKey.getState(state);
    const y = ystate.doc;
    const decorations = [];
    if (ystate.snapshot != null || ystate.prevSnapshot != null || ystate.binding.mapping.size === 0) {
      return import_prosemirror_view2.DecorationSet.create(state.doc, []);
    }
    awareness.getStates().forEach((aw, clientId) => {
      if (!awarenessFilter(y.clientID, clientId, aw)) {
        return;
      }
      if (aw.cursor != null) {
        const user = aw.user || {};
        if (user.color == null) {
          user.color = "#ffa500";
        } else if (!rxValidColor.test(user.color)) {
          console.warn("A user uses an unsupported color format", user);
        }
        if (user.name == null) {
          user.name = `User: ${clientId}`;
        }
        let anchor = relativePositionToAbsolutePosition(
          y,
          ystate.type,
          Y4.createRelativePositionFromJSON(aw.cursor.anchor),
          ystate.binding.mapping
        );
        let head = relativePositionToAbsolutePosition(
          y,
          ystate.type,
          Y4.createRelativePositionFromJSON(aw.cursor.head),
          ystate.binding.mapping
        );
        if (anchor !== null && head !== null) {
          const maxsize = max(state.doc.content.size - 1, 0);
          anchor = min(anchor, maxsize);
          head = min(head, maxsize);
          decorations.push(
            import_prosemirror_view2.Decoration.widget(head, () => createCursor(user, clientId), {
              key: clientId + "",
              side: 10
            })
          );
          const from2 = min(anchor, head);
          const to = max(anchor, head);
          decorations.push(
            import_prosemirror_view2.Decoration.inline(from2, to, createSelection(user, clientId), {
              inclusiveEnd: true,
              inclusiveStart: false
            })
          );
        }
      }
    });
    return import_prosemirror_view2.DecorationSet.create(state.doc, decorations);
  };
  var yCursorPlugin = (awareness, {
    awarenessStateFilter = defaultAwarenessStateFilter,
    cursorBuilder = defaultCursorBuilder,
    selectionBuilder = defaultSelectionBuilder,
    getSelection = (state) => state.selection
  } = {}, cursorStateField = "cursor") => new import_prosemirror_state3.Plugin({
    key: yCursorPluginKey,
    state: {
      init(_, state) {
        return createDecorations(
          state,
          awareness,
          awarenessStateFilter,
          cursorBuilder,
          selectionBuilder
        );
      },
      apply(tr, prevState, _oldState, newState) {
        const ystate = ySyncPluginKey.getState(newState);
        const yCursorState = tr.getMeta(yCursorPluginKey);
        if (ystate && ystate.isChangeOrigin || yCursorState && yCursorState.awarenessUpdated) {
          return createDecorations(
            newState,
            awareness,
            awarenessStateFilter,
            cursorBuilder,
            selectionBuilder
          );
        }
        return prevState.map(tr.mapping, tr.doc);
      }
    },
    props: {
      decorations: (state) => {
        return yCursorPluginKey.getState(state);
      }
    },
    view: (view) => {
      const awarenessListener = () => {
        if (view.docView) {
          setMeta(view, yCursorPluginKey, { awarenessUpdated: true });
        }
      };
      const updateCursorInfo = () => {
        const ystate = ySyncPluginKey.getState(view.state);
        const current = awareness.getLocalState() || {};
        if (view.hasFocus()) {
          const selection = getSelection(view.state);
          const anchor = absolutePositionToRelativePosition(
            selection.anchor,
            ystate.type,
            ystate.binding.mapping
          );
          const head = absolutePositionToRelativePosition(
            selection.head,
            ystate.type,
            ystate.binding.mapping
          );
          if (current.cursor == null || !Y4.compareRelativePositions(
            Y4.createRelativePositionFromJSON(current.cursor.anchor),
            anchor
          ) || !Y4.compareRelativePositions(
            Y4.createRelativePositionFromJSON(current.cursor.head),
            head
          )) {
            awareness.setLocalStateField(cursorStateField, {
              anchor,
              head
            });
          }
        } else if (current.cursor != null && relativePositionToAbsolutePosition(
          ystate.doc,
          ystate.type,
          Y4.createRelativePositionFromJSON(current.cursor.anchor),
          ystate.binding.mapping
        ) !== null) {
          awareness.setLocalStateField(cursorStateField, null);
        }
      };
      awareness.on("change", awarenessListener);
      view.dom.addEventListener("focusin", updateCursorInfo);
      view.dom.addEventListener("focusout", updateCursorInfo);
      return {
        update: updateCursorInfo,
        destroy: () => {
          view.dom.removeEventListener("focusin", updateCursorInfo);
          view.dom.removeEventListener("focusout", updateCursorInfo);
          awareness.off("change", awarenessListener);
          awareness.setLocalStateField(cursorStateField, null);
        }
      };
    }
  });

  // node_modules/.pnpm/y-prosemirror@1.3.7_patch_hash=clvvlcquawfe6tbof2n33ojq7m_prosemirror-model@1.25.4_prosemirro_bipfcyy7lelftrn46yzm76fxam/node_modules/y-prosemirror/src/plugins/undo-plugin.js
  var import_prosemirror_state4 = __require("prosemirror-state");
  var import_yjs = __require("yjs");
  var undo = (state) => yUndoPluginKey.getState(state)?.undoManager?.undo() != null;
  var redo = (state) => yUndoPluginKey.getState(state)?.undoManager?.redo() != null;
  var defaultProtectedNodes = /* @__PURE__ */ new Set(["paragraph"]);
  var defaultDeleteFilter = (item, protectedNodes) => !(item instanceof import_yjs.Item) || !(item.content instanceof import_yjs.ContentType) || !(item.content.type instanceof import_yjs.Text || item.content.type instanceof import_yjs.XmlElement && protectedNodes.has(item.content.type.nodeName)) || item.content.type._length === 0;
  var yUndoPlugin = ({ protectedNodes = defaultProtectedNodes, trackedOrigins = [], undoManager = null } = {}) => new import_prosemirror_state4.Plugin({
    key: yUndoPluginKey,
    state: {
      init: (initargs, state) => {
        const ystate = ySyncPluginKey.getState(state);
        const _undoManager = undoManager || new import_yjs.UndoManager(ystate.type, {
          trackedOrigins: new Set([ySyncPluginKey].concat(trackedOrigins)),
          deleteFilter: (item) => defaultDeleteFilter(item, protectedNodes),
          captureTransaction: (tr) => tr.meta.get("addToHistory") !== false
        });
        return {
          undoManager: _undoManager,
          prevSel: null,
          hasUndoOps: _undoManager.undoStack.length > 0,
          hasRedoOps: _undoManager.redoStack.length > 0
        };
      },
      apply: (tr, val, oldState, state) => {
        const binding = ySyncPluginKey.getState(state).binding;
        const undoManager2 = val.undoManager;
        const hasUndoOps = undoManager2.undoStack.length > 0;
        const hasRedoOps = undoManager2.redoStack.length > 0;
        if (binding) {
          return {
            undoManager: undoManager2,
            prevSel: getRelativeSelection(binding, oldState),
            hasUndoOps,
            hasRedoOps
          };
        } else {
          if (hasUndoOps !== val.hasUndoOps || hasRedoOps !== val.hasRedoOps) {
            return Object.assign({}, val, {
              hasUndoOps: undoManager2.undoStack.length > 0,
              hasRedoOps: undoManager2.redoStack.length > 0
            });
          } else {
            return val;
          }
        }
      }
    },
    view: (view) => {
      const ystate = ySyncPluginKey.getState(view.state);
      const undoManager2 = yUndoPluginKey.getState(view.state).undoManager;
      undoManager2.on("stack-item-added", ({ stackItem }) => {
        const binding = ystate.binding;
        if (binding) {
          stackItem.meta.set(binding, yUndoPluginKey.getState(view.state).prevSel);
        }
      });
      undoManager2.on("stack-item-popped", ({ stackItem }) => {
        const binding = ystate.binding;
        if (binding) {
          binding.beforeTransactionSelection = stackItem.meta.get(binding) || binding.beforeTransactionSelection;
        }
      });
      return {
        destroy: () => {
          undoManager2.destroy();
        }
      };
    }
  });

  // yjs-prosemirror-entry.js
  var base = typeof window !== "undefined" && window.SharedEditsYjs ? window.SharedEditsYjs : {};
  var SharedEditsYjs = {
    ...base,
    prosemirrorToYXmlFragment,
    ySyncPlugin,
    yCursorPlugin,
    yUndoPlugin,
    undo,
    redo
  };
  if (typeof window !== "undefined") {
    window.SharedEditsYjs = SharedEditsYjs;
    if (base.Y) {
      window.Y ||= base.Y;
    }
  }
})();
