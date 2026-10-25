const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 4000;

// Resolve Chrome / Chromium executable path across Windows and Linux
function getChromeExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Chrome/Chromium executable not found on host');
}

// In-memory active login sessions (sessionId => { browser, page, mobile, type, createdAt })
const activeSessions = new Map();

// In-memory persistent authenticated merchant Chrome sessions (mid => { browser, page, mid, upiId, sessionToken, xsrfToken, lastActivity })
const liveMerchants = new Map();

// Periodic heartbeat every 40s to keep Chrome sessions active and prevent "Dashboard Locked"
setInterval(async () => {
  for (const [mid, data] of liveMerchants.entries()) {
    try {
      if (!data.page || data.page.isClosed()) {
        liveMerchants.delete(mid);
        continue;
      }
      const hb = await data.page.evaluate(async () => {
        try {
          const r = await fetch('https://dashboard.paytm.com/api/v1/context', { credentials: 'include' });
          return r.ok;
        } catch (_) { return false; }
      });
      console.log(`[Heartbeat] Kept alive merchant ${mid}: ${hb ? 'OK' : 'FAIL'}`);
    } catch (err) {
      console.warn(`[Heartbeat] Error for ${mid}:`, err.message);
    }
  }
}, 40 * 1000);

// Periodic cleanup of stale sessions older than 5 minutes
setInterval(async () => {
  const now = Date.now();
  for (const [id, sess] of activeSessions.entries()) {
    if (now - sess.createdAt > 5 * 60 * 1000) {
      try {
        if (sess.browser) await sess.browser.close();
      } catch (e) {}
      activeSessions.delete(id);
      console.log(`[CleanUp] Expired session purged: ${id}`);
    }
  }
}, 30 * 1000);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeSessionsCount: activeSessions.size,
    liveMerchantsCount: liveMerchants.size,
    activeMids: Array.from(liveMerchants.keys())
  });
});

/**
 * GET /api/paytm/passbook?mid=...
 * Returns real transactions executed from within the live, authenticated Chrome session (100% Akamai bypass!)
 */
function parseCookieString(str, domain = '.dashboard.paytm.com') {
  if (!str) return [];
  const list = [];
  str.split(';').forEach(p => {
    const eqIdx = p.indexOf('=');
    if (eqIdx > 0) {
      const name = p.substring(0, eqIdx).trim();
      const value = p.substring(eqIdx + 1).trim();
      if (name && value) {
        list.push({ name, value, domain, path: '/' });
      }
    }
  });
  return list;
}

