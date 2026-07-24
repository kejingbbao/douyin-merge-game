// test/hmac.test.js
// 校验纯 JS HMAC-SHA256 / SHA-256 与 Node crypto 完全一致（防刷分关键：前后端必须算出同值）
const crypto = require('crypto');
const HMAC = require('../src/hmac.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('FAIL: ' + m); } }

const cases = [
  { key: 'secret', msg: 'u1|500|1700000000' },
  { key: '', msg: 'abc|0|1' },
  { key: 'a-very-long-secret-key-1234567890!@#', msg: 'uid_xyz|999999|1700000123' },
  { key: 'k', msg: '|0|' },
];

for (const c of cases) {
  const js = HMAC.hmacSha256Hex(c.key, c.msg);
  const node = crypto.createHmac('sha256', c.key).update(c.msg).digest('hex');
  ok(js === node, 'HMAC 一致: key=' + JSON.stringify(c.key) + ' msg=' + JSON.stringify(c.msg) + ' js=' + js + ' node=' + node);
}

// SHA-256 基础向量（空串 / "abc"）
ok(HMAC.sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256("") 向量');
ok(HMAC.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc") 向量');

console.log('hmac.test: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
