'use strict';
// 端對端測試：用一台假的知識庫主機，跑註冊 → 工具頁門禁 → 同意書 → AI 額度 → 綠界付款 → 後台
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tjm-'));
const toolsDir = path.join(tmp, 'tools');
fs.mkdirSync(path.join(toolsDir, 'assets'), { recursive: true });
for (const f of ['jingfang.html', 'ziwei.html', 'liuyao.html', 'xuankong.html']) fs.writeFileSync(path.join(toolsDir, f), `<html>${f}</html>`);
fs.writeFileSync(path.join(toolsDir, 'assets', 'a.js'), '1');
fs.writeFileSync(path.join(toolsDir, 'secret.py'), 'x');

// 假知識庫：記錄收到的 key；fail=1 時回 500
const seen = [];
const kb = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push({ path: u.pathname, key: u.searchParams.get('key'), domain: u.searchParams.get('domain') });
  if (u.pathname === '/health') return res.end(JSON.stringify({ ok: true, model: 'fake' }));
  if (req.method === 'GET' && (u.pathname === '/liuyao' || u.pathname === '/xuankong')) { // 與真主機相同：頁首種主密語，內文是站長自用字樣
    const stale = require('../server').KB_APP_PATCHES[u.pathname].map(p => p[0]).join('\n');
    return res.end(`<script>try{["liuyao.token","xuankong.token"].forEach(function(k){localStorage.setItem(k,"server-secret")})}catch(e){}</script>\n<html>${u.pathname}</html>\n${stale}`);
  }
  if (req.method === 'POST' && u.pathname === '/xuankong') return res.end(JSON.stringify({ id: u.searchParams.get('job') || 'job1' }));
  if (u.pathname === '/xuankong/status') return res.end(JSON.stringify(u.searchParams.get('id') === 'bad' ? { done: true, error: '撰述超出篇幅上限' } : { done: true }));
  if (u.searchParams.get('fail')) { res.writeHead(500); return res.end('{}'); }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
});

let base, server;
before(async () => {
  await new Promise(r => kb.listen(0, r));
  Object.assign(process.env, {
    DATA_DIR: tmp, TOOLS_DIR: toolsDir, KB_BACKEND_URL: `http://127.0.0.1:${kb.address().port}`,
    KB_BACKEND_KEY: 'server-secret', FREE_DAILY_AI: '2', PAID_DAILY_AI: '5',
    ADMIN_EMAIL: 'admin@test.tw', ADMIN_PASSWORD: 'admin-password-123',
  });
  const mod = require('../server');
  require('../lib/db').ensureAdmin();
  server = mod.server;
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); kb.close(); });

