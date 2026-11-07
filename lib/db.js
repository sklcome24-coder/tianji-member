'use strict';
// 儲存層：SQLite 單一檔案（Node 22 內建 node:sqlite，免另開資料庫服務，每月主機成本最低）
// 正式環境務必把 DATA_DIR 掛在永久磁碟（Zeabur/Railway Volume），並每日備份 members.db。
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, hashPassword } = require('./util');

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'members.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  email_verified INTEGER NOT NULL DEFAULT 0,
  plan_expires_at TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  tcm_consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  trade_no TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL,
  item TEXT NOT NULL,
  amount INTEGER NOT NULL,
  days INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  raw TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  user_id INTEGER,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(created_at);
`);

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function audit(event, userId, detail = '') {
  try { run(`INSERT INTO audit(event,user_id,detail) VALUES(?,?,?)`, event, userId ?? null, String(detail).slice(0, 500)); }
  catch (e) { console.error('audit 寫入失敗', e.message); }
}

// 首次啟動建立管理員；ADMIN_RESET_PASSWORD=1 時以 ADMIN_PASSWORD 重設（救援用，用完移除）
function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || !pw) return;
  const u = one(`SELECT * FROM users WHERE email=?`, email);
  if (!u) {
    if (pw.length < 12) { console.error('ADMIN_PASSWORD 至少 12 碼，未建立管理員'); return; }
    run(`INSERT INTO users(name,email,password_hash,role,email_verified) VALUES(?,?,?,'admin',1)`, '管理員', email, hashPassword(pw));
    console.log('已建立管理員', email);
  } else if (process.env.ADMIN_RESET_PASSWORD === '1') {
    run(`UPDATE users SET password_hash=?, role='admin', suspended=0 WHERE id=?`, hashPassword(pw), u.id);
    audit('admin.password_reset_env', u.id);
    console.log('已依 ADMIN_RESET_PASSWORD 重設管理員密碼，請移除該環境變數');
  }
}

module.exports = { db, one, all, run, audit, ensureAdmin };