app.all('/api/paytm/passbook', async (req, res) => {
  const mid = req.query.mid || (req.body && req.body.mid) || '';
  const passedToken = req.query.token || (req.body && (req.body.sessionToken || req.body.token)) || '';
  const passedCookie = req.query.cookie || (req.body && req.body.cookie) || '';

  let merchant = mid ? liveMerchants.get(mid) : null;

  if (!merchant || !merchant.page || merchant.page.isClosed()) {
    let cookiesToSet = [];

    // 1. Direct cookies passed from database
    if (passedCookie) {
      cookiesToSet = parseCookieString(passedCookie);
    } else if (passedToken) {
      cookiesToSet = [
        { name: 'SESSION', value: passedToken, domain: '.dashboard.paytm.com', path: '/' },
        { name: 'UMP_SESSION', value: passedToken, domain: '.dashboard.paytm.com', path: '/' }
      ];
    }

    // 2. Saved cookie files on disk as fallback
    if (cookiesToSet.length === 0) {
      const specificFile = mid ? path.join(__dirname, `saved_cookies_${mid}.json`) : null;
      const cookiesFile = (specificFile && fs.existsSync(specificFile)) ? specificFile : path.join(__dirname, 'saved_cookies.json');
      if (fs.existsSync(cookiesFile)) {
        try {
          cookiesToSet = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
        } catch (_) {}
      }
    }

    if (cookiesToSet.length > 0) {
      try {
        console.log(`[Passbook] Re-hydrating live Chrome session for MID: ${mid || 'unknown'}...`);
        const chromePath = getChromeExecutablePath();
        const b = await puppeteer.launch({
          executablePath: chromePath,
          headless: "new",
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,800'
          ]
        });
        const p = await b.newPage();
        await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await p.setCookie(...cookiesToSet);
        await p.goto('https://dashboard.paytm.com/next/transactions', { waitUntil: 'networkidle2', timeout: 30000 });
        const allC = await p.cookies();
        const xsrfCookie = allC.find(c => c.name === 'XSRF-TOKEN');
        merchant = {
          browser: b,
          page: p,
          mid: mid || '',
          upiId: req.query.upi || (req.body && req.body.upi) || '',
          xsrfToken: xsrfCookie ? xsrfCookie.value : '',
          lastActivity: Date.now()
        };
        if (mid) {
          liveMerchants.set(mid, merchant);
          try {
            fs.writeFileSync(path.join(__dirname, `saved_cookies_${mid}.json`), JSON.stringify(allC, null, 2));
          } catch (_) {}
        }
        console.log(`[Passbook] Re-hydrated live Chrome session successfully for ${mid}!`);
      } catch (rehydErr) {
        console.error(`[Passbook] Re-hydration failed for ${mid}:`, rehydErr);
      }
    }
  }

  if (!merchant || !merchant.page || merchant.page.isClosed()) {
    return res.status(404).json({
      status: false,
      message: `No active Chrome session for MID: ${mid}. Please re-scan QR or login.`,
      liveMerchantsCount: liveMerchants.size
    });
  }

  try {
    const ordersData = await merchant.page.evaluate(async (mId, passedXsrf) => {
      // Calculate today in IST (UTC+5:30)
      const now = new Date();
      const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const today = istDate.toISOString().split('T')[0];
      // Start from today 00:00:00 IST so TODAY's orders are returned on page 1
      const start = today;

      // Extract XSRF token from document cookie or passed token
      const cookieXsrf = (document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '';
      const xsrf = passedXsrf || cookieXsrf;
      
      const postHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*'
      };
      if (xsrf) {
        postHeaders['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
      }

      const getHeaders = {
        'Accept': 'application/json, text/plain, */*'
      };
      if (xsrf) {
        getHeaders['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
      }

      // 1. Primary: Order List v3 with pagination support for today
      try {
        const resp1 = await fetch('https://dashboard.paytm.com/api/v3/order/list', {
          method: 'POST',
          headers: postHeaders,
          credentials: 'include',
          body: JSON.stringify({
            bizTypeList: ["ACQUIRING"],
            pageNum: 1,
            pageSize: 50,
            orderCreatedStartTime: `${start}T00:00:00+05:30`,
            orderCreatedEndTime: `${today}T23:59:59+05:30`
          })
        });

        if (resp1.ok) {
          const json1 = await resp1.json();
          if (json1 && json1.resultInfo && json1.resultInfo.resultStatus === 'S') {
            let allOrders = json1.orderList || [];
            // If page 1 reached max 50, fetch page 2 to ensure we don't miss any recent order
            if (allOrders.length === 50) {
              try {
                const resp2 = await fetch('https://dashboard.paytm.com/api/v3/order/list', {
                  method: 'POST',
                  headers: postHeaders,
                  credentials: 'include',
                  body: JSON.stringify({
                    bizTypeList: ["ACQUIRING"],
                    pageNum: 2,
                    pageSize: 50,
                    orderCreatedStartTime: `${start}T00:00:00+05:30`,
                    orderCreatedEndTime: `${today}T23:59:59+05:30`
                  })
                });
                if (resp2.ok) {
                  const json2 = await resp2.json();
                  if (json2 && json2.orderList && json2.orderList.length > 0) {
                    allOrders = allOrders.concat(json2.orderList);
                  }
                }
              } catch (_) {}
            }
            return { success: true, matchedUrl: 'https://dashboard.paytm.com/api/v3/order/list', ...json1, orderList: allOrders };
          }
        }
      } catch (err) {}

      const candidates = [
        // 2. Settlements Orders with XSRF
        {
          url: `https://dashboard.paytm.com/bpay/api/v1/settlements/orders?startDate=${start}&endDate=${today}&pageNum=1&pageSize=50`,
          options: { headers: getHeaders, credentials: 'include' }
        },
        // 3. User Context check (GET)
        {
          url: 'https://dashboard.paytm.com/api/v1/context',
          options: { headers: getHeaders, credentials: 'include' }
        }
      ];

      const probeLog = {};
      for (let i = 0; i < candidates.length; i++) {
        try {
          const resp = await fetch(candidates[i].url, candidates[i].options);
          if (resp.ok) {
            const json = await resp.json();
            if (json.resultInfo && json.resultInfo.resultStatus === 'F') {
              probeLog[candidates[i].url] = json.resultInfo.resultMsg || json.resultInfo.resultCode;
              continue;
            }
            return { success: true, matchedUrl: candidates[i].url, ...json };
          }
          probeLog[candidates[i].url] = resp.status;
        } catch (e) {
          probeLog[candidates[i].url] = e.message;
        }
      }
      return { success: false, probeLog, xsrfFound: Boolean(xsrf) };
    }, mid, merchant.xsrfToken);

    return res.json({
      status: true,
      mid: mid,
      data: ordersData,
      nextDataPreview: await merchant.page.evaluate(async (xsrf) => {
        try {
          const headers = { 'Accept': 'application/json' };
          if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
          const qrResp = await fetch('https://dashboard.paytm.com/api/v1/qrcode/wallet/product/?type=all&pageNo=1&pageSize=5', {
            headers,
            credentials: 'include'
          });
          const qrJson = qrResp.ok ? await qrResp.json() : null;

          return {
            url: window.location.href,
            title: document.title,
            qrProducts: qrJson,
            bodySample: document.body.innerText.substring(0, 1500),
            tables: Array.from(document.querySelectorAll('table, [class*="table"], [class*="row"], [class*="list"]')).map(el => el.innerText).filter(t => t && t.includes('₹')).slice(0, 5)
          };
        } catch (e) {
          return { err: e.message };
        }
      }, merchant.xsrfToken)
    });
  } catch (err) {
    console.error(`[Passbook] Query error for ${mid}:`, err);
    return res.status(500).json({ status: false, message: err.message });
  }
});

app.get('/api/paytm/merchant-info', async (req, res) => {
  const mid = req.query.mid;
  let merchant = liveMerchants.get(mid);
  if (!merchant && liveMerchants.size === 1) {
    merchant = liveMerchants.values().next().value;
  }
  if (!merchant || !merchant.page || merchant.page.isClosed()) {
    return res.status(404).json({ status: false, message: 'No live merchant session found' });
  }

  try {
    const v4Data = await merchant.page.evaluate(async (xsrf) => {
      const headers = { 'Accept': 'application/json, text/plain, */*' };
      if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
      try {
        const r = await fetch('https://dashboard.paytm.com/api/v4/qrcode/fetch/?pageNo=1&pageSize=10', {
          headers,
          credentials: 'include'
        });
        return { status: r.status, ok: r.ok, json: r.ok ? await r.json() : await r.text() };
      } catch (e) {
        return { err: e.message };
      }
    }, merchant.xsrfToken);

    return res.json({ status: true, mid: merchant.mid, v4Data });
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
});

app.post('/api/paytm/set-upi', (req, res) => {
  const { mid, upiId } = req.body;
  const m = liveMerchants.get(mid) || (liveMerchants.size === 1 ? liveMerchants.values().next().value : null);
  if (m) {
    m.upiId = upiId;
    return res.json({ status: true, message: 'UPI ID updated in live worker', mid: m.mid, upiId: m.upiId });
  }
  return res.status(404).json({ status: false, message: 'Merchant not found' });
});

// Helper to extract merchant MID & UPI details
async function fetchMerchantQrDetails(page, sessionToken, xsrfToken, captured = {}) {
  let mid = captured.mid || '';
  let merchantName = captured.merchantName || '';
  let upiId = captured.upiId || '';
  let mobile = captured.mobile || '';

  try {
    // 1. Fetch user context with X-XSRF-TOKEN and credentials
    const contextRes = await page.evaluate(async (token, xsrf) => {
      try {
        const headers = { 'Accept': 'application/json' };
        if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
        const resp = await fetch('https://dashboard.paytm.com/api/v1/context', {
          headers: headers,
          credentials: 'include'
        });
        if (resp.ok) return await resp.json();
      } catch (e) {}
      return null;
    }, sessionToken, xsrfToken);

    if (contextRes) {
      const firstM = (contextRes.merchants && contextRes.merchants[0]) || {};
      merchantName = contextRes.name || contextRes.displayName || firstM.name || '';
      mobile = contextRes.mobile || contextRes.phone || firstM.mobile || '';
      mid = contextRes.mid || contextRes.merchantId || contextRes.mappingId || firstM.mid || '';
    }

    // 2. Fetch QR details for MID and UPI ID with v4 QR API (100% Dynamic!)
    const qrRes = await page.evaluate(async (token, xsrf) => {
      const headers = { 'Accept': 'application/json, text/plain, */*' };
      if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
      
      const qrEndpoints = [
        'https://dashboard.paytm.com/api/v4/qrcode/fetch/?pageNo=1&pageSize=10',
        'https://dashboard.paytm.com/api/v1/qrcode/wallet/product/?type=all&pageNo=1&pageSize=5'
      ];
      for (const qUrl of qrEndpoints) {
        try {
          const resp = await fetch(qUrl, { headers, credentials: 'include' });
          if (resp.ok) {
            const j = await resp.json();
            if (j && j.response && j.response.length > 0) return j;
          }
        } catch (_) {}
      }
      return null;
    }, sessionToken, xsrfToken);

    if (qrRes && qrRes.response && qrRes.response.length > 0) {
      const first = qrRes.response[0];
      if (first.mappingId && !mid) mid = first.mappingId;
      if (first.displayName && !merchantName) merchantName = first.displayName;
      if ((first.secondaryPhoneNumber || first.mobileNo) && !mobile) mobile = first.secondaryPhoneNumber || first.mobileNo;
      if (first.vpa) {
        upiId = first.vpa;
      } else if (first.deeplink || first.deepLink) {
        const dLink = first.deeplink || first.deepLink;
        const match = dLink.match(/pa=([^&]+)/);
        if (match && match[1]) {
          upiId = decodeURIComponent(match[1]);
        }
      }
    }

    // 2b. Direct HTTP probe using sessionToken as high-reliability primary/fallback (100% Dynamic!)
    if (sessionToken && (!mid || !upiId || !merchantName)) {
      try {
        const qRes = await fetch('https://dashboard.paytm.com/api/v4/qrcode/fetch/?pageNo=1&pageSize=10', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Cookie': `SESSION=${sessionToken}; UMP_SESSION=${sessionToken}`
          }
        });
        if (qRes.ok) {
          const qData = await qRes.json();
          if (qData && qData.response && qData.response[0]) {
            const first = qData.response[0];
            if (first.mappingId && !mid) mid = first.mappingId;
            if (first.displayName && !merchantName) merchantName = first.displayName;
            if (first.vpa && !upiId) upiId = first.vpa;
            if (!upiId && (first.deeplink || first.deepLink)) {
              const m = (first.deeplink || first.deepLink).match(/pa=([^&]+)/);
              if (m && m[1]) upiId = decodeURIComponent(m[1]);
            }
          }
        }
      } catch (_) {}

      try {
        const cRes = await fetch('https://dashboard.paytm.com/api/v1/context', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Cookie': `SESSION=${sessionToken}; UMP_SESSION=${sessionToken}`
          }
        });
        if (cRes.ok) {
          const cData = await cRes.json();
          const firstM = (cData.merchants && cData.merchants[0]) || {};
          if (!merchantName) merchantName = cData.name || cData.displayName || firstM.name || '';
          if (!mobile) mobile = cData.mobile || cData.phone || firstM.mobile || '';
          if (!mid) mid = cData.mid || cData.merchantId || cData.mappingId || firstM.mid || '';
        }
      } catch (_) {}
    }

    // 3. Fallback: Extract from Next.js / React page store or localStorage if API was slow
    if (!mid || !upiId || !merchantName) {
      const pageData = await page.evaluate(() => {
        let extractedMid = '';
        let extractedName = '';
        let extractedUpi = '';
        let extractedMob = '';

        try {
          // Check Next.js state
          const nextEl = document.getElementById('__NEXT_DATA__');
          if (nextEl) {
            const nextJson = JSON.parse(nextEl.innerText || '{}');
            const props = nextJson.props || {};
            const pageProps = props.pageProps || {};
            if (pageProps.mid || pageProps.merchantId) extractedMid = pageProps.mid || pageProps.merchantId;
            if (pageProps.name || pageProps.merchantName) extractedName = pageProps.name || pageProps.merchantName;
          }
        } catch (_) {}

        try {
          // Check localStorage
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const val = localStorage.getItem(k);
            if (val && val.includes('merchantId')) {
              const parsed = JSON.parse(val);
              if (parsed.merchantId && !extractedMid) extractedMid = parsed.merchantId;
              if (parsed.name && !extractedName) extractedName = parsed.name;
              if (parsed.mobile && !extractedMob) extractedMob = parsed.mobile;
            }
          }
        } catch (_) {}

        try {
          // DOM text scanning for UPI and MID
          const bodyText = document.body ? document.body.innerText : '';
          const upiMatch = bodyText.match(/([a-zA-Z0-9.\-_]{3,}@(paytm|ptys|pty|okhdfcbank|okaxis|oksbi|icici))/i);
          if (upiMatch && upiMatch[1]) extractedUpi = upiMatch[1];
          const midMatch = bodyText.match(/\b([A-Za-z0-9]{20})\b/);
          if (midMatch && midMatch[1] && !extractedMid) extractedMid = midMatch[1];
        } catch (_) {}

        return { extractedMid, extractedName, extractedUpi, extractedMob };
      });

      if (!mid && pageData.extractedMid) mid = pageData.extractedMid;
      if (!merchantName && pageData.extractedName) merchantName = pageData.extractedName;
      if (!upiId && pageData.extractedUpi) upiId = pageData.extractedUpi;
      if (!mobile && pageData.extractedMob) mobile = pageData.extractedMob;
    }
  } catch (err) {
    console.warn('[PaytmAuth] QR fetch details error:', err.message);
  }
  return { mid, merchantName, upiId, mobile };
}

