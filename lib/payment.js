'use strict';
// 綠界 ECPay 全方位金流(AioCheckOut V5)
// 預設為綠界公開測試環境;正式上線改環境變數:
//   ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV / ECPAY_ENDPOINT
// 本站僅收「會員方案費用」(AI 知識庫運算與系統使用),不販售個別處方或診療。
const crypto = require('crypto');

const CFG = {
  merchantId: process.env.ECPAY_MERCHANT_ID || '2000132',            // 綠界公用測試商店
  hashKey: process.env.ECPAY_HASH_KEY || '5294y06JbISpM5x9',
  hashIv: process.env.ECPAY_HASH_IV || 'v77hoKGq4kWxNNIS',
  endpoint: process.env.ECPAY_ENDPOINT || 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
};
const IS_TEST_MERCHANT = !process.env.ECPAY_MERCHANT_ID;

// 綠界 CheckMacValue:參數排序 → 前後加 HashKey/HashIV → URL encode(.NET 相容)→ 小寫 → SHA256 大寫
function dotNetUrlEncode(s) {
  return encodeURIComponent(s)
    .replace(/%20/g, '+').replace(/%21/g, '!').replace(/%28/g, '(').replace(/%29/g, ')')
    .replace(/%2A/g, '*').replace(/%2D/g, '-').replace(/%2E/g, '.').replace(/%5F/g, '_');
}
function checkMacValue(params) {
  const sorted = Object.keys(params).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const raw = `HashKey=${CFG.hashKey}&` + sorted.map(k => `${k}=${params[k]}`).join('&') + `&HashIV=${CFG.hashIv}`;
  const encoded = dotNetUrlEncode(raw).toLowerCase();
  return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
}

function tradeDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 產生自動送出的付款表單(導向綠界收銀台)
function checkoutForm({ merchantTradeNo, amount, itemName, tradeDesc, returnUrl, clientBackUrl }) {
  const params = {
    MerchantID: CFG.merchantId,
    MerchantTradeNo: merchantTradeNo,
    MerchantTradeDate: tradeDate(),
    PaymentType: 'aio',
    TotalAmount: String(amount),
    TradeDesc: tradeDesc,
    ItemName: itemName,
    ReturnURL: returnUrl,
    ClientBackURL: clientBackUrl,
    ChoosePayment: 'ALL',
    EncryptType: '1',
  };
  params.CheckMacValue = checkMacValue(params);
  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>導向綠界付款…</title></head>
<body><p style="font-family:sans-serif">正在導向綠界安全付款頁面…</p>
<form id="f" method="post" action="${CFG.endpoint}">${inputs}</form>
<script>document.getElementById('f').submit()</script></body></html>`;
}

// 驗證綠界付款結果通知(ReturnURL server-to-server)
function verifyCallback(body) {
  const { CheckMacValue, ...rest } = body;
  if (!CheckMacValue) return false;
  return checkMacValue(rest) === CheckMacValue;
}

module.exports = { checkoutForm, verifyCallback, checkMacValue, CFG, IS_TEST_MERCHANT };
