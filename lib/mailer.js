'use strict';
// 寄信：設定 SMTP_URL 時真實寄送；未設定時印在伺服器日誌（開發模式）
const nodemailer = require('nodemailer');

const SITE_NAME = process.env.SITE_NAME || '經方自學會員';
const SMTP_URL = process.env.SMTP_URL;
const MAIL_FROM = process.env.MAIL_FROM || `${SITE_NAME} <noreply@localhost>`;
const transporter = SMTP_URL ? nodemailer.createTransport(SMTP_URL) : null;

async function send(to, subject, html) {
  if (!transporter) {
    console.log(`[dev-mail] To: ${to} | ${subject}\n${html.replace(/<[^>]+>/g, ' ')}`);
    return { dev: true };
  }
  try {
    return await transporter.sendMail({ from: MAIL_FROM, to, subject, html });
  } catch (e) {
    try { require('./db').audit('mail.fail', null, `${to} | ${subject.slice(0, 40)} | ${String(e.message).slice(0, 150)}`); } catch {}
    throw e;
  }
}
const sendVerifyEmail = (to, url) => send(to, `【${SITE_NAME}】請驗證您的 Email`,
  `<p>您好，感謝註冊${SITE_NAME}。</p><p>請於 48 小時內點擊以下連結完成驗證：</p><p><a href="${url}">${url}</a></p>
   <p>若您未註冊本站，請忽略此信。本站不會以任何理由要求您匯款或提供密碼。</p>`);
const sendResetEmail = (to, url) => send(to, `【${SITE_NAME}】重設密碼`,
  `<p>您申請了重設密碼，請於 1 小時內點擊以下連結（僅能使用一次）：</p><p><a href="${url}">${url}</a></p>
   <p>若非您本人操作，請忽略此信，您的密碼不會改變。</p>`);

module.exports = { send, sendVerifyEmail, sendResetEmail, hasSmtp: !!transporter, SITE_NAME };
