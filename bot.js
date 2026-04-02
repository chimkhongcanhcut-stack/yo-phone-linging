require("dotenv").config();

const { Telegraf } = require("telegraf");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";

const SOLANA_RPC_HTTP =
  process.env.SOLANA_RPC_HTTP || "https://api.mainnet-beta.solana.com";
const SOLANA_RPC_WSS =
  process.env.SOLANA_RPC_WSS || "wss://api.mainnet-beta.solana.com";

const INITIAL_WATCH_WALLET = process.env.WATCH_WALLET || "";
const CALL_BURST_WINDOW_MS = Number(process.env.CALL_BURST_WINDOW_MS || 5 * 60 * 1000);
const PORT = Number(process.env.PORT || 3001);

const ENABLE_CALL =
  String(process.env.ENABLE_CALL || "false").toLowerCase() === "true";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";

const YOUR_PHONE_NUMBERS = String(
  process.env.YOUR_PHONE_NUMBERS || process.env.YOUR_PHONE_NUMBER || ""
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
  process.exit(1);
}

const DATA_FILE = path.join(__dirname, "state.json");

// ================= GLOBALS =================
const bot = new Telegraf(BOT_TOKEN);

const connection = new Connection(SOLANA_RPC_HTTP, {
  commitment: "confirmed",
  wsEndpoint: SOLANA_RPC_WSS,
});

const twilioClient =
  ENABLE_CALL && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

let isEnabled = true;
let wallets = new Set();
let subscriptions = new Map(); // wallet -> sub id
let seenSignatures = new Map(); // wallet -> Map(signature, timestamp)

// burst state
let lastTxAt = {};   // wallet -> timestamp of latest tx
let lastCallAt = {}; // wallet -> timestamp of latest call

// ================= HELPERS =================
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return true;
  return String(ctx.chat?.id || "") === String(ADMIN_CHAT_ID);
}

function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;
  ctx.reply("❌ Không có quyền.");
  return false;
}

function normalizeWallet(wallet) {
  return String(wallet || "").trim();
}

function isValidWallet(wallet) {
  try {
    new PublicKey(wallet);
    return true;
  } catch {
    return false;
  }
}

function formatTimeVN(date = new Date()) {
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
}