// =========================================================================
// METHOD A: 1-CLICK PAYTM APP QR CODE SCAN LOGIN (ZERO PASSWORD, ZERO OTP)
// =========================================================================

/**
 * POST /api/paytm/qr-initiate
 */
app.post('/api/paytm/qr-initiate', async (req, res) => {
  console.log('[PaytmAuth] Initiating QR Code scan session...');
  // Clean up any stale unauthenticated login attempts
  for (const [id, sess] of activeSessions.entries()) {
    if (Date.now() - (sess.createdAt || 0) > 300000) {
      try { if (sess.browser) await sess.browser.close(); } catch (_) {}
      activeSessions.delete(id);
    }
  }

  let browser;
  try {
    const chromePath = getChromeExecutablePath();
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const capturedDetails = { mid: '', upiId: '', merchantName: '', mobile: '' };
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (res.status() === 200 && (url.includes('qrcode') || url.includes('merchant') || url.includes('profile') || url.includes('context') || url.includes('wallet') || url.includes('qr'))) {
          const text = await res.text();
          const paMatch = text.match(/pa=([^&"'\s\\]+)/i);
          if (paMatch && paMatch[1]) capturedDetails.upiId = decodeURIComponent(paMatch[1]);
          const vpaMatch = text.match(/"(?:upiId|vpa|merchantVpa|virtualAddress)":\s*"([^"]+)"/i);
          if (vpaMatch && vpaMatch[1]) capturedDetails.upiId = vpaMatch[1];
          const upiGeneric = text.match(/([a-zA-Z0-9.\-_]{3,}@(paytm|ptys|pty|okhdfcbank|okaxis|oksbi|icici))/i);
          if (upiGeneric && upiGeneric[1] && !capturedDetails.upiId) {
            // Do not treat personal phone-number VPAs (e.g. 9876543210@ptyes) as business VPA
            if (!/^[6-9][0-9]{9}@/.test(upiGeneric[1])) {
              capturedDetails.upiId = upiGeneric[1];
            }
          }
          const midMatch = text.match(/"(?:merchantId|mappingId|mid)":\s*"([A-Za-z0-9]{15,25})"/i);
          if (midMatch && midMatch[1] && !capturedDetails.mid) capturedDetails.mid = midMatch[1];
          const nameMatch = text.match(/"(?:displayName|merchantName|name)":\s*"([^"]+)"/i);
          if (nameMatch && nameMatch[1] && !capturedDetails.merchantName) capturedDetails.merchantName = nameMatch[1];
          const mobMatch = text.match(/"(?:mobileNo|phoneNumber|phone|mobile)":\s*"([6-9][0-9]{9})"/i);
          if (mobMatch && mobMatch[1] && !capturedDetails.mobile) capturedDetails.mobile = mobMatch[1];
        }
      } catch (_) {}
    });

    await page.goto('https://dashboard.paytm.com/login/', { waitUntil: 'networkidle2', timeout: 35000 });

    let oauthFrame = null;
    for (let attempts = 0; attempts < 15; attempts++) {
      oauthFrame = page.frames().find(f => f.url().includes('oauth-js-sdk'));
      if (oauthFrame) break;
      await new Promise(r => setTimeout(r, 600));
    }

    if (!oauthFrame) {
      await browser.close();
      return res.status(500).json({ status: false, message: 'Failed to load Paytm login. Please try again.' });
    }

    // 1. Robust wait and click for "click here" (Login through QR Code)
    let clickedQr = false;
    for (let attempts = 0; attempts < 30; attempts++) {
      try {
        clickedQr = await oauthFrame.evaluate(() => {
          const els = Array.from(document.querySelectorAll('*'));
          const clickEl = els.find(e => {
            const txt = (e.innerText || '').trim().toLowerCase();
            return txt === 'click here' || txt.includes('login through qr');
          });
          if (clickEl) {
            clickEl.click();
            return true;
          }
          return false;
        });
      } catch (_) {}
      if (clickedQr) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!clickedQr) {
      console.warn('[PaytmAuth] "click here" not found in iframe, checking if QR already shown');
    }

    // 2. Wait for Paytm to finish generating the real dynamic QR code (canvas or image)
    let qrReady = false;
    for (let attempts = 0; attempts < 35; attempts++) {
      await new Promise(r => setTimeout(r, 600));
      try {
        const readyCheck = await oauthFrame.evaluate(() => {
          const gif = document.querySelector('img[src*=".gif"]');
          const canvas = document.querySelector('canvas');
          if (!gif && canvas) {
            try {
              if (canvas.toDataURL().length > 3000) return true;
            } catch (_) {}
          }
          const qrImg = document.querySelector('.qrContainer img, .qrCont img, img[alt*="QR"], img[src*="data:image"]');
          if (qrImg && qrImg.src && qrImg.src.length > 500) return true;
          return false;
        });
        if (readyCheck) {
          qrReady = true;
          break;
        }
      } catch (_) {}
    }

    if (!qrReady) {
      await browser.close();
      return res.status(500).json({ status: false, message: 'Paytm QR code took too long to render. Please click refresh.' });
    }

    // Extra 300ms for logo overlay rendering
    await new Promise(r => setTimeout(r, 300));

    // Capture the entire QR element (.qrContainer has canvas + center logo)
    const qrContainer = await oauthFrame.$('.qrContainer') || await oauthFrame.$('.qrCont') || await oauthFrame.$('canvas');
    let qrImageData = '';

    if (qrContainer) {
      const b64 = await qrContainer.screenshot({ encoding: 'base64' });
      qrImageData = 'data:image/png;base64,' + b64;
    } else {
      qrImageData = await oauthFrame.evaluate(() => {
        const c = document.querySelector('canvas');
        return c ? c.toDataURL('image/png') : null;
      });
    }

    if (!qrImageData) {
      await browser.close();
      return res.status(500).json({ status: false, message: 'Could not render QR code. Please try again.' });
    }

    const sessionId = crypto.randomBytes(16).toString('hex');

    activeSessions.set(sessionId, {
      browser,
      page,
      type: 'QR',
      capturedDetails,
      createdAt: Date.now()
    });

    console.log(`[PaytmAuth] QR Code generated successfully. Session ID: ${sessionId}`);
    return res.json({
      status: true,
      sessionId: sessionId,
      qrImage: qrImageData,
      message: 'Scan this QR code using your Paytm app to login instantly'
    });

  } catch (err) {
    console.error('[PaytmAuth] QR-Initiate Exception:', err);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    return res.status(500).json({ status: false, message: 'QR error: ' + err.message });
  }
});

