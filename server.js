'use strict';
// 自學中醫、紫微斗數、梅花易數、六爻卜卦、玄空飛星 應用學習平台：會員、每日 AI 額度、綠界付費方案，並把 tianji-platform 的工具頁放在登入之後。
// 工具頁原封不動：它們連不到 127.0.0.1:8765 時會讀 backend.json，本站回 {"api":"/kb"}，
// AI 請求就走本站的 /kb 代理——在這裡驗會員、扣額度，再換上後端金鑰轉給知識庫主機。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword, sign, unsign, pwVersion, taipeiDay } = require('./lib/util');
const { one, all, run, audit, ensureAdmin } = require('./lib/db');
const mailer = require('./lib/mailer');
const payment = require('./lib/payment');

const PORT = +process.env.PORT || 3460;
const IS_PROD = process.env.NODE_ENV === 'production';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOOLS_DIR = path.resolve(process.env.TOOLS_DIR || path.join(__dirname, 'tools'));
const KB_BACKEND_URL = (process.env.KB_BACKEND_URL || '').replace(/\/$/, '');
const KB_BACKEND_KEY = process.env.KB_BACKEND_KEY || '';
const FREE_DAILY_AI = +(process.env.FREE_DAILY_AI ?? 3);
const PAID_DAILY_AI = +(process.env.PAID_DAILY_AI ?? 60);
const SITE_NAME = mailer.SITE_NAME;

// 付費方案（價格可用環境變數調整，不必改程式）
const PLANS = {
  m1: { name: '月繳會員', days: 30, price: +(process.env.PLAN_MONTH_PRICE || 299) },
  y1: { name: '年繳會員', days: 365, price: +(process.env.PLAN_YEAR_PRICE || 2990) },
};

// 需要登入才能開的工具頁；jingfang 另需簽署「學習用途同意書」
const TOOL_PAGES = new Set(['ziwei.html', 'liuyao.html', 'xuankong.html', 'jingfang.html']);
const CONSENT_PAGES = new Set(['jingfang.html']);
const TOOL_STATIC_EXT = new Set(['.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.webp', '.gif']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
};

// ---------- 會員狀態 ----------
const nowIso = () => new Date().toISOString();
function isPaid(u) { return u.role === 'admin' || (!!u.plan_expires_at && u.plan_expires_at > nowIso()); }
function dailyLimit(u) { return isPaid(u) ? PAID_DAILY_AI : FREE_DAILY_AI; }
function usedToday(u) { return one(`SELECT n FROM usage WHERE user_id=? AND day=?`, u.id, taipeiDay())?.n || 0; }
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, emailVerified: !!u.email_verified,
    planExpiresAt: u.plan_expires_at, paid: isPaid(u), tcmConsent: !!u.tcm_consent_at,
    aiUsedToday: usedToday(u), aiDailyLimit: dailyLimit(u), createdAt: u.created_at,
  };
}

// 額度：先預扣，上游失敗再退回——避免同時送多個請求繞過上限
function reserveQuota(u) {
  const day = taipeiDay();
  run(`INSERT INTO usage(user_id,day,n) VALUES(?,?,0) ON CONFLICT(user_id,day) DO NOTHING`, u.id, day);
  const r = run(`UPDATE usage SET n=n+1 WHERE user_id=? AND day=? AND n<?`, u.id, day, dailyLimit(u));
  return r.changes === 1 ? day : null;
}
function refundQuota(u, day) { run(`UPDATE usage SET n=MAX(n-1,0) WHERE user_id=? AND day=?`, u.id, day); }

