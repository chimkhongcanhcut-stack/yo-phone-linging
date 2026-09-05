require("dotenv").config();

const { Telegraf } = require("telegraf");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const axios = require("axios");
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
  process.env.CALL_BURST_WINDOW_MS || 5 * 60 * 1000,
);
const PORT = Number(process.env.PORT || 3001);
const TELEGRAM_ALERT_MIN_SOL = Number(
  process.env.TELEGRAM_ALERT_MIN_SOL || 0.001,
);

// USD price feed (used by /min threshold)
const SOL_PRICE_API_URL =
  process.env.SOL_PRICE_API_URL ||
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
const SOL_PRICE_CACHE_MS = Number(process.env.SOL_PRICE_CACHE_MS || 30 * 1000);

// Known SPL token mints treated as ~1 USD per token (stablecoins).
// Add more via KNOWN_TOKEN_MINTS env: "mint1:SYMBOL:usdPerToken,mint2:SYMBOL:usdPerToken"
const KNOWN_TOKENS = {
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT",
    usdPerToken: 1,
  },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: "USDC",
    usdPerToken: 1,
  },
};

if (process.env.KNOWN_TOKEN_MINTS) {
  for (const entry of process.env.KNOWN_TOKEN_MINTS.split(",")) {
    const [mint, symbol, usdPerToken] = entry.split(":").map((x) => x?.trim());
    if (mint && symbol) {
      KNOWN_TOKENS[mint] = { symbol, usdPerToken: Number(usdPerToken) || 1 };
    }
  }
}

function getTokenInfo(mint) {
  return KNOWN_TOKENS[mint] || null;
}

let ENABLE_CALL =
  String(process.env.ENABLE_CALL || "false").toLowerCase() === "true";

const BARK_URL = String(process.env.BARK_URL || "https://api.day.app")
  .trim()
  .replace(/\/+$/, "");

function getBarkApiKeys() {
  const keys = [
    process.env.BARK_API_KEY_1,
    process.env.BARK_API_KEY_2,
    ...(process.env.BARK_API_KEYS ? process.env.BARK_API_KEYS.split(",") : []),
  ];
  return Array.from(
    new Set(keys.map((k) => String(k || "").trim()).filter(Boolean)),
  );
}

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

let isEnabled = true;
let wallets = new Set();
let subscriptions = new Map(); // wallet -> sub id
let seenSignatures = new Map(); // wallet -> Map(signature, timestamp)
let lastPinnedMessageId = null;

// burst state
let lastTxAt = {}; // wallet -> timestamp of latest tx
let lastCallAt = {}; // wallet -> timestamp of latest call

// /min feature: wallet -> minimum USD tx value required to trigger a call
let walletMinUsd = {};

// SOL/USD price cache
let cachedSolPriceUsd = null;
let cachedSolPriceAt = 0;

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