/**
 * POST /api/paytm/qr-check
 * Body: { sessionId }
 */
app.post('/api/paytm/qr-check', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ status: false, message: 'Session ID required' });
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(400).json({ status: false, message: 'QR session expired' });
  }

  const { browser, page } = session;

  try {
    const currentUrl = page.url();
    const cookies = await page.cookies();

    // Check if authenticated by verifying Paytm's user context API
    const authStatus = await page.evaluate(async () => {
      try {
        const resp = await fetch('https://dashboard.paytm.com/api/v1/context', { credentials: 'include' });
        if (!resp.ok) return { authenticated: false, status: resp.status };
        const data = await resp.json();
        if (data && !data.error && (data.userId || data.userRole || data.name || data.mobile || data.mid || data.merchantId)) {
          return { authenticated: true, user: data };
        }
        return { authenticated: false, data };
      } catch (e) {
        return { authenticated: false, err: e.message };
      }
    });

    console.log(`[PaytmAuth] QR-Check Session: ${sessionId.substring(0,8)} | URL: ${currentUrl} | Auth: ${authStatus.authenticated}`);

    const isStillOnLogin = currentUrl.includes('/login/');

    if (!authStatus.authenticated && isStillOnLogin) {
      return res.json({
        status: false,
        state: 'WAITING',
        message: 'Waiting for QR scan on Paytm App...',
        debugUrl: currentUrl,
        cookieNames: cookies.map(c => c.name)
      });
    }

    // Authenticated! Extract session cookies
    const allCookies = await page.cookies();
    const sCookie = allCookies.find(c => c.name === 'SESSION') || allCookies.find(c => c.name === 'UMP_SESSION');
    const uCookie = allCookies.find(c => c.name === 'UMP_SESSION');
    const xCookie = allCookies.find(c => c.name === 'XSRF-TOKEN');
    const sessionToken = sCookie ? sCookie.value : (uCookie ? uCookie.value : '');
    const xsrfToken = (xCookie && xCookie.value) ? xCookie.value : '';
    const fullCookie = allCookies.map(c => `${c.name}=${c.value}`).join('; ');

    if (!sessionToken) {
      return res.json({ status: false, state: 'WAITING', message: 'Authorizing...' });
    }

    // Allow Next.js dashboard 2 seconds to hydrate store and background APIs
    await new Promise(r => setTimeout(r, 2000));

    // Extract real merchant MID and UPI details
    const mDetails = await fetchMerchantQrDetails(page, sessionToken, xsrfToken, session.capturedDetails || {});

    console.log(`[PaytmAuth] QR Scan Login Confirmed! MID: ${mDetails.mid || 'auto-fallback'}, UPI: ${mDetails.upiId || 'auto-fallback'}`);

    const activeMid = mDetails.mid || '';
    const oldM = activeMid ? liveMerchants.get(activeMid) : null;
    if (oldM && oldM.browser) {
      try { await oldM.browser.close(); } catch (_) {}
    }
    if (activeMid) {
      liveMerchants.set(activeMid, {
        browser,
        page,
        mid: activeMid,
        upiId: mDetails.upiId || '',
        sessionToken,
        xsrfToken,
        lastActivity: Date.now()
      });
    }
    activeSessions.delete(sessionId);
    try {
      fs.writeFileSync(path.join(__dirname, 'saved_cookies.json'), JSON.stringify(cookies, null, 2));
      if (activeMid) {
        fs.writeFileSync(path.join(__dirname, `saved_cookies_${activeMid}.json`), JSON.stringify(cookies, null, 2));
      }
    } catch (_) {}
    console.log(`[PaytmAuth] Saved live Chrome worker session for MID: ${activeMid}`);

    return res.json({
      status: true,
      state: 'SUCCESS',
      message: 'Paytm Account Connected Successfully via QR Scan!',
      sessionToken: sessionToken,
      xsrfToken: xsrfToken,
      cookie: fullCookie || `SESSION=${sessionToken}; UMP_SESSION=${sessionToken}; XSRF-TOKEN=${xsrfToken}`,
      mid: activeMid,
      upiId: mDetails.upiId || '',
      merchantName: mDetails.merchantName || 'Paytm Merchant',
      mobile: mDetails.mobile || ''
    });

  } catch (err) {
    console.error('[PaytmAuth] QR-Check error:', err);
    return res.status(500).json({ status: false, message: err.message });
  }
});

