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
const CALL_BURST_WINDOW_MS = Number(
  process.env.CALL_BURST_WINDOW_MS || 5 * 60 * 1000
);
const PORT = Number(process.env.PORT || 3001);
const TELEGRAM_ALERT_MIN_SOL = Number(process.env.TELEGRAM_ALERT_MIN_SOL || 0.001);

let ENABLE_CALL =
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
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

let isEnabled = true;
let wallets = new Set();
let subscriptions = new Map(); // wallet -> sub id
let seenSignatures = new Map(); // wallet -> Map(signature, timestamp)
let lastPinnedMessageId = null;

// burst state
let lastTxAt = {}; // wallet -> timestamp of latest tx
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

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortAddress(address, left = 4, right = 4) {
  const s = String(address || "");
  if (s.length <= left + right + 3) return s;
  return `${s.slice(0, left)}...${s.slice(-right)}`;
}

function solscanTxLink(signature) {
  return `https://solscan.io/tx/${signature}`;
}

function solscanAddressLink(address) {
  return `https://solscan.io/account/${address}`;
}

function htmlLink(url, label) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
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
  lastTxAt[wallet] = now;

  if (!prevTxAt) {
    return true;
  }

  return now - prevTxAt > CALL_BURST_WINDOW_MS;
}

function markCalled(wallet, now = Date.now()) {
  lastCallAt[wallet] = now;
}

function saveState() {
  try {
    const data = {
      isEnabled,
      enableCall: ENABLE_CALL,
      wallets: [...wallets],
      lastTxAt,
      lastCallAt,
      lastPinnedMessageId,
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

      if (typeof data.enableCall === "boolean") {
        ENABLE_CALL = data.enableCall;
      }

      wallets = new Set(
        Array.isArray(data.wallets)
          ? data.wallets.map((x) => String(x).trim()).filter(Boolean)
          : []
      );

      lastTxAt =
        data.lastTxAt && typeof data.lastTxAt === "object" ? data.lastTxAt : {};
      lastCallAt =
        data.lastCallAt && typeof data.lastCallAt === "object"
          ? data.lastCallAt
          : {};
      lastPinnedMessageId =
        typeof data.lastPinnedMessageId === "number" ? data.lastPinnedMessageId : null;
    }

    if (INITIAL_WATCH_WALLET) {
      wallets.add(INITIAL_WATCH_WALLET.trim());
    }

    saveState();
  } catch (err) {
    console.error("loadState error:", err.message);
    isEnabled = true;
    ENABLE_CALL =
      String(process.env.ENABLE_CALL || "false").toLowerCase() === "true";
    wallets = new Set(INITIAL_WATCH_WALLET ? [INITIAL_WATCH_WALLET.trim()] : []);
    lastTxAt = {};
    lastCallAt = {};
    lastPinnedMessageId = null;
    saveState();
  }
}