function getWalletMinUsd(wallet) {
  const v = Number(walletMinUsd[wallet]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function setWalletMinUsd(wallet, amountUsd) {
  if (amountUsd > 0) {
    walletMinUsd[wallet] = amountUsd;
  } else {
    delete walletMinUsd[wallet];
  }
}

async function getSolPriceUsd() {
  const now = Date.now();

  if (cachedSolPriceUsd && now - cachedSolPriceAt < SOL_PRICE_CACHE_MS) {
    return cachedSolPriceUsd;
  }

  try {
    const res = await axios.get(SOL_PRICE_API_URL, { timeout: 5000 });
    const price = Number(res?.data?.solana?.usd);

    if (Number.isFinite(price) && price > 0) {
      cachedSolPriceUsd = price;
      cachedSolPriceAt = now;
      return price;
    }
  } catch (err) {
    log("⚠️ getSolPriceUsd error:", err.message);
  }

  // fall back to last known price (even if stale) rather than blocking calls
  return cachedSolPriceUsd;
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
      walletMinUsd,
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
          : [],
      );

      lastTxAt =
        data.lastTxAt && typeof data.lastTxAt === "object" ? data.lastTxAt : {};
      lastCallAt =
        data.lastCallAt && typeof data.lastCallAt === "object"
          ? data.lastCallAt
          : {};
      walletMinUsd =
        data.walletMinUsd && typeof data.walletMinUsd === "object"
          ? data.walletMinUsd
          : {};
      lastPinnedMessageId =
        typeof data.lastPinnedMessageId === "number"
          ? data.lastPinnedMessageId
          : null;
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
    wallets = new Set(
      INITIAL_WATCH_WALLET ? [INITIAL_WATCH_WALLET.trim()] : [],
    );
    lastTxAt = {};
    lastCallAt = {};
    walletMinUsd = {};
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
      err?.response?.description || err.message,
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
        log(
          "unpin old message skipped:",
          err?.response?.description || err.message,
        );
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
      err?.response?.description || err.message,
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

async function sendBarkNotification({
  wallet,
  direction,
  solDelta,
  activity,
  signature,
}) {
  if (!ENABLE_CALL) {
    log("⚠️ ENABLE_CALL=false, skip Bark alert");
    return { ok: false, reason: "bark_disabled" };
  }

  const barkKeys = getBarkApiKeys();
  if (!barkKeys.length) {
    log("⚠️ Missing Bark API keys (BARK_API_KEY_1, BARK_API_KEY_2)");
    return { ok: false, reason: "missing_bark_api_keys" };
  }

  const amountText =
    activity?.kind === "token"
      ? `${activity.amount.toFixed(4)} ${activity.symbol}`
      : typeof solDelta === "number"
        ? `${Math.abs(solDelta).toFixed(6)} SOL`
        : "N/A";

  const title = `🚨 SOLANA ALERT (${direction || "Activity Detected"})`;
  const bodyText = `👛 Wallet: ${shortAddress(wallet)}\n💰 Amount: ${amountText}\n🕒 Time: ${formatTimeVN()}`;
  const clickUrl = signature
    ? solscanTxLink(signature)
    : solscanAddressLink(wallet);

  const payload = {
    title,
    body: bodyText,
    group: "solana_wallet_alert",
    sound: "alarm",
    call: "1",
    level: "timeSensitive",
    url: clickUrl,
    isArchive: 1,
  };

  const results = [];

  for (const key of barkKeys) {
    try {
      const response = await axios.post(`${BARK_URL}/${key}`, payload, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        timeout: 10000,
      });

      if (response.data?.code === 200 || response.status === 200) {
        log(`🔔 Bark push sent to key ${shortAddress(key, 4, 4)} successfully`);
        results.push({ key, ok: true });
      } else {
        const msg = response.data?.message || `HTTP ${response.status}`;
        log(`❌ Bark push failed for key ${shortAddress(key, 4, 4)}: ${msg}`);
        results.push({ key, ok: false, error: msg });
      }
    } catch (err) {
      const errMsg = err?.response?.data?.message || err.message;
      console.error(
        `Bark push error for key ${shortAddress(key, 4, 4)}:`,
        errMsg,
      );
      results.push({ key, ok: false, error: errMsg });
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
    reason: results
      .map((x) => `${shortAddress(x.key, 4, 4)}: ${x.error || "failed"}`)
      .join(" | "),
    results,
  };
}

async function makePhoneCall(params) {
  return sendBarkNotification(params);
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

function inferTokenTransfers(parsedTx, watchedWallet) {
  try {
    const meta = parsedTx?.meta;
    if (!meta) return [];

    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    const preMap = new Map(pre.map((b) => [b.accountIndex, b]));
    const postMap = new Map(post.map((b) => [b.accountIndex, b]));
    const indices = new Set([...preMap.keys(), ...postMap.keys()]);

    const results = [];
    for (const idx of indices) {
      const preBal = preMap.get(idx);
      const postBal = postMap.get(idx);
      const owner = postBal?.owner || preBal?.owner;
      if (owner !== watchedWallet) continue;

      const mint = postBal?.mint || preBal?.mint;
      const preAmount = Number(preBal?.uiTokenAmount?.uiAmount ?? 0);
      const postAmount = Number(postBal?.uiTokenAmount?.uiAmount ?? 0);
      const delta = postAmount - preAmount;

      if (!delta) continue;

      results.push({
        mint,
        delta,
        isIncoming: delta > 0,
        isOutgoing: delta < 0,
      });
    }

    return results;
  } catch {
    return [];
  }
}

// Combines SPL-token transfers (e.g. USDT/USDC) and native SOL transfers into
// one normalized "activity" describing what moved for the watched wallet.
// Token transfers take priority since that's usually the real value moved
// (native SOL delta in that case is just the tiny network fee).
function buildActivity(parsedTx, watchedWallet) {
  const tokenTransfers = inferTokenTransfers(parsedTx, watchedWallet);

  if (tokenTransfers.length) {
    const primary =
      tokenTransfers.find((t) => getTokenInfo(t.mint)) || tokenTransfers[0];
    const tokenInfo = getTokenInfo(primary.mint);
    const amount = Math.abs(primary.delta);

    return {
      kind: "token",
      amount,
      symbol: tokenInfo?.symbol || `token(${shortAddress(primary.mint)})`,
      mint: primary.mint,
      isIncoming: primary.isIncoming,
      isOutgoing: primary.isOutgoing,
      usdValue: tokenInfo ? amount * tokenInfo.usdPerToken : null,
      priced: Boolean(tokenInfo),
    };
  }

  const nativeTransfer = inferNativeSolTransfer(parsedTx, watchedWallet);
  if (nativeTransfer) {
    return {
      kind: "native",
      amount: nativeTransfer.amountSol,
      symbol: "SOL",
      source: nativeTransfer.source,
      destination: nativeTransfer.destination,
      isIncoming: nativeTransfer.isIncoming,
      isOutgoing: nativeTransfer.isOutgoing,
      usdValue: null, // priced later using live SOL/USD rate
      priced: false,
    };
  }

  return null;
}

async function priceActivityUsd(activity, solDeltaFallback) {
  if (activity?.kind === "token") {
    return activity.usdValue; // stablecoin amount already ~= USD, or null if unknown token
  }

  const amountSol =
    activity?.kind === "native"
      ? activity.amount
      : typeof solDeltaFallback === "number"
        ? Math.abs(solDeltaFallback)
        : null;

  if (typeof amountSol !== "number") return null;

  const solPrice = await getSolPriceUsd();
  return typeof solPrice === "number" ? amountSol * solPrice : null;
}

function buildAlertMessage({
  wallet,
  signature,
  solDelta,
  slot,
  err,
  parsedTx,
}) {
  const activity = buildActivity(parsedTx, wallet);

  const title =
    activity?.kind === "token"
      ? activity.isIncoming
        ? `🟢 <b>${escapeHtml(activity.symbol)} Received</b>`
        : `🔴 <b>${escapeHtml(activity.symbol)} Sent</b>`
      : activity?.kind === "native"
        ? activity.isIncoming
          ? "🟢 <b>SOL Received</b>"
          : "🔴 <b>SOL Sent</b>"
        : "🚨 <b>Wallet Alert</b>";

  const walletShort = shortAddress(wallet);
  const walletLink = htmlLink(solscanAddressLink(wallet), walletShort);
  const signatureLink = signature
    ? htmlLink(solscanTxLink(signature), "Signature")
    : "";

  let summary = "";
  let extra = "";

  if (activity?.kind === "token") {
    const verb = activity.isIncoming ? "received" : "sent";
    summary = `💸 ${walletLink} ${verb} <b>${activity.amount.toFixed(
      4,
    )} ${escapeHtml(activity.symbol)}</b>`;
    extra = activity.priced
      ? `≈ <b>$${activity.usdValue.toFixed(2)}</b>`
      : `⚠️ Unknown token price (mint: <code>${escapeHtml(
          shortAddress(activity.mint, 6, 6),
        )}</code>)`;
  } else if (activity?.kind === "native") {
    const fromLink = htmlLink(
      solscanAddressLink(activity.source),
      shortAddress(activity.source),
    );
    const toLink = htmlLink(
      solscanAddressLink(activity.destination),
      shortAddress(activity.destination),
    );

    summary = `💸 ${fromLink} transferred <b>${activity.amount.toFixed(
      4,
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
  usdValue,
  minUsd,
}) {
  const activity = buildActivity(parsedTx, wallet);
  const walletLink = htmlLink(solscanAddressLink(wallet), shortAddress(wallet));
  const signatureLink = signature
    ? htmlLink(solscanTxLink(signature), "Signature")
    : "N/A";

  let why = "";
  let amountLine = "";

  if (activity?.kind === "token") {
    const verb = activity.isIncoming ? "received" : "sent";
    why = `Detected token transfer: watched wallet ${verb} <b>${activity.amount.toFixed(
      4,
    )} ${escapeHtml(activity.symbol)}</b>`;
    amountLine = `💰 Amount: <b>${activity.amount.toFixed(4)} ${escapeHtml(
      activity.symbol,
    )}</b>${activity.priced ? ` (≈ $${activity.usdValue.toFixed(2)})` : ""}`;
  } else if (activity?.kind === "native") {
    const fromLink = htmlLink(
      solscanAddressLink(activity.source),
      shortAddress(activity.source),
    );
    const toLink = htmlLink(
      solscanAddressLink(activity.destination),
      shortAddress(activity.destination),
    );

    why = `Detected transfer: ${fromLink} transferred <b>${activity.amount.toFixed(
      4,
    )} SOL</b> to ${toLink}`;
    amountLine = `💰 SOL delta: <b>${activity.amount.toFixed(6)}</b>`;
  } else if (typeof solDelta === "number") {
    why = `Detected SOL delta change on watched wallet: <b>${solDelta.toFixed(
      6,
    )} SOL</b>`;
    amountLine = `💰 SOL delta: <b>${solDelta.toFixed(6)}</b>`;
  } else {
    why = `Detected a new transaction involving watched wallet`;
    amountLine = "💰 Amount: <b>N/A</b>";
  }

  return [
    "🔔 <b>BARK ALERT TRIGGERED</b>",
    "",
    `🕒 Time: <b>${escapeHtml(formatTimeVN())}</b>`,
    `👛 Wallet: ${walletLink}`,
    `📈 Direction: <b>${escapeHtml(direction)}</b>`,
    amountLine,
    typeof slot === "number" ? `🧱 Slot: <code>${slot}</code>` : "",
    `🔗 ${signatureLink}`,
    "",
    `📝 Reason: ${why}`,
    `✅ Burst rule matched: first tx after cooldown window`,
    minUsd > 0
      ? `✅ /min threshold matched: $${(typeof usdValue === "number"
          ? usdValue
          : 0
        ).toFixed(2)} >= $${minUsd.toFixed(2)}`
      : `✅ Bark alert is allowed even for tiny delta changes (no /min set)`,
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldSendTelegramAlert(solDelta) {
  if (typeof solDelta !== "number") return true;
  return Math.abs(solDelta) >= TELEGRAM_ALERT_MIN_SOL;
}

function shouldTriggerCall({ isNewBurst, minUsd, usdValue }) {
  if (!ENABLE_CALL || !isNewBurst) return false;

  if (minUsd > 0) {
    // No price / amount available yet -> be safe and don't call blind
    if (typeof usdValue !== "number") return false;
    if (usdValue < minUsd) return false;
  }

  return true;
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

    const activity = buildActivity(parsedTx, wallet);
    const minUsd = getWalletMinUsd(wallet);
    const usdValue = await priceActivityUsd(activity, solDelta);

    const isTokenActivity = activity?.kind === "token";

    if (isTokenActivity || shouldSendTelegramAlert(solDelta)) {
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
        `🔕 Telegram alert hidden for ${wallet} sig=${signature} because abs(solDelta) < ${TELEGRAM_ALERT_MIN_SOL}`,
      );
    }

    if (shouldTriggerCall({ isNewBurst, minUsd, usdValue })) {
      const callResult = await sendBarkNotification({
        wallet,
        direction,
        solDelta,
        activity,
        signature,
      });

      if (callResult.ok) {
        const callReasonText = buildCallReasonMessage({
          wallet,
          signature,
          solDelta,
          slot,
          direction,
          parsedTx,
          usdValue,
          minUsd,
        });

        const pinResult = await sendAndPinTelegram(callReasonText);

        if (!pinResult.pinned) {
          log(`⚠️ Bark detail message sent but pin failed for ${wallet}`);
        }

        log(`🔔 Bark alert sent for ${wallet} sig=${signature}`);
      } else {
        const failMsg = [
          "📵 <b>BARK ALERT FAILED</b>",
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
        log(
          `❌ Bark alert failed for ${wallet} sig=${signature}: ${callResult.reason}`,
        );
      }
    } else {
      let reason = "burst active";
      if (!ENABLE_CALL) {
        reason = "bark notifications disabled";
      } else if (
        minUsd > 0 &&
        (typeof usdValue !== "number" || usdValue < minUsd)
      ) {
        reason =
          typeof usdValue === "number"
            ? `below /min threshold ($${usdValue.toFixed(2)} < $${minUsd.toFixed(2)})`
            : `price unavailable, /min threshold set ($${minUsd.toFixed(2)})`;
      }
      log(`⏭ Skip Bark alert for ${wallet} sig=${signature} (${reason})`);
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
      "confirmed",
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
      { command: "callon", description: "Bật Bark alert" },
      { command: "calloff", description: "Tắt Bark alert" },
      { command: "addwallet", description: "Thêm wallet theo dõi" },
      { command: "removewallet", description: "Xóa wallet theo dõi" },
      { command: "min", description: "Đặt ngưỡng USD để gửi Bark alert" },
      { command: "listmin", description: "Xem ngưỡng USD theo wallet" },
      { command: "list", description: "Xem danh sách wallet" },
      { command: "status", description: "Xem trạng thái bot" },
      { command: "testalert", description: "Gửi alert test + Bark notify" },
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
      "/min <wallet> <number>  (chỉ gửi Bark alert khi tx >= $number)",
      "/listmin",
      "/list",
      "/status",
      "/testalert",
      "/ping",
    ].join("\n"),
  );
});

bot.command("ping", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const barkKeys = getBarkApiKeys();

  await ctx.reply(
    [
      `⚙️ Status: ${isEnabled ? "ON" : "OFF"}`,
      `🔔 Bark Alert: ${ENABLE_CALL ? "ON" : "OFF"}`,
      `🔕 Telegram hide under: ${TELEGRAM_ALERT_MIN_SOL} SOL`,
      `👀 Wallet count: ${wallets.size}`,
      `💵 Wallets with /min threshold: ${
        Object.values(walletMinUsd).filter((v) => Number(v) > 0).length
      } (dùng /listmin để xem chi tiết)`,
      `🔌 Active subscriptions: ${subscriptions.size}`,
      `⏱ Burst window: ${Math.floor(CALL_BURST_WINDOW_MS / 1000)} giây`,
      `📱 Bark Keys (${barkKeys.length}): ${
        barkKeys.length
          ? barkKeys.map((k) => shortAddress(k, 4, 4)).join(", ")
          : "(missing)"
      }`,
      `💬 Alert chat: ${CHAT_ID || "(missing)"}`,
      `🌐 RPC: ${truncate(SOLANA_RPC_HTTP, 90)}`,
      `📡 WSS: ${truncate(SOLANA_RPC_WSS, 90)}`,
    ].join("\n"),
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

  await ctx.reply("🔔 Bark Alert OFF");
});

bot.command("callon", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  ENABLE_CALL = true;
  saveState();

  await ctx.reply("🔔 Bark Alert ON");
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
  delete walletMinUsd[wallet];
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

bot.command("min", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const text = ctx.message?.text || "";
  const parts = text.split(/\s+/).slice(1);
  const wallet = normalizeWallet(parts[0]);
  const amountRaw = parts[1];

  if (!wallet || amountRaw === undefined) {
    await ctx.reply(
      "Dùng: /min <wallet> <number>\nVí dụ: /min <wallet> 1000\n(Chỉ gửi Bark alert khi giá trị giao dịch >= 1000 USD)\nDùng /min <wallet> 0 để tắt ngưỡng.",
    );
    return;
  }

  if (!isValidWallet(wallet)) {
    await ctx.reply("❌ Wallet không hợp lệ.");
    return;
  }

  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    await ctx.reply("❌ Số tiền không hợp lệ. Dùng: /min <wallet> <number>");
    return;
  }

  setWalletMinUsd(wallet, amount);
  saveState();

  if (!wallets.has(wallet)) {
    await ctx.reply(
      `⚠️ Wallet chưa nằm trong danh sách theo dõi. Dùng /addwallet ${wallet} để bắt đầu theo dõi.`,
    );
  }

  if (amount > 0) {
    await ctx.reply(
      `✅ Đã đặt ngưỡng gửi Bark alert cho wallet:\n<code>${escapeHtml(
        wallet,
      )}</code>\n💵 Chỉ alert khi giao dịch >= $${amount.toFixed(2)}`,
      { parse_mode: "HTML" },
    );
  } else {
    await ctx.reply(
      `✅ Đã tắt ngưỡng USD cho wallet:\n<code>${escapeHtml(
        wallet,
      )}</code>\n🔔 Bot sẽ gửi Bark alert cho mọi giao dịch (theo rule burst) như trước.`,
      { parse_mode: "HTML" },
    );
  }
});

bot.command("listmin", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const entries = Object.entries(walletMinUsd).filter(([, v]) => Number(v) > 0);

  if (!entries.length) {
    await ctx.reply("📭 Chưa có wallet nào đặt ngưỡng /min.");
    return;
  }

  await ctx.reply(
    `💵 Ngưỡng Bark alert theo wallet:\n${entries
      .map(
        ([w, v], i) =>
          `${i + 1}. <code>${escapeHtml(w)}</code> — >= $${Number(v).toFixed(2)}`,
      )
      .join("\n")}`,
    { parse_mode: "HTML" },
  );
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
    { parse_mode: "HTML" },
  );
});

bot.command("testalert", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const wallet =
    [...wallets][0] ||
    INITIAL_WATCH_WALLET ||
    "11111111111111111111111111111111";

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

  const result = await sendBarkNotification({
    wallet,
    direction: "Outgoing transfer detected",
    solDelta: -0.223456,
    signature: "5Qx1TESTabc123signatureXYZ",
  });

  if (result.ok) {
    const okBark = result.results
      .filter((x) => x.ok)
      .map((x) => `Key ${shortAddress(x.key, 4, 4)}: Success`)
      .join("\n");

    const failedBark = result.results
      .filter((x) => !x.ok)
      .map((x) => `Key ${shortAddress(x.key, 4, 4)}: ${x.error}`)
      .join("\n");

    await ctx.reply(
      [
        "🧪 Test alert sent.",
        okBark ? `🔔 Bark Success:\n${okBark}` : "",
        failedBark ? `❌ Bark Failed:\n${failedBark}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  } else {
    await ctx.reply(
      `🧪 Telegram test sent.\n❌ Bark push failed: ${result.reason}`,
    );
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
    await registerTelegramCommands();
    log("🤖 Telegram bot started");
  } catch (err) {
    console.error("❌ Telegram bot failed to start:", err.message);
  }

  server.listen(PORT, () => {
    log(`🚀 Health server listening on port ${PORT}`);
  });

  setInterval(
    async () => {
      try {
        log("♻️ Periodic resubscribe check...");
        await resubscribeAll();
      } catch (err) {
        console.error("Periodic resubscribe error:", err.message);
      }
    },
    10 * 60 * 1000,
  );
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