function truncate(text, max = 1000) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function escapeMarkdown(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function ensureSeenMap(wallet) {
  if (!seenSignatures.has(wallet)) {
    seenSignatures.set(wallet, new Map());
  }
  return seenSignatures.get(wallet);
}

function cleanupSeenMap(wallet) {
  const m = ensureSeenMap(wallet);
  const now = Date.now();

  for (const [sig, ts] of m.entries()) {
    if (now - ts > 60 * 60 * 1000) {
      m.delete(sig);
    }
  }
}

function hasSeenSignature(wallet, signature) {
  const m = ensureSeenMap(wallet);
  cleanupSeenMap(wallet);
  return m.has(signature);
}

function markSeenSignature(wallet, signature) {
  const m = ensureSeenMap(wallet);
  m.set(signature, Date.now());
}

function shouldCallForBurst(wallet, now = Date.now()) {
  const prevTxAt = Number(lastTxAt[wallet] || 0);

  // update latest tx time first
  lastTxAt[wallet] = now;

  // tx đầu tiên từng thấy
  if (!prevTxAt) {
    return true;
  }

  // nếu đã im lặng quá 5 phút => burst mới => gọi lại 1 lần
  return now - prevTxAt > CALL_BURST_WINDOW_MS;
}

function markCalled(wallet, now = Date.now()) {
  lastCallAt[wallet] = now;
}

function saveState() {
  try {
    const data = {
      isEnabled,
      wallets: [...wallets],
      lastTxAt,
      lastCallAt,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("saveState error:", err.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const data = JSON.parse(raw);

      isEnabled = typeof data.isEnabled === "boolean" ? data.isEnabled : true;
      wallets = new Set(
        Array.isArray(data.wallets)
          ? data.wallets.map((x) => String(x).trim()).filter(Boolean)
          : []
      );
      lastTxAt =
        data.lastTxAt && typeof data.lastTxAt === "object" ? data.lastTxAt : {};
      lastCallAt =
        data.lastCallAt && typeof data.lastCallAt === "object" ? data.lastCallAt : {};
    }

    if (INITIAL_WATCH_WALLET) {
      wallets.add(INITIAL_WATCH_WALLET.trim());
    }

    saveState();
  } catch (err) {
    console.error("loadState error:", err.message);
    isEnabled = true;
    wallets = new Set(INITIAL_WATCH_WALLET ? [INITIAL_WATCH_WALLET.trim()] : []);
    lastTxAt = {};
    lastCallAt = {};
    saveState();
  }
}

async function sendTelegram(text) {
  if (!CHAT_ID) {
    log("⚠️ Missing CHAT_ID, skip telegram");
    return;
  }

  try {
    await bot.telegram.sendMessage(CHAT_ID, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error(
      "sendTelegram error:",
      err?.response?.description || err.message
    );
  }
}

async function placeSingleCall(to, twiml) {
  const call = await twilioClient.calls.create({
    twiml,
    to,
    from: TWILIO_PHONE_NUMBER,
  });
  return call.sid;
}

async function makePhoneCall({ wallet, direction, solDelta }) {
  if (!ENABLE_CALL) {
    log("⚠️ ENABLE_CALL=false, skip call");
    return { ok: false, reason: "calls_disabled" };
  }

  if (!twilioClient) {
    log("⚠️ Twilio not configured, skip call");
    return { ok: false, reason: "twilio_not_configured" };
  }

  if (!TWILIO_PHONE_NUMBER) {
    log("⚠️ Missing TWILIO_PHONE_NUMBER");
    return { ok: false, reason: "missing_twilio_from_number" };
  }

  if (!YOUR_PHONE_NUMBERS.length) {
    log("⚠️ Missing YOUR_PHONE_NUMBERS");
    return { ok: false, reason: "missing_target_phone_numbers" };
  }

  const sayDelta =
    typeof solDelta === "number"
      ? `Estimated ${Math.abs(solDelta).toFixed(4)} sol.`
      : "A transaction was detected.";

  const text = `Alert. Wallet activity detected. ${direction}. ${sayDelta} Check Telegram for details.`;
  const twiml = `<Response><Say voice="alice">${text}</Say></Response>`;

  const results = [];

  for (const phone of YOUR_PHONE_NUMBERS) {
    try {
      const sid = await placeSingleCall(phone, twiml);
      log(`📞 Twilio call placed to ${phone}: ${sid}`);
      results.push({ phone, ok: true, sid });
    } catch (err) {
      console.error(`Twilio call error for ${phone}:`, err.message);
      results.push({ phone, ok: false, error: err.message });
    }
  }

  const hasSuccess = results.some((x) => x.ok);
  if (hasSuccess) {
    markCalled(wallet);
    saveState();
    return { ok: true, results };
  }

  return {
    ok: false,
    reason: results.map((x) => `${x.phone}: ${x.error || "failed"}`).join(" | "),
    results,
  };
}

async function getParsedTx(signature) {
  try {
    return await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    log("getParsedTransaction error:", err.message);
    return null;
  }
}

function inferWalletSolDelta(parsedTx, wallet) {
  try {
    const tx = parsedTx?.transaction;
    const meta = parsedTx?.meta;
    if (!tx || !meta) return null;

    const keys = tx.message.accountKeys || [];
    let idx = -1;

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const pubkey =
        typeof k?.pubkey?.toBase58 === "function"
          ? k.pubkey.toBase58()
          : typeof k?.pubkey === "string"
          ? k.pubkey
          : typeof k?.toBase58 === "function"
          ? k.toBase58()
          : String(k);

      if (pubkey === wallet) {
        idx = i;
        break;
      }
    }

    if (idx === -1) return null;

    const pre = meta.preBalances?.[idx];
    const post = meta.postBalances?.[idx];
    if (typeof pre !== "number" || typeof post !== "number") return null;

    return (post - pre) / LAMPORTS_PER_SOL;
  } catch {
    return null;
  }
}

function inferDirection(solDelta) {
  if (typeof solDelta !== "number") return "Wallet activity detected";
  if (solDelta > 0) return "Incoming transfer detected";
  if (solDelta < 0) return "Outgoing transfer detected";
  return "Wallet activity detected";
}

function buildAlertMessage({ wallet, signature, solDelta, slot, err }) {
  const direction = inferDirection(solDelta);

  return [
    "🚨 *Real-time wallet alert*",
    `*Wallet:* \`${wallet}\``,
    `*Direction:* ${escapeMarkdown(direction)}`,
    typeof solDelta === "number"
      ? `*Est\\. SOL delta:* \`${solDelta.toFixed(6)}\``
      : "",
    signature ? `*Signature:* \`${signature}\`` : "",
    typeof slot === "number" ? `*Slot:* \`${slot}\`` : "",
    err ? "*Status:* failed" : "*Status:* confirmed",
    `*Time:* ${escapeMarkdown(formatTimeVN())}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ================= SUBSCRIPTIONS =================
async function handleWalletLog(wallet, logInfo, ctxInfo = {}) {
  try {
    const signature = logInfo?.signature || "";
    const err = logInfo?.err || null;
    const slot = typeof ctxInfo.slot === "number" ? ctxInfo.slot : undefined;

    if (!signature) return;
    if (!isEnabled) return;

    if (hasSeenSignature(wallet, signature)) return;
    markSeenSignature(wallet, signature);

    const now = Date.now();
    const isNewBurst = shouldCallForBurst(wallet, now);
    saveState();

    const parsedTx = await getParsedTx(signature);
    const solDelta = inferWalletSolDelta(parsedTx, wallet);
    const direction = inferDirection(solDelta);

    const msg = buildAlertMessage({
      wallet,
      signature,
      solDelta,
      slot,
      err,
    });

    // Telegram luôn gửi
    await sendTelegram(msg);

    // Chỉ gọi 1 lần ở đầu mỗi burst
    if (isNewBurst) {
      await makePhoneCall({
        wallet,
        direction,
        solDelta,
      });
      log(`📞 Burst call sent for ${wallet} sig=${signature}`);
    } else {
      log(`⏭ Burst already active, skip call for ${wallet} sig=${signature}`);
    }

    log(`✅ Telegram alert sent for ${wallet} sig=${signature}`);
  } catch (err) {
    console.error(`handleWalletLog error for ${wallet}:`, err.message);
  }
}

async function subscribeWallet(wallet) {
  if (subscriptions.has(wallet)) return;

  try {
    const pubkey = new PublicKey(wallet);

    const subId = connection.onLogs(
      pubkey,
      async (logInfo, ctx) => {
        await handleWalletLog(wallet, logInfo, ctx);
      },
      "confirmed"
    );

    subscriptions.set(wallet, subId);
    log(`👂 Subscribed wallet ${wallet} subId=${subId}`);
  } catch (err) {
    console.error(`subscribeWallet error for ${wallet}:`, err.message);
  }
}

async function unsubscribeWallet(wallet) {
  const subId = subscriptions.get(wallet);
  if (subId == null) return;

  try {
    await connection.removeOnLogsListener(subId);
    log(`🗑 Unsubscribed wallet ${wallet} subId=${subId}`);
  } catch (err) {
    console.error(`unsubscribeWallet error for ${wallet}:`, err.message);
  } finally {
    subscriptions.delete(wallet);
    seenSignatures.delete(wallet);
  }
}

async function resubscribeAll() {
  for (const [wallet] of subscriptions.entries()) {
    await unsubscribeWallet(wallet);
  }

  for (const wallet of wallets) {
    await subscribeWallet(wallet);
  }
}

// ================= TELEGRAM COMMANDS =================
bot.start(async (ctx) => {
  if (!requireAdmin(ctx)) return;
  await ctx.reply(
    [
      "🤖 Bot real-time đang chạy",
      "",
      "/on",
      "/off",
      "/addwallet <address>",
      "/removewallet <address>",
      "/list",
      "/status",
      "/testalert",
      "/ping",
    ].join("\n")
  );
});

bot.command("ping", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  await ctx.reply(
    [
      `⚙️ Status: ${isEnabled ? "ON" : "OFF"}`,
      `👀 Wallet count: ${wallets.size}`,
      `🔌 Active subscriptions: ${subscriptions.size}`,
      `📞 Calls: ${ENABLE_CALL ? "ON" : "OFF"}`,
      `⏱ Burst window: ${Math.floor(CALL_BURST_WINDOW_MS / 1000)} giây`,
      `📱 Target phones: ${
        YOUR_PHONE_NUMBERS.length ? YOUR_PHONE_NUMBERS.join(", ") : "(missing)"
      }`,
      `💬 Alert chat: ${CHAT_ID || "(missing)"}`,
      `🌐 RPC: ${truncate(SOLANA_RPC_HTTP, 90)}`,
      `📡 WSS: ${truncate(SOLANA_RPC_WSS, 90)}`,
    ].join("\n")
  );
});

bot.command("on", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  isEnabled = true;
  saveState();
  await ctx.reply("✅ Alert ON");
});

bot.command("off", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  isEnabled = false;
  saveState();
  await ctx.reply("⛔ Alert OFF");
});

bot.command("addwallet", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const text = ctx.message?.text || "";
  const wallet = normalizeWallet(text.split(" ").slice(1).join(" "));

  if (!wallet) {
    await ctx.reply("Dùng: /addwallet <wallet>");
    return;
  }

  if (!isValidWallet(wallet)) {
    await ctx.reply("❌ Wallet không hợp lệ.");
    return;
  }

  wallets.add(wallet);
  saveState();
  await subscribeWallet(wallet);

  await ctx.reply(`✅ Added wallet:\n\`${wallet}\``, {
    parse_mode: "Markdown",
  });
});

bot.command("removewallet", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const text = ctx.message?.text || "";
  const wallet = normalizeWallet(text.split(" ").slice(1).join(" "));

  if (!wallet) {
    await ctx.reply("Dùng: /removewallet <wallet>");
    return;
  }

  const existed = wallets.delete(wallet);
  delete lastTxAt[wallet];
  delete lastCallAt[wallet];
  saveState();
  await unsubscribeWallet(wallet);

  if (existed) {
    await ctx.reply(`🗑 Removed wallet:\n\`${wallet}\``, {
      parse_mode: "Markdown",
    });
  } else {
    await ctx.reply("❌ Wallet không tồn tại.");
  }
});

