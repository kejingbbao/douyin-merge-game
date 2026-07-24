// src/hmac.js —— 纯 JS 实现 SHA-256 + HMAC-SHA256（抖音小游戏运行时无 Node crypto，需自带）
// 同时支持 CommonJS(require) 与浏览器/小游戏全局。
// 用途：客户端对「上报分数」做 HMAC 签名，后端用相同密钥验签，防止随意伪造高分。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HMAC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  // 返回原始 32 字节摘要
  function sha256Raw(bytes) {
    const Hh = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = bytes.length;
    const bitLen = l * 8;
    const withOne = l + 1;
    const pad = (56 - (withOne % 64) + 64) % 64;
    const total = withOne + pad + 8;
    const msg = new Uint8Array(total);
    msg.set(bytes, 0);
    msg[l] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(total - 4, bitLen >>> 0, false);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = Hh[0], b = Hh[1], c = Hh[2], d = Hh[3], e = Hh[4], f = Hh[5], g = Hh[6], h = Hh[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      Hh[0] = (Hh[0] + a) >>> 0; Hh[1] = (Hh[1] + b) >>> 0; Hh[2] = (Hh[2] + c) >>> 0;
      Hh[3] = (Hh[3] + d) >>> 0; Hh[4] = (Hh[4] + e) >>> 0; Hh[5] = (Hh[5] + f) >>> 0;
      Hh[6] = (Hh[6] + g) >>> 0; Hh[7] = (Hh[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (Hh[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (Hh[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (Hh[i] >>> 8) & 0xff;
      out[i * 4 + 3] = Hh[i] & 0xff;
    }
    return out;
  }

  function strToBytes(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  function hmacSha256Hex(key, msg) {
    const blockSize = 64;
    let keyBytes = strToBytes(key);
    if (keyBytes.length > blockSize) keyBytes = sha256Raw(keyBytes); // 密钥过长：先哈希成 32 字节
    const oKey = new Uint8Array(blockSize);
    const iKey = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      const kb = i < keyBytes.length ? keyBytes[i] : 0;
      oKey[i] = kb ^ 0x5c;
      iKey[i] = kb ^ 0x36;
    }
    const inner = new Uint8Array(blockSize + msg.length);
    inner.set(iKey, 0);
    inner.set(strToBytes(msg), blockSize);
    const innerHash = sha256Raw(inner); // 32 字节原始摘要
    const outer = new Uint8Array(blockSize + 32);
    outer.set(oKey, 0);
    outer.set(innerHash, blockSize);
    return toHex(sha256Raw(outer));
  }

  return {
    sha256Hex: (s) => toHex(sha256Raw(strToBytes(s))),
    hmacSha256Hex,
  };
});