// =========================================================================
// METHOD B: MOBILE + PASSWORD + OTP LOGIN
// =========================================================================

/**
 * POST /api/paytm/send-otp
 * Body: { mobile, password }
 */
app.post('/api/paytm/send-otp', async (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password) {
    return res.status(400).json({ status: false, message: 'Mobile and Password are required' });
  }

  const cleanMobile = String(mobile).replace(/\D/g, '').slice(-10);
  console.log(`[PaytmAuth] Initiating login for mobile: ${cleanMobile}`);

  // Clean up any stale unauthenticated login attempts
  for (const [id, sess] of activeSessions.entries()) {
    if (Date.now() - (sess.createdAt || 0) > 300000) {
      try { if (sess.browser) await sess.browser.close(); } catch (_) {}
      activeSessions.delete(id);
    }
  }

  let browser;
  try {
    const chromePath = getChromeExecutablePath();
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto('https://dashboard.paytm.com/login/', { waitUntil: 'networkidle2', timeout: 35000 });

    let oauthFrame = null;
    for (let attempts = 0; attempts < 15; attempts++) {
      oauthFrame = page.frames().find(f => f.url().includes('oauth-js-sdk'));
      if (oauthFrame) break;
      await new Promise(r => setTimeout(r, 600));
    }

    if (!oauthFrame) {
      await browser.close();
      return res.status(500).json({ status: false, message: 'Paytm login form failed to load. Please try again.' });
    }

    // Wait for email/mobile input
    await oauthFrame.waitForSelector('#email_mobile_login', { timeout: 10000 });
    await oauthFrame.type('#email_mobile_login', cleanMobile, { delay: 40 });

    // Wait for password input
    await oauthFrame.waitForSelector('#password_login', { timeout: 5000 });
    await oauthFrame.type('#password_login', String(password), { delay: 40 });

    // Click submit button in iframe
    const clicked = await oauthFrame.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') || 
                  document.querySelector('button.x-button') || 
                  Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Sign in') || b.innerText.includes('Secure'));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      await page.keyboard.press('Enter');
    }

    // Wait 4 seconds to inspect Paytm's real response
    await new Promise(r => setTimeout(r, 4000));

    // Check full iframe text for real Paytm errors (account blocked, incorrect password, etc.)
    const bodyText = await oauthFrame.evaluate(() => document.body.innerText);

    if (bodyText.includes('blocked your account') || bodyText.includes('exceeded the number of login attempts')) {
      await browser.close();
      console.log(`[PaytmAuth] Account blocked notice for mobile ${cleanMobile}`);
      return res.status(400).json({
        status: false,
        message: 'Paytm Alert: This account is temporarily blocked by Paytm for 1 hour due to exceeding login attempts. Please use QR Scan or try again later.'
      });
    }

    if (bodyText.includes('Incorrect') || bodyText.includes('invalid') || bodyText.includes('wrong')) {
      await browser.close();
      console.log(`[PaytmAuth] Incorrect password for mobile ${cleanMobile}`);
      return res.status(400).json({
        status: false,
        message: 'Paytm Alert: Incorrect password. Please enter the correct Paytm password or use QR Scan.'
      });
    }

    // Store active browser instance
    const sessionId = crypto.randomBytes(16).toString('hex');
    activeSessions.set(sessionId, {
      browser,
      page,
      mobile: cleanMobile,
      type: 'PASSWORD',
      createdAt: Date.now()
    });

    console.log(`[PaytmAuth] OTP dispatched successfully. Session ID: ${sessionId}`);
    return res.json({
      status: true,
      sessionId: sessionId,
      mobile: cleanMobile,
      message: 'OTP has been sent to your Paytm registered mobile number.'
    });

  } catch (err) {
    console.error('[PaytmAuth] Send-OTP Exception:', err);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    return res.status(500).json({ status: false, message: 'Connection error with Paytm: ' + err.message });
  }
});

