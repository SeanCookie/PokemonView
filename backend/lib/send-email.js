const net = require("net");
const tls = require("tls");

function getMailConfig(env = {}) {
  const host = String(env.SMTP_HOST || process.env.SMTP_HOST || "").trim();
  const port = Number(env.SMTP_PORT || process.env.SMTP_PORT || 587);
  const secure =
    String(env.SMTP_SECURE || process.env.SMTP_SECURE || "")
      .trim()
      .toLowerCase() === "true" || port === 465;
  const user = String(env.SMTP_USER || process.env.SMTP_USER || "").trim();
  const pass = String(env.SMTP_PASS || process.env.SMTP_PASS || "").trim();
  const from = String(env.SMTP_FROM || process.env.SMTP_FROM || "").trim() || user;
  return { host, port, secure, user, pass, from };
}

function isEmailConfigured(env = {}) {
  const cfg = getMailConfig(env);
  return Boolean(cfg.host && cfg.from);
}

function encodeHeaderValue(value) {
  return String(value || "").replace(/\r?\n/g, " ").trim();
}

function buildMimeMessage({ from, to, subject, text, html }) {
  const boundary = `----PokemonView_${Date.now()}`;
  const lines = [
    `From: ${encodeHeaderValue(from)}`,
    `To: ${encodeHeaderValue(to)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(text || ""),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(html || text || ""),
    "",
    `--${boundary}--`,
    ""
  ];
  return lines.join("\r\n");
}

function readSmtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter((line) => line.length > 0);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) {
        cleanup();
        const code = Number(last.slice(0, 3));
        const multiline = lines
          .filter((line) => line.startsWith(String(code)))
          .map((line) => line.slice(4))
          .join("\n");
        resolve({ code, message: multiline });
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function sendCommand(socket, command) {
  return new Promise((resolve, reject) => {
    const done = readSmtpResponse(socket);
    if (command) socket.write(`${command}\r\n`);
    done.then(resolve).catch(reject);
  });
}

async function sendViaSmtp({ to, subject, text, html }, env = {}) {
  const cfg = getMailConfig(env);
  if (!cfg.host || !cfg.from) {
    throw new Error("SMTP is not configured (set SMTP_HOST and SMTP_FROM in backend/.env)");
  }

  const message = buildMimeMessage({
    from: cfg.from,
    to,
    subject,
    text,
    html
  });

  let socket = await new Promise((resolve, reject) => {
    const onConnect = (sock) => resolve(sock);
    const onError = (err) => reject(err);
    if (cfg.secure) {
      const secureSocket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () =>
        onConnect(secureSocket)
      );
      secureSocket.on("error", onError);
    } else {
      const plain = net.connect({ host: cfg.host, port: cfg.port }, () => onConnect(plain));
      plain.on("error", onError);
    }
  });

  const fromAddress = (() => {
    const match = String(cfg.from).match(/<([^>]+)>/);
    if (match) return match[1].trim();
    if (cfg.from.includes("@")) return cfg.from.trim();
    return cfg.user || cfg.from;
  })();

  try {
    let resp = await sendCommand(socket);
    if (resp.code !== 220) throw new Error(resp.message || "SMTP greeting failed");

    resp = await sendCommand(socket, `EHLO PokemonView.local`);
    if (resp.code !== 250) throw new Error(resp.message || "SMTP EHLO failed");

    if (!cfg.secure && cfg.port === 587) {
      resp = await sendCommand(socket, "STARTTLS");
      if (resp.code !== 220) throw new Error(resp.message || "SMTP STARTTLS failed");
      const upgraded = await new Promise((resolve, reject) => {
        const tlsSocket = tls.connect({ socket, servername: cfg.host }, () => resolve(tlsSocket));
        tlsSocket.on("error", reject);
      });
      socket = upgraded;
      resp = await sendCommand(socket, `EHLO PokemonView.local`);
      if (resp.code !== 250) throw new Error(resp.message || "SMTP EHLO after TLS failed");
    }

    if (cfg.user && cfg.pass) {
      resp = await sendCommand(socket, "AUTH LOGIN");
      if (resp.code !== 334) throw new Error(resp.message || "SMTP AUTH failed");
      resp = await sendCommand(socket, Buffer.from(cfg.user).toString("base64"));
      if (resp.code !== 334) throw new Error(resp.message || "SMTP username rejected");
      resp = await sendCommand(socket, Buffer.from(cfg.pass).toString("base64"));
      if (resp.code !== 235) throw new Error(resp.message || "SMTP password rejected");
    }

    resp = await sendCommand(socket, `MAIL FROM:<${fromAddress}>`);
    if (resp.code !== 250) throw new Error(resp.message || "SMTP MAIL FROM failed");

    resp = await sendCommand(socket, `RCPT TO:<${to}>`);
    if (resp.code !== 250 && resp.code !== 251) throw new Error(resp.message || "SMTP RCPT TO failed");

    resp = await sendCommand(socket, "DATA");
    if (resp.code !== 354) throw new Error(resp.message || "SMTP DATA failed");

    socket.write(`${message}\r\n.\r\n`);
    resp = await readSmtpResponse(socket);
    if (resp.code !== 250) throw new Error(resp.message || "SMTP message rejected");

    await sendCommand(socket, "QUIT");
    return { ok: true };
  } finally {
    socket.end();
  }
}

async function sendPasswordResetEmail({ to, resetUrl, userName }, env = {}) {
  const subject = "Reset your PokemonView password";
  const greeting = userName ? `Hi ${userName},` : "Hi,";
  const text = `${greeting}

We received a request to reset your PokemonView password.

Open this link to choose a new password (expires in 1 hour):
${resetUrl}

If you did not request this, you can ignore this email.

— PokemonView`;

  const html = `<!doctype html>
<html>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#0a0f18;color:#e9f1ff;padding:24px;">
  <p>${greeting}</p>
  <p>We received a request to reset your PokemonView password.</p>
  <p><a href="${resetUrl}" style="color:#67b2ff;">Reset your password</a></p>
  <p style="color:#93a8c7;font-size:13px;">This link expires in 1 hour. If you did not request a reset, ignore this email.</p>
</body>
</html>`;

  if (!isEmailConfigured(env)) {
    console.log(`[mail] Password reset link for ${to}:\n${resetUrl}`);
    return { ok: false, loggedToConsole: true };
  }

  await sendViaSmtp({ to, subject, text, html }, env);
  return { ok: true };
}

async function sendPriceAlertEmail(
  { to, cardLabel, message, alertPrice, marketPrice, condition, recurrence } = {},
  env = {}
) {
  const label = String(cardLabel || "Card").trim() || "Card";
  const bodyMessage = String(message || "").trim() || `${label} price alert`;
  const alertP = Number(alertPrice);
  const marketP = Number(marketPrice);
  const alertText = Number.isFinite(alertP) ? `$${alertP.toFixed(2)}` : "—";
  const marketText = Number.isFinite(marketP) ? `$${marketP.toFixed(2)}` : "—";
  const cond = String(condition || "crossing").trim() || "crossing";
  const recur = String(recurrence || "once").trim() || "once";
  const subject = `PokemonView alert: ${label}`;
  const text = [
    bodyMessage,
    "",
    `Card: ${label}`,
    `Condition: ${cond}`,
    `Alert price: ${alertText}`,
    `Market price: ${marketText}`,
    `Trigger: ${recur}`,
    "",
    "Open Poke View to manage your alerts."
  ].join("\n");
  const html = `<!doctype html>
<html>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#0a0f18;color:#e9f1ff;padding:24px;">
  <h2 style="margin:0 0 12px;font-size:18px;">Price alert</h2>
  <p style="margin:0 0 16px;font-size:15px;">${bodyMessage.replace(/</g, "&lt;")}</p>
  <table style="border-collapse:collapse;font-size:13px;color:#c5d4ea;">
    <tr><td style="padding:4px 12px 4px 0;color:#93a8c7;">Card</td><td>${label.replace(/</g, "&lt;")}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#93a8c7;">Condition</td><td>${cond}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#93a8c7;">Alert price</td><td>${alertText}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#93a8c7;">Market price</td><td>${marketText}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#93a8c7;">Trigger</td><td>${recur}</td></tr>
  </table>
  <p style="margin:20px 0 0;color:#93a8c7;font-size:13px;">Open Poke View to manage your alerts.</p>
</body>
</html>`;

  if (!isEmailConfigured(env)) {
    console.log(`[mail] Price alert for ${to}: ${bodyMessage} (market ${marketText})`);
    return { ok: false, loggedToConsole: true };
  }

  await sendViaSmtp({ to, subject, text, html }, env);
  return { ok: true };
}

module.exports = {
  getMailConfig,
  isEmailConfigured,
  sendViaSmtp,
  sendPasswordResetEmail,
  sendPriceAlertEmail
};