// ---------- HTTP 工具 ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readBody(req) {
  const data = (await readRaw(req, 1e6)).toString();
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(data)); // 綠界回調
  try { return data ? JSON.parse(data) : {}; } catch { return {}; }
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
    .map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
}
function getSession(req) {
  const p = unsign(cookies(req).sid);
  if (!p || !p.uid) return null;
  const u = one(`SELECT * FROM users WHERE id=?`, p.uid);
  if (!u || u.suspended) return null;
  if (p.pv !== pwVersion(u.password_hash)) return null; // 改密碼後舊 session 全部失效
  return u;
}
const COOKIE_ATTRS = `HttpOnly; SameSite=Lax; Path=/${IS_PROD ? '; Secure' : ''}`;
const SESSION_DAYS = 30;
function setSession(res, u) {
  const token = sign({ uid: u.id, pv: pwVersion(u.password_hash), exp: Date.now() + SESSION_DAYS * 86400e3 });
  res.setHeader('Set-Cookie', `sid=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', `sid=; ${COOKIE_ATTRS}; Max-Age=0`); }

const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
  if (rateBuckets.size > 50000) rateBuckets.clear();
  return ++b.n > max;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const normEmail = e => String(e || '').trim().toLowerCase();

async function sendVerification(u) {
  const token = sign({ vu: u.id, exp: Date.now() + 48 * 3600e3 });
  const url = `${BASE_URL}/api/verify-email?token=${encodeURIComponent(token)}`;
  await mailer.sendVerifyEmail(u.email, url).catch(e => console.error('驗證信寄送失敗:', e.message));
}

// ---------- API 路由 ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

route('POST', '/api/register', async (req, res, body) => {
  if (rateLimited('reg|' + clientIp(req), 5, 3600e3)) return json(res, 429, { error: '註冊次數過多，請稍後再試' });
  const name = String(body.name || '').trim().slice(0, 40);
  const email = normEmail(body.email);
  const pw = String(body.password || '');
  if (!name) return json(res, 400, { error: '請填寫稱呼' });
  if (!validEmail(email)) return json(res, 400, { error: 'Email 格式不正確' });
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return json(res, 400, { error: '密碼至少 8 碼，且需同時含英文與數字' });
  if (!body.agreeTerms) return json(res, 400, { error: '請閱讀並同意服務條款' });
  if (one(`SELECT id FROM users WHERE email=?`, email)) return json(res, 409, { error: '此 Email 已註冊，請直接登入或使用忘記密碼' });
  const r = run(`INSERT INTO users(name,email,password_hash) VALUES(?,?,?)`, name, email, hashPassword(pw));
  const u = one(`SELECT * FROM users WHERE id=?`, r.lastInsertRowid);
  audit('user.register', u.id, email);
  await sendVerification(u);
  setSession(res, u);
  json(res, 200, { user: publicUser(u) });
});

route('GET', '/api/verify-email', async (req, res, body, user, url) => {
  const p = unsign(url.searchParams.get('token'));
  if (!p || !p.vu) return redirect(res, '/?verified=fail');
  run(`UPDATE users SET email_verified=1 WHERE id=?`, p.vu);
  audit('user.verify_email', p.vu);
  redirect(res, '/?verified=ok');
});

route('POST', '/api/me/resend-verify', async (req, res, body, user) => {
  if (!user) return json(res, 401, { error: '請先登入' });
  if (user.email_verified) return json(res, 200, { ok: true });
  if (rateLimited('resend|' + user.id, 3, 3600e3)) return json(res, 429, { error: '寄送太頻繁，請一小時後再試' });
  await sendVerification(user);
  json(res, 200, { ok: true });
});

const loginFails = new Map();
route('POST', '/api/login', async (req, res, body) => {
  const email = normEmail(body.email);
  const f = loginFails.get(email);
  if (f && f.n >= 5 && Date.now() - f.t < 15 * 60e3) return json(res, 429, { error: '登入失敗次數過多，請 15 分鐘後再試或使用忘記密碼' });
  if (rateLimited('login|' + clientIp(req), 30, 15 * 60e3)) return json(res, 429, { error: '嘗試次數過多，請稍後再試' });
  const u = one(`SELECT * FROM users WHERE email=?`, email);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) {
    const cur = loginFails.get(email) || { n: 0, t: 0 };
    loginFails.set(email, { n: cur.n + 1, t: Date.now() });
    return json(res, 401, { error: 'Email 或密碼錯誤' });
  }
  if (u.suspended) return json(res, 403, { error: '此帳號已停權，如有疑問請來信客服' });
  loginFails.delete(email);
  setSession(res, u);
  json(res, 200, { user: publicUser(u) });
});
route('POST', '/api/logout', async (req, res) => { clearSession(res); json(res, 200, { ok: true }); });
route('GET', '/api/me', async (req, res, body, user) => json(res, 200, { user: user ? publicUser(user) : null }));

route('POST', '/api/forgot-password', async (req, res, body) => {
  if (rateLimited('forgot|' + clientIp(req), 5, 3600e3)) return json(res, 429, { error: '請求過於頻繁，請稍後再試' });
  const u = one(`SELECT * FROM users WHERE email=?`, normEmail(body.email));
  if (u && !u.suspended) {
    // token 綁密碼版本：密碼一改，同一封信的連結即失效（單次有效）
    const token = sign({ ru: u.id, pv: pwVersion(u.password_hash), exp: Date.now() + 3600e3 });
    await mailer.sendResetEmail(u.email, `${BASE_URL}/?reset=${encodeURIComponent(token)}`).catch(e => console.error(e.message));
    audit('user.forgot_password', u.id);
  }
  json(res, 200, { ok: true }); // 不透露 Email 是否存在
});
route('POST', '/api/reset-password', async (req, res, body) => {
  const p = unsign(body.token);
  const u = p && p.ru ? one(`SELECT * FROM users WHERE id=?`, p.ru) : null;
  if (!u || p.pv !== pwVersion(u.password_hash)) return json(res, 400, { error: '連結已失效或已使用過，請重新申請' });
  const pw = String(body.password || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return json(res, 400, { error: '密碼至少 8 碼，且需同時含英文與數字' });
  run(`UPDATE users SET password_hash=?, email_verified=1 WHERE id=?`, hashPassword(pw), u.id); // 能收信即證明信箱有效
  audit('user.reset_password', u.id);
  json(res, 200, { ok: true });
});
route('POST', '/api/me/password', async (req, res, body, user) => {
  if (!user) return json(res, 401, { error: '請先登入' });
  if (!verifyPassword(String(body.oldPassword || ''), user.password_hash)) return json(res, 400, { error: '舊密碼不正確' });
  const pw = String(body.newPassword || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return json(res, 400, { error: '密碼至少 8 碼，且需同時含英文與數字' });
  run(`UPDATE users SET password_hash=? WHERE id=?`, hashPassword(pw), user.id);
  audit('user.change_password', user.id);
  setSession(res, one(`SELECT * FROM users WHERE id=?`, user.id));
  json(res, 200, { ok: true });
});

// 經方工具的學習用途同意書（留存同意時間，日後有爭議可舉證已告知）
route('POST', '/api/me/tcm-consent', async (req, res, body, user) => {
  if (!user) return json(res, 401, { error: '請先登入' });
  if (!(body.notMedical && body.seeDoctor && body.emergency)) return json(res, 400, { error: '請逐項勾選同意事項' });
  run(`UPDATE users SET tcm_consent_at=? WHERE id=?`, nowIso(), user.id);
  audit('user.tcm_consent', user.id, clientIp(req));
  json(res, 200, { ok: true });
});

route('GET', '/api/plans', async (req, res) => json(res, 200, {
  plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })),
  freeDailyAi: FREE_DAILY_AI, paidDailyAi: PAID_DAILY_AI,
  testMode: payment.IS_TEST_MERCHANT, kbConfigured: !!KB_BACKEND_URL,
}));

// ---------- 金流（綠界）----------
function grantPlan(userId, days) {
  const u = one(`SELECT plan_expires_at FROM users WHERE id=?`, userId);
  const base = u.plan_expires_at && u.plan_expires_at > nowIso() ? new Date(u.plan_expires_at) : new Date();
  run(`UPDATE users SET plan_expires_at=? WHERE id=?`, new Date(base.getTime() + days * 86400e3).toISOString(), userId);
}
function markPaid(order, raw) {
  // 條件式更新確保同一筆訂單只履行一次（綠界可能重送通知）
  const r = run(`UPDATE orders SET status='paid', paid_at=?, raw=? WHERE id=? AND status!='paid'`, nowIso(), raw, order.id);
  if (r.changes !== 1) return false;
  grantPlan(order.user_id, order.days);
  audit('order.paid', order.user_id, `#${order.id} ${order.item} ${order.trade_no}`);
  return true;
}
route('POST', '/api/orders', async (req, res, body, user) => {
  if (!user) return json(res, 401, { error: '請先登入' });
  if (!user.email_verified) return json(res, 403, { error: '請先完成 Email 驗證再購買' });
  const plan = PLANS[body.plan];
  if (!plan) return json(res, 400, { error: '請選擇方案' });
  const tradeNo = ('TJ' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')).toUpperCase().slice(0, 20);
  const r = run(`INSERT INTO orders(user_id,trade_no,plan,item,amount,days) VALUES(?,?,?,?,?,?)`,
    user.id, tradeNo, body.plan, plan.name, plan.price, plan.days);
  audit('order.create', user.id, `#${r.lastInsertRowid} ${plan.name} ${tradeNo} NT$${plan.price}`);
  const formHtml = payment.checkoutForm({
    merchantTradeNo: tradeNo, amount: plan.price, itemName: `${SITE_NAME}-${plan.name}`, tradeDesc: 'membership',
    returnUrl: `${BASE_URL}/api/ecpay/return`, clientBackUrl: `${BASE_URL}/?paid=back`,
  });
  json(res, 200, { orderId: Number(r.lastInsertRowid), tradeNo, formHtml, testMode: payment.IS_TEST_MERCHANT, devSimulate: !IS_PROD });
});
route('POST', '/api/ecpay/return', async (req, res, body) => {
  res.setHeader('Content-Type', 'text/plain');
  if (!payment.verifyCallback(body)) { audit('order.callback_invalid', null, JSON.stringify(body).slice(0, 200)); return res.end('0|CheckMacValue Error'); }
  const order = one(`SELECT * FROM orders WHERE trade_no=?`, String(body.MerchantTradeNo || ''));
  if (!order) return res.end('0|Order Not Found');
  if (String(body.RtnCode) === '1' && +body.TradeAmt === order.amount) markPaid(order, JSON.stringify(body));
  else if (String(body.RtnCode) !== '1')
    run(`UPDATE orders SET status='failed', raw=? WHERE id=? AND status='pending'`, JSON.stringify(body), order.id);
  res.end('1|OK');
});
route('POST', '/api/orders/:id/simulate', async (req, res, body, user, url, params) => {
  if (IS_PROD) return json(res, 404, { error: 'Not found' }); // 僅開發模式
  if (!user) return json(res, 401, { error: '請先登入' });
  const order = one(`SELECT * FROM orders WHERE id=? AND user_id=? AND status='pending'`, +params.id || 0, user.id);
  if (!order) return json(res, 404, { error: '無此待付款訂單' });
  markPaid(order, '{"simulated":true}');
  json(res, 200, { ok: true });
});
route('GET', '/api/orders/mine', async (req, res, body, user) => {
  if (!user) return json(res, 401, { error: '請先登入' });
  json(res, 200, { orders: all(`SELECT id,trade_no,item,amount,status,created_at,paid_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 20`, user.id) });
});

// ---------- 管理後台 ----------
function requireAdmin(user, res) {
  if (user && user.role === 'admin') return true;
  json(res, 403, { error: '需要管理員權限' });
  return false;
}
route('GET', '/api/admin/stats', async (req, res, body, user) => {
  if (!requireAdmin(user, res)) return;
  const now = nowIso();
  const monthStart = taipeiDay().slice(0, 8) + '01';
  json(res, 200, {
    members: one(`SELECT count(*) c FROM users WHERE role='member'`).c,
    verified: one(`SELECT count(*) c FROM users WHERE role='member' AND email_verified=1`).c,
    paidActive: one(`SELECT count(*) c FROM users WHERE role='member' AND plan_expires_at>?`, now).c,
    newLast7d: one(`SELECT count(*) c FROM users WHERE role='member' AND created_at>?`, new Date(Date.now() - 7 * 86400e3).toISOString()).c,
    aiCallsToday: one(`SELECT coalesce(sum(n),0) c FROM usage WHERE day=?`, taipeiDay()).c,
    aiCallsMonth: one(`SELECT coalesce(sum(n),0) c FROM usage WHERE day>=?`, monthStart).c,
    revenueMonth: one(`SELECT coalesce(sum(amount),0) c FROM orders WHERE status='paid' AND paid_at>=?`, monthStart).c,
    revenueTotal: one(`SELECT coalesce(sum(amount),0) c FROM orders WHERE status='paid'`).c,
  });
});
route('GET', '/api/admin/members', async (req, res, body, user, url) => {
  if (!requireAdmin(user, res)) return;
  const kw = `%${(url.searchParams.get('q') || '').trim()}%`;
  const rows = all(`SELECT * FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY id DESC LIMIT 100`, kw, kw);
  json(res, 200, { members: rows.map(u => ({ ...publicUser(u), suspended: !!u.suspended })) });
});
route('POST', '/api/admin/members/:id/grant', async (req, res, body, user, url, params) => {
  if (!requireAdmin(user, res)) return;
  const days = Math.trunc(+body.days);
  if (!days || Math.abs(days) > 3660) return json(res, 400, { error: '天數不正確' });
  const target = one(`SELECT id FROM users WHERE id=?`, +params.id);
  if (!target) return json(res, 404, { error: '查無會員' });
  grantPlan(target.id, days);
  audit('admin.grant', user.id, `會員#${target.id} ${days}天 ${String(body.note || '').slice(0, 80)}`);
  json(res, 200, { ok: true });
});
route('POST', '/api/admin/members/:id/suspend', async (req, res, body, user, url, params) => {
  if (!requireAdmin(user, res)) return;
  const target = one(`SELECT * FROM users WHERE id=?`, +params.id);
  if (!target || target.role === 'admin') return json(res, 400, { error: '無法停權此帳號' });
  run(`UPDATE users SET suspended=? WHERE id=?`, body.suspended ? 1 : 0, target.id);
  audit(body.suspended ? 'admin.suspend' : 'admin.unsuspend', user.id, `會員#${target.id} ${String(body.reason || '').slice(0, 80)}`);
  json(res, 200, { ok: true });
});
route('GET', '/api/admin/orders', async (req, res, body, user) => {
  if (!requireAdmin(user, res)) return;
  json(res, 200, { orders: all(`SELECT o.id,o.trade_no,o.item,o.amount,o.status,o.created_at,o.paid_at,u.email
    FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 100`) });
});
// 寄信自檢：即時回報 SMTP 實際結果。回 250 不代表進收件匣，Gmail 自寄自收常被歸檔或進垃圾匣
route('POST', '/api/admin/test-mail', async (req, res, body, user) => {
  if (!requireAdmin(user, res)) return;
  try {
    const r = await mailer.send(user.email, `【系統自檢】SMTP 測試 ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`,
      '<p>這是會員站寄信功能自檢信，收到代表 SMTP 正常。</p>');
    audit('mail.test', user.id, 'SMTP 自檢成功');
    json(res, 200, { ok: true, detail: r.response || 'dev mode', smtp: mailer.hasSmtp });
  } catch (e) {
    json(res, 500, { error: 'SMTP 寄送失敗：' + e.message, smtp: mailer.hasSmtp });
  }
});
route('GET', '/api/admin/audit', async (req, res, body, user) => {
  if (!requireAdmin(user, res)) return;
  json(res, 200, { audit: all(`SELECT * FROM audit ORDER BY id DESC LIMIT 200`) });
});

// ---------- 知識庫代理 /kb ----------
// 額度用完時回 200 + Gemini 形狀的訊息：工具頁對非 2xx 只會顯示「API Error」，
// 用這個形狀，經方頁讀 error.message、紫微頁讀 candidates 文字，都能把原因原樣顯示給使用者。
function kbNotice(res, message, code) {
  json(res, 200, { error: { code, message }, candidates: [{ content: { parts: [{ text: message }] } }], notice: true });
}
// 路徑 → 允許的方法。方法要鎖死：知識庫的 GET /xuankong 是帶主密語的 app 頁，不能轉給會員。
// 六爻、玄空 app 以 location.origin 當後端，所以這些路徑在根目錄也走代理（見 server）。
const KB_ROUTES = {
  '/gemini': 'POST', '/tianji': 'GET', '/xuankong': 'POST', '/xuankong/yinzheng': 'POST',
  '/xuankong/status': 'GET', '/xuankong/result': 'GET',
};
const KB_METERED = new Set(['/gemini', '/xuankong']); // 玄空報告一份算一次
const inflight = new Map();
// 玄空報告是非同步：POST 只拿到工作編號，失敗要到查進度才知道，所以記下編號，失敗時才退得回額度。
// ponytail: 只存記憶體，網站重啟或會員中途關頁就退不回；要保證退回時改存資料庫，由伺服器自己查進度。
const xkJobs = new Map(); // 工作編號 → { user, day }
function trackXkJob(url, sub, user, day, buf) {
  let d;
  try { d = JSON.parse(buf); } catch { return buf; }
  if (sub === '/xuankong') { if (d.id) xkJobs.set(d.id, { user, day }); return buf; }
  const id = url.searchParams.get('id');
  const job = xkJobs.get(id);
  if (!job) return buf;
  if (d.error || d.done) xkJobs.delete(id);
  if (!d.error) return buf;
  refundQuota(job.user, job.day); // 知識庫重啟後回「查無此工作」也算失敗
  // 原始訊息是程式錯誤（含主機路徑），留在知識庫日誌，不給會員看
  return Buffer.from(JSON.stringify({ ...d, error: '報告沒有產生成功，本次不扣額度。請確認資料填寫完整後再試一次。' }));
}
async function kbProxy(req, res, url, user) {
  const sub = url.pathname.startsWith('/kb/') ? url.pathname.slice(3) : url.pathname;
  // 玄空 app 讀的是字串 error；其他工具讀 Gemini 形狀
  const notice = sub.startsWith('/xuankong') ? (msg, code) => json(res, code, { error: msg }) : (msg, code) => kbNotice(res, msg, code);
  if (sub === '/health') {
    if (!KB_BACKEND_URL) return json(res, 200, { ok: false, reason: 'not_configured' });
    try {
      const r = await fetch(KB_BACKEND_URL + '/health', { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      return json(res, 200, { ok: !!d.ok, model: d.model });
    } catch { return json(res, 200, { ok: false }); }
  }
  if (KB_ROUTES[sub] !== req.method) return json(res, 404, { error: { message: 'Not found' } });
  if (!user) return notice('請先登入會員才能使用 AI 知識庫。', 401);
  if (!KB_BACKEND_URL) return notice('知識庫主機尚未設定，請稍後再試。', 503);
  const tcm = url.searchParams.get('domain') === 'tcm';
  if (tcm && !user.tcm_consent_at) return notice('使用經方辨證前，請先回會員中心簽署學習用途同意書。', 403);

  // /tianji 只是查原著段落、玄空的驗盤與查進度也不用模型，都不計 AI 額度
  const metered = KB_METERED.has(sub);
  let day = null;
  if (metered) {
    if ((inflight.get(user.id) || 0) >= 2) return notice('上一個問題還在分析中，請等它完成再送出。', 429);
    day = reserveQuota(user);
    if (!day) {
      const msg = isPaid(user)
        ? `今日 AI 額度（${PAID_DAILY_AI} 次）已用完，明天（台灣時間 0 點）自動恢復。`
        : `免費會員每日可用 ${FREE_DAILY_AI} 次 AI 解讀，今日已用完。升級付費會員每日可用 ${PAID_DAILY_AI} 次：${BASE_URL}/#plans`;
      return notice(msg, 402);
    }
    inflight.set(user.id, (inflight.get(user.id) || 0) + 1);
  }
  const upstream = new URL(KB_BACKEND_URL + sub);
  for (const [k, v] of url.searchParams) if (k !== 'key') upstream.searchParams.set(k, v);
  if (KB_BACKEND_KEY) upstream.searchParams.set('key', KB_BACKEND_KEY); // 使用者看不到後端金鑰
  let ok = false;
  try {
    const body = req.method === 'POST' ? await readRaw(req, 15e6) : undefined;
    const r = await fetch(upstream, {
      method: req.method, body,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
      signal: AbortSignal.timeout(250e3),
    });
    let buf = Buffer.from(await r.arrayBuffer());
    ok = r.ok;
    if (sub === '/xuankong' || sub === '/xuankong/status') buf = trackXkJob(url, sub, user, day, buf);
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    if (e.code === 413) return notice('上傳內容過大，請縮小圖片後再試。', 413);
    console.error('知識庫轉送失敗:', e.message); // 不記錄請求內容（可能含病況描述）
    notice('知識庫主機暫時連不上，本次不扣額度，請稍後再試。', 502);
  } finally {
    if (metered) {
      inflight.set(user.id, Math.max((inflight.get(user.id) || 1) - 1, 0));
      if (!ok) refundQuota(user, day); // 上游失敗不扣額度
    }
  }
}

// ---------- 靜態檔 ----------
function sendFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ...extraHeaders });
    res.end(data);
  });
}
// 六爻、玄空的 tianji-platform 頁只是轉址頁，完整 app 在知識庫主機上（原始檔不進公開 repo）
const KB_APPS = { 'liuyao.html': '/liuyao', 'xuankong.html': '/xuankong' };
// 這兩頁的原檔寫給站長自用，轉給會員時換掉只對站長成立的字樣。知識庫原檔改字時，網站日誌會出現警告。
// app 有 token 才會送出請求，真正的金鑰由 kbProxy 換上，所以頁面裡只放占位字 member。
const KB_HOST = '本平台的知識庫主機';
const KB_APP_PATCHES = {
  '/liuyao': [
    ["var MEM_TOK = ''", "var MEM_TOK = 'member'"],
    ['<button onclick="askToken()" style="padding', '<button onclick="askToken()" style="display:none;padding'], // 「設定」只用來填密語
    ['送到你自己 Mac 上的後端(本機優先,連不上改走已發佈的隧道),由 Gemini 串成白話詳解', `送到${KB_HOST},由 Google 的 AI 模型串成白話詳解`],
    ['需通行密語(右上角「設定」,終端機 <b>cat ~/.rag_token</b> 取得)。', '需登入會員,每次詳解計入每日 AI 額度。'],
    [',連後端位址都不會去查', ''],
    ['師說原文送到你自己 Mac 上的後端,', `師說原文送到${KB_HOST},`],
    ['經由你自己 Mac 上的後端產生', `經由${KB_HOST}產生`],
    ['【需要通行密語】請按右上角「設定」填入密語,或密語已失效。', '【暫時無法使用】知識庫主機拒絕連線,請稍後再試。'],
    ['(隧道約 100 秒切線)', ''],
    ['【連不上後端】隧道或本機服務沒有回應。', '【連不上主機】知識庫主機沒有回應,請稍後再試。'],
  ],
  '/xuankong': [
    ['var STAMPED_TOKEN = "__RAG_TOKEN__"', 'var STAMPED_TOKEN = "member"'],
    ['需通行密語，不扣報告額度。', '不扣報告額度。'],
    ['完成後就在本頁顯示。需通行密語。', '完成後就在本頁顯示。每份計入每日 AI 額度,產生失敗會退回。'],
    ['<input id="tok" placeholder="通行密語"', '<input id="tok" type="hidden" placeholder="通行密語"'],
    ['分析伺服器已就緒,密語" + (tok() ? "已填,可以按「產生報告」。" : "未填,請先填入通行密語。")', '分析伺服器已就緒,可以按「產生報告」。"'],
  ],
};
async function serveKbApp(res, route) {
  if (!KB_BACKEND_URL) return json(res, 503, { error: '知識庫主機尚未設定，請稍後再試' });
  try {
    const r = await fetch(KB_BACKEND_URL + route, { signal: AbortSignal.timeout(10e3) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // 知識庫預設會把主密語種在頁首（XK_SEED_TOKEN），絕不能轉給會員；另加一道檢查防格式改變
    let html = (await r.text()).replace(/^<script>try\{\["liuyao\.token".*?<\/script>\n/s, '');
    if (KB_BACKEND_KEY && html.includes(KB_BACKEND_KEY)) throw new Error('頁面含後端金鑰，拒絕轉送');
    for (const [from, to] of KB_APP_PATCHES[route]) {
      if (!html.includes(from)) console.warn('工具頁原文已變動，請更新 KB_APP_PATCHES：', from);
      html = html.replaceAll(from, to);
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (e) {
    console.error('工具頁取得失敗:', e.message);
    json(res, 502, { error: '知識庫主機暫時連不上，請稍後再試' });
  }
}
function serveTool(req, res, url, user) {
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice('/tools/'.length)); } catch { rel = ''; }
  if (rel === '' || rel === 'index.html') return redirect(res, '/'); // 原站首頁（非營利說明）不在會員站使用
  if (rel === 'backend.json') return json(res, 200, { api: '/kb' });
  const file = path.resolve(TOOLS_DIR, rel);
  if (!file.startsWith(TOOLS_DIR + path.sep) || rel.split('/').some(s => s.startsWith('.'))) return json(res, 404, { error: 'Not found' });
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.html') {
    if (!TOOL_PAGES.has(rel)) return json(res, 404, { error: 'Not found' });
    const next = encodeURIComponent('/tools/' + rel);
    if (!user) return redirect(res, `/?login=1&next=${next}`);
    if (CONSENT_PAGES.has(rel) && !user.tcm_consent_at) return redirect(res, `/?consent=1&next=${next}`);
    if (KB_APPS[rel]) return serveKbApp(res, KB_APPS[rel]);
    return sendFile(res, file, { 'Cache-Control': 'no-store' });
  }
  if (!TOOL_STATIC_EXT.has(ext) || rel.startsWith('references/') || rel.startsWith('engine/'))
    return json(res, 404, { error: 'Not found' });
  sendFile(res, file, { 'Cache-Control': 'public, max-age=3600' });
}

// ---------- 伺服器 ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    const user = getSession(req);
    if (url.pathname.startsWith('/kb/') || url.pathname === '/health' || KB_ROUTES[url.pathname])
      return await kbProxy(req, res, url, user);
    if (url.pathname.startsWith('/tools/')) return await serveTool(req, res, url, user);
    if (url.pathname.startsWith('/api/')) {
      // 擋跨站表單偽造：除綠界回調外，POST 一律要 JSON（跨站表單送不出這個標頭）
      if (req.method === 'POST' && url.pathname !== '/api/ecpay/return'
        && !(req.headers['content-type'] || '').includes('application/json'))
        return json(res, 415, { error: '格式錯誤' });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'POST' ? await readBody(req) : {};
        return await r.handler(req, res, body, user, url, params);
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/' || url.pathname === '/index.html')
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), { 'Cache-Control': 'no-cache' });
    if (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')
      return sendFile(res, path.join(TOOLS_DIR, 'apple-touch-icon.png'));
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? '內容過大' : '伺服器錯誤' });
  }
});

if (require.main === module) {
  ensureAdmin();
  if (!fs.existsSync(path.join(TOOLS_DIR, 'jingfang.html')))
    console.warn(`⚠ 找不到工具頁（${TOOLS_DIR}）。請先執行 scripts/sync-tools.sh`);
  if (!KB_BACKEND_URL) console.warn('⚠ 未設定 KB_BACKEND_URL：排盤可用，AI 知識庫功能會提示尚未設定');
  if (IS_PROD && payment.IS_TEST_MERCHANT) console.warn('⚠ 正式環境仍使用綠界測試商店，無法真實收款');
  server.listen(PORT, () => console.log(`${SITE_NAME} 已啟動：${BASE_URL}`));
}
module.exports = { server, PLANS, KB_APP_PATCHES };
