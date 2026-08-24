const nodemailer = require('nodemailer');

function getMailerConfig() {
  const host = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  const from = String(process.env.MAIL_FROM || user).trim();
  return { host, port, secure: String(process.env.SMTP_SECURE || (port === 465)) === 'true', user, pass, from };
}

function isMailerConfigured() {
  const config = getMailerConfig();
  return Boolean(config.user && config.pass && config.from);
}

function createTransporter() {
  const config = getMailerConfig();
  if (!config.user || !config.pass) throw new Error('SMTP Gmail chưa được cấu hình.');
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

async function sendPasswordResetCode({ to, code, expiresMinutes }) {
  const config = getMailerConfig();
  const transporter = createTransporter();
  await transporter.sendMail({
    from: config.from,
    to,
    subject: 'Mã đặt lại mật khẩu PerralVPN',
    text: [
      'PerralVPN',
      '',
      `Mã đặt lại mật khẩu của bạn là: ${code}`,
      `Mã có hiệu lực trong ${expiresMinutes} phút.`,
      '',
      'Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.',
    ].join('\n'),
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px"><h2>PerralVPN</h2><p>Bạn vừa yêu cầu đặt lại mật khẩu.</p><p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#176b83">${code}</p><p>Mã có hiệu lực trong <strong>${expiresMinutes} phút</strong>.</p><p>Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.</p></div>`,
  });
}

module.exports = { isMailerConfigured, sendPasswordResetCode };