// 帶 cookie 的簡易客戶端
function client() {
  let cookie = '';
  return async (p, { method, body, type = 'application/json', raw } = {}) => {
    const r = await fetch(base + p, {
      method: method || (body !== undefined || raw !== undefined ? 'POST' : 'GET'), redirect: 'manual',
      headers: { 'Content-Type': type, cookie },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, location: r.headers.get('location'), data };
  };
}
const gemini = (c, q = '') => c(`/kb/gemini?key=user-typed${q}`, { body: { contents: [] } });

test('未登入：工具頁導向登入、AI 回提示、backend.json 指向 /kb', async () => {
  const c = client();
  const r = await c('/tools/ziwei.html');
  assert.equal(r.status, 302);
  assert.match(r.location, /login=1/);
  assert.deepEqual((await c('/tools/backend.json')).data, { api: '/kb' });
  const g = await gemini(c);
  assert.equal(g.data.error.code, 401);
  assert.equal((await c('/kb/health')).data.ok, true);
});

test('靜態檔：只放行前端資源，擋腳本與路徑穿越', async () => {
  const c = client();
  assert.equal((await c('/tools/assets/a.js')).status, 200);
  assert.equal((await c('/tools/secret.py')).status, 404);
  assert.equal((await c('/tools/..%2Fserver.js')).status, 404);
  assert.equal((await c('/tools/index.html')).status, 302);
});

test('註冊會員：免費額度、經方同意書、金鑰替換、失敗不扣次數', async () => {
  const c = client();
  const reg = await c('/api/register', { body: { name: '小明', email: 'a@test.tw', password: 'abc12345', agreeTerms: true } });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.user.aiDailyLimit, 2);

  assert.equal((await c('/tools/ziwei.html')).status, 200);
  const jf = await c('/tools/jingfang.html');
  assert.equal(jf.status, 302);
  assert.match(jf.location, /consent=1/);
  assert.equal((await gemini(c, '&domain=tcm')).data.error.code, 403);
  assert.equal((await c('/api/me/tcm-consent', { body: { notMedical: true, seeDoctor: true } })).status, 400);
  assert.equal((await c('/api/me/tcm-consent', { body: { notMedical: true, seeDoctor: true, emergency: true } })).status, 200);
  assert.equal((await c('/tools/jingfang.html')).status, 200);

  seen.length = 0;
  const ok = await gemini(c, '&domain=tcm');
  assert.equal(ok.data.candidates[0].content.parts[0].text, 'ok');
  assert.equal(seen[0].key, 'server-secret', '使用者輸入的 key 必須被換成伺服器金鑰');
  assert.equal(seen[0].domain, 'tcm');

  assert.ok((await gemini(c, '&fail=1')).status >= 500);
  assert.equal((await c('/api/me')).data.user.aiUsedToday, 1, '上游失敗要退回額度');

  await gemini(c);
  const over = await gemini(c);
  assert.equal(over.data.error.code, 402);
  assert.match(over.data.candidates[0].content.parts[0].text, /今日已用完/);

  // 查原著段落不計額度
  assert.equal((await c('/kb/tianji?name=乾')).status, 200);
});

