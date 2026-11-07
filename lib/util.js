'use strict';
// 共用工具：密碼雜湊、session 簽章（沿用 realty-match 已驗證的實作）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 正式環境以 APP_SECRET 注入；未設定時退回檔案（開發模式）
let SECRET = process.env.APP_SECRET;
if (!SECRET) {
  const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function unsign(token) {
  if (!token) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
// 密碼版本指紋：嵌入 session／重設 token，密碼一改舊 token 全部失效
function pwVersion(passwordHash) {
  return crypto.createHash('sha256').update(passwordHash).digest('hex').slice(0, 8);
}
// 台北時區的日期字串（每日額度以台灣的「一天」計）
function taipeiDay(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = { DATA_DIR, SECRET, hashPassword, verifyPassword, sign, unsign, pwVersion, taipeiDay };