/**
 * POST /api/paytm/verify-otp
 * Body: { sessionId, otp }
 */
app.post('/api/paytm/verify-otp', async (req, res) => {
  const { sessionId, otp } = req.body;
  if (!sessionId || !otp) {
    return res.status(400).json({ status: false, message: 'Session ID and OTP are required' });
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(400).json({ status: false, message: 'Login session expired or invalid. Please try again.' });
  }

  const cleanOtp = String(otp).trim();
  const { browser, page, mobile } = session;

  try {
    const oauthFrame = page.frames().find(f => f.url().includes('oauth-js-sdk'));
    if (!oauthFrame) {
      throw new Error('OAuth iframe lost from page');
    }

    const otpInput = await oauthFrame.$('input[name="otp"], input[id*="otp"], input[type="tel"], input[type="number"], .x-input-text');
    if (otpInput) {
      await otpInput.click();
      await otpInput.type(cleanOtp, { delay: 40 });
    } else {
      const digitInputs = await oauthFrame.$$('input');
      if (digitInputs.length >= 6) {
        for (let i = 0; i < 6 && i < cleanOtp.length; i++) {
          await digitInputs[i].type(cleanOtp[i], { delay: 30 });
        }
      }
    }

    const otpClicked = await oauthFrame.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') || 
                  document.querySelector('button.x-button') || 
                  Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Verify') || b.innerText.includes('Submit') || b.innerText.includes('Proceed'));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (!otpClicked) {
      await page.keyboard.press('Enter');
    }

    console.log(`[PaytmAuth] OTP submitted for ${mobile}. Waiting for dashboard redirect...`);

    let authenticated = false;
    let authContext = null;

    // Wait up to 25 seconds for Paytm to process OTP and complete dashboard login
    for (let attempts = 0; attempts < 25; attempts++) {
      await new Promise(r => setTimeout(r, 1000));

      // 1. Check if OAuth frame reports error (e.g. invalid OTP)
      try {
        const frameText = await oauthFrame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
        if (frameText.includes('Incorrect') || frameText.includes('invalid') || frameText.includes('wrong OTP')) {
          await browser.close();
          activeSessions.delete(sessionId);
          return res.status(400).json({ status: false, message: 'Invalid OTP entered. Please check your SMS.' });
        }
      } catch (_) {}

      // 2. Check user context from dashboard
      const checkCtx = await page.evaluate(async () => {
        try {
          const resp = await fetch('https://dashboard.paytm.com/api/v1/context', { credentials: 'include' });
          if (!resp.ok) return null;
          const data = await resp.json();
          if (data && !data.error && (data.userId || data.merchantId || data.mid || data.name)) {
            return data;
          }
        } catch (e) {}
        return null;
      });

      if (checkCtx) {
        authenticated = true;
        authContext = checkCtx;
        console.log(`[PaytmAuth] Successfully authenticated! User: ${authContext.name || authContext.mid || authContext.userId}`);
        break;
      }

      // Check URL redirect away from login
      const currentUrl = page.url();
      if (!currentUrl.includes('/login/') && currentUrl.includes('dashboard.paytm.com')) {
        authenticated = true;
        console.log(`[PaytmAuth] Page redirected to: ${currentUrl}`);
        break;
      }
    }

    if (!authenticated) {
      await browser.close();
      activeSessions.delete(sessionId);
      return res.status(400).json({ status: false, message: 'Paytm OTP verification timed out or incorrect. Please try again.' });
    }

    // Now extract real authenticated cookies
    const cookies = await page.cookies();
    const sCookie = cookies.find(c => c.name === 'SESSION');
    const uCookie = cookies.find(c => c.name === 'UMP_SESSION');
    const xCookie = cookies.find(c => c.name === 'XSRF-TOKEN');
    const sessionToken = sCookie ? sCookie.value : (uCookie ? uCookie.value : '');
    const xsrfToken = xCookie ? xCookie.value : '';
    const fullCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    console.log(`[PaytmAuth] Captured real authenticated SESSION token: ${sessionToken ? sessionToken.substring(0, 8) + '...' : 'none'}`);

    // Allow dashboard to settle
    await new Promise(r => setTimeout(r, 1500));

    const mDetails = await fetchMerchantQrDetails(page, sessionToken, xsrfToken);

    const activeMid = mDetails.mid || (authContext && (authContext.mid || authContext.merchantId)) || '';
    const oldM = activeMid ? liveMerchants.get(activeMid) : null;
    if (oldM && oldM.browser) {
      try { await oldM.browser.close(); } catch (_) {}
    }
    if (activeMid) {
      liveMerchants.set(activeMid, {
        browser,
        page,
        mid: activeMid,
        upiId: mDetails.upiId || '',
        sessionToken,
        xsrfToken,
        lastActivity: Date.now()
      });
    }
    activeSessions.delete(sessionId);
    try {
      fs.writeFileSync(path.join(__dirname, 'saved_cookies.json'), JSON.stringify(cookies, null, 2));
      if (activeMid) {
        fs.writeFileSync(path.join(__dirname, `saved_cookies_${activeMid}.json`), JSON.stringify(cookies, null, 2));
      }
    } catch (_) {}
    console.log(`[PaytmAuth] Saved live Chrome worker session for MID: ${activeMid}`);

    return res.json({
      status: true,
      message: 'Paytm Account Connected Successfully!',
      sessionToken: sessionToken,
      xsrfToken: xsrfToken,
      cookie: fullCookie || `SESSION=${sessionToken}; XSRF-TOKEN=${xsrfToken}`,
      mid: activeMid,
      upiId: mDetails.upiId || '',
      merchantName: mDetails.merchantName || (authContext && (authContext.name || authContext.displayName)) || 'Paytm Merchant',
      mobile: mDetails.mobile || mobile
    });

  } catch (err) {
    console.error('[PaytmAuth] Verify-OTP Exception:', err);
    try { await browser.close(); } catch (_) {}
    activeSessions.delete(sessionId);
    return res.status(500).json({ status: false, message: 'Verification error: ' + err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`Paytm Auth Microservice running on port ${PORT}`);
  console.log(`Health endpoint: http://localhost:${PORT}/health`);
  console.log(`=======================================================`);
});