async function sendTelegram(text, extra = {}) {
  if (!CHAT_ID) {
    log("⚠️ Missing CHAT_ID, skip telegram");
    return null;
  }

  try {
    const msg = await bot.telegram.sendMessage(CHAT_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
    return msg;
  } catch (err) {
    console.error(
      "sendTelegram error:",
      err?.response?.description || err.message
    );
    return null;
  }
}

async function pinTelegramMessage(messageId) {
  if (!CHAT_ID || !messageId) return false;

  try {
    if (lastPinnedMessageId && lastPinnedMessageId !== messageId) {
      try {
        await bot.telegram.unpinChatMessage(CHAT_ID, lastPinnedMessageId);
      } catch (err) {
        log("unpin old message skipped:", err?.response?.description || err.message);
      }
    }

    await bot.telegram.pinChatMessage(CHAT_ID, messageId, {
      disable_notification: true,
    });

    lastPinnedMessageId = messageId;
    saveState();
    return true;
  } catch (err) {
    console.error(
      "pinTelegramMessage error:",
      err?.response?.description || err.message
    );
    return false;
  }
}

async function sendAndPinTelegram(text) {
  const sent = await sendTelegram(text);
  if (!sent?.message_id) {
    return { ok: false, sent: null, pinned: false };
  }

  const pinned = await pinTelegramMessage(sent.message_id);
  return { ok: true, sent, pinned };
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
      ? `Estimated ${Math.abs(solDelta).toFixed(6)} sol.`
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

function inferNativeSolTransfer(parsedTx, watchedWallet) {
  try {
    const tx = parsedTx?.transaction;
    const meta = parsedTx?.meta;
    if (!tx || !meta) return null;

    const instructions = tx.message.instructions || [];

    const systemTransfers = instructions.filter((ix) => {
      return (
        ix?.parsed?.type === "transfer" &&
        ix?.program === "system" &&
        ix?.parsed?.info?.source &&
        ix?.parsed?.info?.destination &&
        typeof ix?.parsed?.info?.lamports === "number"
      );
    });

    if (!systemTransfers.length) return null;

    const picked =
      systemTransfers.find((ix) => {
        const info = ix.parsed.info;
        return (
          info.source === watchedWallet || info.destination === watchedWallet
        );
      }) || systemTransfers[0];

    const info = picked.parsed.info;
    const source = info.source;
    const destination = info.destination;
    const amountSol = info.lamports / LAMPORTS_PER_SOL;

    return {
      source,
      destination,
      amountSol,
      isOutgoing: source === watchedWallet,
      isIncoming: destination === watchedWallet,
    };
  } catch {
    return null;
  }
}

function buildAlertMessage({ wallet, signature, solDelta, slot, err, parsedTx }) {
  const transfer = inferNativeSolTransfer(parsedTx, wallet);

  const title = transfer?.isIncoming
    ? "🟢 <b>SOL Received</b>"
    : transfer?.isOutgoing
    ? "🔴 <b>SOL Sent</b>"
    : "🚨 <b>Wallet Alert</b>";

  const walletShort = shortAddress(wallet);
  const walletLink = htmlLink(solscanAddressLink(wallet), walletShort);
  const signatureLink = signature
    ? htmlLink(solscanTxLink(signature), "Signature")
    : "";

  let summary = "";
  let extra = "";

  if (transfer) {
    const fromLink = htmlLink(
      solscanAddressLink(transfer.source),
      shortAddress(transfer.source)
    );
    const toLink = htmlLink(
      solscanAddressLink(transfer.destination),
      shortAddress(transfer.destination)
    );

    summary = `💸 ${fromLink} transferred <b>${transfer.amountSol.toFixed(
      4
    )} SOL</b> to ${toLink}`;

    extra = `👀 Watched wallet: ${walletLink}`;
  } else {
    const direction = inferDirection(solDelta);
    summary = `👀 ${walletLink} — ${escapeHtml(direction)}`;

    if (typeof solDelta === "number") {
      extra = `Δ <b>${solDelta.toFixed(6)} SOL</b>`;
    }
  }

  const meta = [
    signatureLink ? `🔗 ${signatureLink}` : "",
    typeof slot === "number" ? `🧱 Slot: <code>${slot}</code>` : "",
    err ? `❌ Status: <b>failed</b>` : `✅ Status: <b>confirmed</b>`,
    `🕒 ${escapeHtml(formatTimeVN())}`,
  ]
    .filter(Boolean)
    .join("\n");

  return [title, "", summary, extra, "", meta].filter(Boolean).join("\n");
}

function buildCallReasonMessage({
  wallet,
  signature,
  solDelta,
  slot,
  direction,
  parsedTx,
}) {
  const transfer = inferNativeSolTransfer(parsedTx, wallet);
  const walletLink = htmlLink(solscanAddressLink(wallet), shortAddress(wallet));
  const signatureLink = signature
    ? htmlLink(solscanTxLink(signature), "Signature")
    : "N/A";

  let why = "";
  if (transfer) {
    const fromLink = htmlLink(
      solscanAddressLink(transfer.source),
      shortAddress(transfer.source)
    );
    const toLink = htmlLink(
      solscanAddressLink(transfer.destination),
      shortAddress(transfer.destination)
    );

    why = `Detected transfer: ${fromLink} transferred <b>${transfer.amountSol.toFixed(
      4
    )} SOL</b> to ${toLink}`;
  } else if (typeof solDelta === "number") {
    why = `Detected SOL delta change on watched wallet: <b>${solDelta.toFixed(
      6
    )} SOL</b>`;
  } else {
    why = `Detected a new transaction involving watched wallet`;
  }

  return [
    "📞 <b>CALL TRIGGERED</b>",
    "",
    `🕒 Time: <b>${escapeHtml(formatTimeVN())}</b>`,
    `👛 Wallet: ${walletLink}`,
    `📈 Direction: <b>${escapeHtml(direction)}</b>`,
    typeof solDelta === "number"
      ? `💰 SOL delta: <b>${solDelta.toFixed(6)}</b>`
      : "💰 SOL delta: <b>N/A</b>",
    typeof slot === "number" ? `🧱 Slot: <code>${slot}</code>` : "",
    `🔗 ${signatureLink}`,
    "",
    `📝 Reason: ${why}`,
    `✅ Burst rule matched: first tx after cooldown window`,
    `✅ Call is allowed even for tiny delta changes`,
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldSendTelegramAlert(solDelta) {
  if (typeof solDelta !== "number") return true;
  return Math.abs(solDelta) >= TELEGRAM_ALERT_MIN_SOL;
}

function shouldTriggerCall({ isNewBurst }) {
  return ENABLE_CALL && isNewBurst;
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

    if (shouldSendTelegramAlert(solDelta)) {
      const msg = buildAlertMessage({
        wallet,
        signature,
        solDelta,
        slot,
        err,
        parsedTx,
      });
      await sendTelegram(msg);
    } else {
      log(
        `🔕 Telegram alert hidden for ${wallet} sig=${signature} because abs(solDelta) < ${TELEGRAM_ALERT_MIN_SOL}`
      );
    }

    if (shouldTriggerCall({ isNewBurst })) {
      const callResult = await makePhoneCall({
        wallet,
        direction,
        solDelta,
      });

      if (callResult.ok) {
        const callReasonText = buildCallReasonMessage({
          wallet,
          signature,
          solDelta,
          slot,
          direction,
          parsedTx,
        });

        const pinResult = await sendAndPinTelegram(callReasonText);

        if (!pinResult.pinned) {
          log(`⚠️ Call detail message sent but pin failed for ${wallet}`);
        }

        log(`📞 Burst call sent for ${wallet} sig=${signature}`);
      } else {
        const failMsg = [
          "📵 <b>CALL FAILED</b>",
          "",
          `🕒 Time: <b>${escapeHtml(formatTimeVN())}</b>`,
          `👛 Wallet: ${htmlLink(solscanAddressLink(wallet), shortAddress(wallet))}`,
          typeof solDelta === "number"
            ? `💰 SOL delta: <b>${solDelta.toFixed(6)}</b>`
            : "",
          signature
            ? `🔗 ${htmlLink(solscanTxLink(signature), "Signature")}`
            : "",
          "",
          `Reason: ${escapeHtml(callResult.reason || "unknown error")}`,
        ]
          .filter(Boolean)
          .join("\n");

        await sendTelegram(failMsg);
        log(`❌ Call failed for ${wallet} sig=${signature}: ${callResult.reason}`);
      }
    } else {
      const reason = !ENABLE_CALL ? "calls disabled" : "burst active";
      log(`⏭ Skip call for ${wallet} sig=${signature} (${reason})`);
    }

    log(`✅ Processing done for ${wallet} sig=${signature}`);
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

async function registerTelegramCommands() {
  try {
    await bot.telegram.setMyCommands([
      { command: "on", description: "Bật alert" },
      { command: "off", description: "Tắt alert" },
      { command: "callon", description: "Bật gọi điện" },
      { command: "calloff", description: "Tắt gọi điện" },
      { command: "addwallet", description: "Thêm wallet theo dõi" },
      { command: "removewallet", description: "Xóa wallet theo dõi" },
      { command: "list", description: "Xem danh sách wallet" },
      { command: "status", description: "Xem trạng thái bot" },
      { command: "testalert", description: "Gửi alert test" },
      { command: "ping", description: "Kiểm tra bot còn sống" },
    ]);
    log("✅ Telegram command menu registered");
  } catch (err) {
    console.error("setMyCommands error:", err.message);
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
      "/callon",
      "/calloff",
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
      `📞 Calls: ${ENABLE_CALL ? "ON" : "OFF"}`,
      `🔕 Telegram hide under: ${TELEGRAM_ALERT_MIN_SOL} SOL`,
      `👀 Wallet count: ${wallets.size}`,
      `🔌 Active subscriptions: ${subscriptions.size}`,
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

bot.command("calloff", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  ENABLE_CALL = false;
  saveState();

  await ctx.reply("📞 Call OFF");
});

bot.command("callon", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  ENABLE_CALL = true;
  saveState();

  await ctx.reply("📞 Call ON");
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

  await ctx.reply(`✅ Added wallet:\n<code>${escapeHtml(wallet)}</code>`, {
    parse_mode: "HTML",
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
    await ctx.reply(`🗑 Removed wallet:\n<code>${escapeHtml(wallet)}</code>`, {
      parse_mode: "HTML",
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
    `📌 Wallets đang watch:\n${list
      .map((w, i) => `${i + 1}. <code>${escapeHtml(w)}</code>`)
      .join("\n")}`,
    { parse_mode: "HTML" }
  );
});

bot.command("testalert", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const wallet =
    [...wallets][0] || INITIAL_WATCH_WALLET || "11111111111111111111111111111111";

  const msg = buildAlertMessage({
    wallet,
    signature: "5Qx1TESTabc123signatureXYZ",
    solDelta: -0.223456,
    slot: 999999999,
    err: null,
    parsedTx: null,
  });

  await sendTelegram(msg);

  if (ENABLE_CALL) {
    const callInfoMsg = buildCallReasonMessage({
      wallet,
      signature: "5Qx1TESTabc123signatureXYZ",
      solDelta: -0.223456,
      slot: 999999999,
      direction: "Outgoing transfer detected",
      parsedTx: null,
    });

    await sendAndPinTelegram(callInfoMsg);
  }

  const result = await makePhoneCall({
    wallet,
    direction: "Outgoing transfer detected",
    solDelta: -0.223456,
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
      enableCall: ENABLE_CALL,
      telegramAlertMinSol: TELEGRAM_ALERT_MIN_SOL,
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
await bot.telegram.setMyCommands([
  { command: "on", description: "Bật alert" },
  { command: "off", description: "Tắt alert" },
  { command: "callon", description: "Bật gọi điện" },
  { command: "calloff", description: "Tắt gọi điện" },
  { command: "addwallet", description: "Thêm wallet" },
  { command: "removewallet", description: "Xóa wallet" },
  { command: "list", description: "Danh sách wallet" },
  { command: "status", description: "Xem trạng thái bot" },
  { command: "testalert", description: "Test alert + call" },
  { command: "ping", description: "Check bot sống" },
]);
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