test('CSRF：非 JSON 的 POST 被擋', async () => {
  const c = client();
  const r = await c('/api/login', { raw: 'email=a@test.tw&password=abc12345', type: 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
});

test('綠界：驗章通過才開通，重送通知不重複加天數', async () => {
  const payment = require('../lib/payment');
  const { run, one } = require('../lib/db');
  const c = client();
  await c('/api/login', { body: { email: 'a@test.tw', password: 'abc12345' } });
  assert.equal((await c('/api/orders', { body: { plan: 'm1' } })).status, 403, '未驗證 Email 不能買');
  run(`UPDATE users SET email_verified=1 WHERE email='a@test.tw'`);
  const o = await c('/api/orders', { body: { plan: 'm1' } });
  assert.equal(o.status, 200);
  assert.match(o.data.formHtml, /CheckMacValue/);

  const cb = { MerchantID: payment.CFG.merchantId, MerchantTradeNo: o.data.tradeNo, RtnCode: '1', TradeAmt: '299' };
  const bad = await c('/api/ecpay/return', { raw: new URLSearchParams({ ...cb, CheckMacValue: 'X' }).toString(), type: 'application/x-www-form-urlencoded' });
  assert.equal(bad.data, '0|CheckMacValue Error');

  const good = new URLSearchParams({ ...cb, CheckMacValue: payment.checkMacValue(cb) }).toString();
  assert.equal((await c('/api/ecpay/return', { raw: good, type: 'application/x-www-form-urlencoded' })).data, '1|OK');
  const exp1 = one(`SELECT plan_expires_at e FROM users WHERE email='a@test.tw'`).e;
  await c('/api/ecpay/return', { raw: good, type: 'application/x-www-form-urlencoded' });
  assert.equal(one(`SELECT plan_expires_at e FROM users WHERE email='a@test.tw'`).e, exp1, '重送不得重複開通');

  const me = (await c('/api/me')).data.user;
  assert.equal(me.paid, true);
  assert.equal(me.aiDailyLimit, 5);
  assert.equal((await gemini(c)).data.candidates[0].content.parts[0].text, 'ok', '付費後額度提高可繼續用');
});

test('後台：一般會員進不去；管理員可看統計、贈送天數、停權', async () => {
  const m = client();
  await m('/api/login', { body: { email: 'a@test.tw', password: 'abc12345' } });
  assert.equal((await m('/api/admin/stats')).status, 403);
  assert.equal((await m('/api/admin/test-mail', { body: {} })).status, 403);

  const a = client();
  assert.equal((await a('/api/login', { body: { email: 'admin@test.tw', password: 'admin-password-123' } })).status, 200);
  const st = (await a('/api/admin/stats')).data;
  assert.equal(st.members, 1);
  assert.equal(st.revenueTotal, 299);
  assert.equal((await a('/api/admin/test-mail', { body: {} })).data.smtp, false, '未設定 SMTP 時走開發模式');
  const { members } = (await a('/api/admin/members?q=a@')).data;
  const id = members.find(x => x.email === 'a@test.tw').id;
  assert.equal((await a(`/api/admin/members/${id}/grant`, { body: { days: 30, note: '測試' } })).status, 200);
  assert.equal((await a(`/api/admin/members/${id}/suspend`, { body: { suspended: true, reason: '測試' } })).status, 200);
  assert.equal((await m('/api/me')).data.user, null, '停權後 session 立即失效');
});

test('玄空、六爻：app 由知識庫供檔但不外露主密語，API 走根路徑並計額度', async () => {
  const anon = client();
  assert.equal((await anon('/tools/liuyao.html')).status, 302);
  assert.equal((await anon('/gemini?domain=liuyao', { body: { contents: [] } })).data.error.code, 401);
  assert.equal((await anon('/xuankong/status?id=job1')).status, 401);
  assert.equal((await anon('/health')).data.ok, true);

  const c = client();
  await c('/api/register', { body: { name: '小華', email: 'b@test.tw', password: 'abc12345', agreeTerms: true } });
  for (const name of ['liuyao', 'xuankong']) {
    const r = await c(`/tools/${name}.html`);
    assert.equal(r.status, 200);
    assert.match(r.data, new RegExp(`<html>/${name}</html>`));
    assert.doesNotMatch(r.data, /server-secret/, '主密語不得轉給會員');
    for (const [from, to] of require('../server').KB_APP_PATCHES[`/${name}`]) {
      assert.ok(!r.data.includes(from), `會員不該看到：${from}`);
      assert.ok(r.data.includes(to), `要換成：${to}`);
    }
  }
  // 直接 GET 知識庫的 app 路徑會帶到主密語，一律不轉
  for (const p of ['/xuankong', '/kb/xuankong', '/kb/liuyao', '/liuyao']) {
    const r = await c(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(JSON.stringify(r.data), /server-secret/);
  }

  seen.length = 0;
  const g = await c('/gemini?key=member&domain=liuyao', { body: { contents: [] } });
  assert.equal(g.data.candidates[0].content.parts[0].text, 'ok');
  assert.equal(seen[0].key, 'server-secret', '占位 token 要換成伺服器金鑰');
  assert.equal((await c('/api/me')).data.user.aiUsedToday, 1);

  // 報告送出後才失敗：查進度看到錯誤要退回次數，重複查不重複退
  assert.equal((await c('/xuankong?key=member&job=bad', { body: {} })).data.id, 'bad');
  assert.equal((await c('/api/me')).data.user.aiUsedToday, 2);
  assert.match((await c('/xuankong/status?id=bad')).data.error, /本次不扣額度/);
  assert.equal((await c('/api/me')).data.user.aiUsedToday, 1, '失敗的報告要退回');
  await c('/xuankong/status?id=bad');
  assert.equal((await c('/api/me')).data.user.aiUsedToday, 1, '重複查進度不重複退');

  assert.equal((await c('/xuankong?key=member', { body: {} })).data.id, 'job1');
  assert.equal((await c('/api/me')).data.user.aiUsedToday, 2, '玄空報告也計額度');
  const over = await c('/xuankong?key=member', { body: {} });
  assert.equal(over.status, 402);
  assert.match(over.data.error, /今日已用完/, '玄空 app 讀字串 error');
  assert.equal((await c('/xuankong/status?id=job1')).status, 200);
  assert.equal((await c('/api/me')).data.user.aiUsedToday, 2, '成功的報告不退');
});
