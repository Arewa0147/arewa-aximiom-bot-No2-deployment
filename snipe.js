// ================================
// 🚀 GMGN-STYLE SOLANA TRADING BOT
// ================================

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} = require("@solana/web3.js");

// ================================
// ⚙️ CONFIG
// ================================

const BOT = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true,
});

const connection = new Connection(process.env.RPC_URL, "confirmed");

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// ================================
// 👤 USER SYSTEM (SIMPLE)
// ================================

function getUser(id) {
  return {
    id,
    privateKey: process.env.PRIVATE_KEY,
    selectedToken: SOL_MINT,
    balance: 2.5,
    pnl: 35,
    maxBuy: 0.5 * 1e9, // 0.5 SOL max copy
  };
}

function loadWallet() {
  return Keypair.fromSecretKey(
    Buffer.from(process.env.PRIVATE_KEY, "base64")
  );
}

// ================================
// 🔁 JUPITER API
// ================================

async function getQuote(inputMint, outputMint, amount) {
  const res = await axios.get(
    "https://quote-api.jup.ag/v6/quote",
    {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps: 100,
      },
    }
  );

  return res.data.data[0];
}

async function getSwapTx(route, pubkey) {
  const res = await axios.post(
    "https://quote-api.jup.ag/v6/swap",
    {
      route,
      userPublicKey: pubkey,
      wrapUnwrapSOL: true,
      prioritizationFeeLamports: 50000,
    }
  );

  return res.data.swapTransaction;
}

// ================================
// ⚡ TRADE ENGINE
// ================================

async function executeTrade(user, inputMint, outputMint, amount) {
  try {
    const wallet = loadWallet();

    const quote = await getQuote(inputMint, outputMint, amount);
    if (!quote) throw new Error("No route found");

    const swapTx = await getSwapTx(
      quote,
      wallet.publicKey.toString()
    );

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapTx, "base64")
    );

    tx.sign([wallet]);

    const sig = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 2,
    });

    console.log("TX:", sig);

    return { success: true, txid: sig };
  } catch (err) {
    console.error("Trade error:", err.message);
    return { success: false };
  }
}

// ================================
// 🔍 SWAP DECODER (COPY ENGINE)
// ================================

function decodeSwap(tx) {
  try {
    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    let inputMint, outputMint, amount;

    for (let i = 0; i < post.length; i++) {
      const before = Number(
        pre[i]?.uiTokenAmount?.amount || 0
      );
      const after = Number(
        post[i]?.uiTokenAmount?.amount || 0
      );

      const diff = after - before;

      if (diff > 0) {
        outputMint = post[i].mint;
        amount = diff;
      }

      if (diff < 0) {
        inputMint = post[i].mint;
      }
    }

    if (!inputMint || !outputMint) return null;

    return {
      inputMint,
      outputMint,
      amount: Math.abs(amount),
    };
  } catch {
    return null;
  }
}

// ================================
// 📡 COPY TRADING ENGINE
// ================================

const listeners = new Map();

function startCopy(user, walletAddress) {
  if (listeners.has(user.id)) return;

  console.log("📡 Copy trading started");

  const subId = connection.onLogs(
    new PublicKey(walletAddress),
    async (log) => {
      try {
        const tx = await connection.getTransaction(log.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) return;

        const trade = decodeSwap(tx);
        if (!trade) return;

        // copy only buys (SOL → token)
        if (trade.inputMint !== SOL_MINT) return;

        const amount = Math.min(trade.amount, user.maxBuy);

        console.log("🔥 Copying:", trade);

        await executeTrade(
          user,
          trade.inputMint,
          trade.outputMint,
          amount
        );
      } catch (err) {
        console.log("Copy error:", err.message);
      }
    },
    "confirmed"
  );

  listeners.set(user.id, subId);
}

function stopCopy(user) {
  const subId = listeners.get(user.id);
  if (subId) connection.removeOnLogsListener(subId);

  listeners.delete(user.id);
}

// ================================
// 🧭 UI
// ================================

function mainMenu(user) {
  return {
    text: `
🚀 GMGN BOT

💼 ${user.balance} SOL
📊 PnL: ${user.pnl}%

Choose:
`,
    keyboard: {
      inline_keyboard: [
        [
          { text: "📈 Buy 0.5 SOL", callback_data: "buy" },
          { text: "📡 Start Copy", callback_data: "copy" },
        ],
        [
          { text: "🛑 Stop Copy", callback_data: "stop" },
        ],
      ],
    },
  };
}

// ================================
// 🤖 TELEGRAM HANDLERS
// ================================

BOT.onText(/\/start/, (msg) => {
  const user = getUser(msg.chat.id);

  const ui = mainMenu(user);

  BOT.sendMessage(msg.chat.id, ui.text, {
    reply_markup: ui.keyboard,
  });
});

BOT.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const user = getUser(chatId);

  // BUY
  if (q.data === "buy") {
    BOT.editMessageText("⏳ Executing trade...", {
      chat_id: chatId,
      message_id: q.message.message_id,
    });

    const res = await executeTrade(
      user,
      SOL_MINT,
      user.selectedToken,
      0.5 * 1e9
    );

    BOT.editMessageText(
      res.success
        ? `✅ https://solscan.io/tx/${res.txid}`
        : "❌ Trade failed",
      {
        chat_id: chatId,
        message_id: q.message.message_id,
      }
    );
  }

  // START COPY
  if (q.data === "copy") {
    const targetWallet = "PASTE_TARGET_WALLET_HERE";

    startCopy(user, targetWallet);

    BOT.editMessageText("📡 Copy Trading ON", {
      chat_id: chatId,
      message_id: q.message.message_id,
    });
  }

  // STOP COPY
  if (q.data === "stop") {
    stopCopy(user);

    BOT.editMessageText("🛑 Copy Trading Stopped", {
      chat_id: chatId,
      message_id: q.message.message_id,
    });
  }
});