bot.command("list", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const list = [...wallets];
  if (!list.length) {
    await ctx.reply("📭 Chưa có wallet nào.");
    return;
  }

  await ctx.reply(
    `📌 Wallets đang watch:\n${list.map((w, i) => `${i + 1}. \`${w}\``).join("\n")}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("testalert", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const wallet = [...wallets][0] || INITIAL_WATCH_WALLET || "test-wallet";
  const msg = buildAlertMessage({
    wallet,
    signature: "TEST_SIGNATURE_123",
    solDelta: -0.123456,
    slot: 999999999,
    err: null,
  });

  await sendTelegram(msg);

  const result = await makePhoneCall({
    wallet,
    direction: "Outgoing transfer detected",
    solDelta: -0.123456,
  });

  if (result.ok) {
    const okCalls = result.results
      .filter((x) => x.ok)
      .map((x) => `${x.phone}: ${x.sid}`)
      .join("\n");

    const failedCalls = result.results
      .filter((x) => !x.ok)
      .map((x) => `${x.phone}: ${x.error}`)
      .join("\n");

    await ctx.reply(
      [
        "🧪 Test alert sent.",
        okCalls ? `📞 Success:\n${okCalls}` : "",
        failedCalls ? `❌ Failed:\n${failedCalls}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  } else {
    await ctx.reply(`🧪 Telegram test sent.\n❌ Call failed: ${result.reason}`);
  }
});

// ================= SIMPLE HEALTH SERVER =================
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bot is running");
    return;
  }

  if (req.url === "/health") {
    const body = JSON.stringify({
      ok: true,
      enabled: isEnabled,
      walletCount: wallets.size,
      subscriptionCount: subscriptions.size,
      wallets: [...wallets],
      now: new Date().toISOString(),
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

// ================= START =================
async function start() {
  loadState();

  for (const wallet of wallets) {
    if (isValidWallet(wallet)) {
      await subscribeWallet(wallet);
    } else {
      log(`⚠️ Skip invalid wallet in state: ${wallet}`);
    }
  }

  try {
    await bot.launch();
    log("🤖 Telegram bot started");
  } catch (err) {
    console.error("❌ Telegram bot failed to start:", err.message);
  }

  server.listen(PORT, () => {
    log(`🚀 Health server listening on port ${PORT}`);
  });

  setInterval(async () => {
    try {
      log("♻️ Periodic resubscribe check...");
      await resubscribeAll();
    } catch (err) {
      console.error("Periodic resubscribe error:", err.message);
    }
  }, 10 * 60 * 1000);
}

start().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});

process.once("SIGINT", async () => {
  try {
    for (const wallet of [...subscriptions.keys()]) {
      await unsubscribeWallet(wallet);
    }
    bot.stop("SIGINT");
  } finally {
    process.exit(0);
  }
});

process.once("SIGTERM", async () => {
  try {
    for (const wallet of [...subscriptions.keys()]) {
      await unsubscribeWallet(wallet);
    }
    bot.stop("SIGTERM");
  } finally {
    process.exit(0);
  }
});
