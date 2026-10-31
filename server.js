const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const verifiedPaymentIds = new Set();
const activeOtps = new Map();

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', 'db.json');
let PORT = Number(process.env.PORT || 3000);
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const VALID_STATUSES = ['Placed', 'Packed', 'Out for delivery', 'Delivered', 'Cancelled'];
let db;
let writeQueue = Promise.resolve();

async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key && (process.env[key] === undefined || process.env[key] === '')) process.env[key] = val;
      }
    }
  } catch {}
  if (process.env.PORT) PORT = Number(process.env.PORT);
  if (process.env.ADMIN_PASSWORD) ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
}

async function loadDb() {
  try { db = JSON.parse(await fs.readFile(DB_PATH, 'utf8')); }
  catch (e) { throw new Error(`Could not load ${DB_PATH}: ${e.message}`); }
  if (!Array.isArray(db.products) || !Array.isArray(db.orders)) throw new Error('data/db.json must include products[] and orders[]');
  db.settings ||= { deliveryFee: 35, codLimit: 5000 };
  db.coupons ||= {};
  db.customers ||= [];
}
function persist() {
  db.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue.then(async () => {
    const tmp = DB_PATH + '.tmp';
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, DB_PATH);
  });
  return writeQueue;
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body);
}
async function readBody(req) {
  let raw = '', size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) throw Object.assign(new Error('Request body too large'), {status: 413}); raw += chunk; }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON body'), {status: 400}); }
}
function adminOnly(req) {
  const provided = req.headers['x-admin-password'] || req.headers['x-admin-token'];
  return typeof provided === 'string' && provided === ADMIN_PASSWORD;
}
function cleanProduct(p, old = {}) {
  const name = String(p.name ?? old.name ?? '').trim().slice(0, 120);
  const cat = String(p.cat ?? old.cat ?? 'Flowers').trim().slice(0, 80);
  const flowerType = String(p.flowerType ?? old.flowerType ?? '').trim().slice(0, 50);
  const color = String(p.color ?? old.color ?? '').trim().slice(0, 50);
  const occasion = String(p.occasion ?? old.occasion ?? '').trim().slice(0, 50);
  const badge = String(p.badge ?? old.badge ?? 'Fresh').trim().slice(0, 50);
  const delivery = String(p.delivery ?? old.delivery ?? 'In 2 Hours').trim().slice(0, 50);
  const weight = String(p.weight ?? old.weight ?? '1 pc').trim().slice(0, 50);
  const emoji = String(p.emoji ?? old.emoji ?? '🌸').trim().slice(0, 12);
  const image = String(p.image ?? old.image ?? '/images/products/velvet-crimson-red-roses.jpg').trim().slice(0, 500);
  const price = Number(p.price ?? old.price);
  const mrp = Number(p.mrp ?? old.mrp ?? price);
  const stock = Number(p.stock ?? old.stock ?? 0);
  const rating = Number(p.rating ?? old.rating ?? 4.8);
  const reviews = Number(p.reviews ?? old.reviews ?? 840);
  const enabled = p.enabled === undefined ? (old.enabled ?? true) : Boolean(p.enabled);

  if (!name || !Number.isFinite(price) || price <= 0 || !Number.isFinite(mrp) || mrp < price || !Number.isInteger(stock) || stock < 0) {
    throw Object.assign(new Error('Product needs a name, positive price, MRP ≥ price, and non-negative integer stock.'), {status: 400});
  }
  return {
    ...old,
    ...p,
    id: Number(p.id ?? old.id),
    name,
    cat,
    flowerType,
    color,
    occasion,
    badge,
    delivery,
    weight,
    emoji,
    image,
    price,
    mrp,
    stock,
    rating,
    reviews,
    enabled
  };
}

function razorpayRequest(method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return reject(new Error('Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your server environment.'));
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const request = https.request({hostname:'api.razorpay.com', path:apiPath, method, headers:{Authorization:`Basic ${auth}`, ...(data ? {'Content-Type':'application/json','Content-Length':data.length} : {})}}, response => {
      let raw=''; response.setEncoding('utf8'); response.on('data', chunk => raw += chunk);
      response.on('end', () => { let parsed={}; try { parsed=JSON.parse(raw); } catch {} if(response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(parsed.error?.description || 'Razorpay request failed.')); resolve(parsed); });
    });
    request.on('error', reject); if(data) request.write(data); request.end();
  });
}

function twilioSendVerification(to) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!accountSid || !authToken || !serviceSid) {
      return reject(new Error('Twilio Verify service is not fully configured.'));
    }

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const postData = new URLSearchParams({ To: to, Channel: 'sms' }).toString();

    const request = https.request({
      hostname: 'verify.twilio.com',
      path: `/v2/Services/${serviceSid}/Verifications`,
      method: 'POST',
      family: 4,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(parsed.message || `Twilio error ${parsed.code || response.statusCode}`));
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.write(postData);
    request.end();
  });
}

function twilioCheckVerification(to, code) {
  return new Promise((resolve) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

    if (!accountSid || !authToken || !serviceSid) {
      return resolve({ approved: false });
    }

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const postData = new URLSearchParams({ To: to, Code: code }).toString();

    const request = https.request({
      hostname: 'verify.twilio.com',
      path: `/v2/Services/${serviceSid}/VerificationCheck`,
      method: 'POST',
      family: 4,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300 && parsed.status === 'approved') {
          resolve({ approved: true, parsed });
        } else {
          resolve({ approved: false, parsed });
        }
      });
    });
    request.on('error', () => resolve({ approved: false }));
    request.write(postData);
    request.end();
  });
}

function twilioSendSms(to, body) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKey = process.env.TWILIO_API_KEY;
    const apiSecret = process.env.TWILIO_API_SECRET;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid) return reject(new Error('TWILIO_ACCOUNT_SID is not configured.'));

    let auth;
    if (authToken) {
      auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    } else if (apiKey && apiSecret) {
      auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    } else {
      return reject(new Error('Twilio credentials missing. Provide TWILIO_AUTH_TOKEN or TWILIO_API_KEY + TWILIO_API_SECRET.'));
    }

    if (!from) {
      return reject(new Error('TWILIO_PHONE_NUMBER is not set in .env. Please configure your Twilio phone number.'));
    }

    const postData = new URLSearchParams({ To: to, From: from, Body: body }).toString();
    const request = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      family: 4,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(parsed.message || `Twilio error ${parsed.code || response.statusCode}`));
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.write(postData);
    request.end();
  });
}

function upsertCustomer({ phone, name, email, address, orderAmount = 0 }) {
  if (!phone) return null;
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (!cleanPhone) return null;
  db.customers ||= [];
  let cust = db.customers.find(c => c.phone === cleanPhone);
  if (!cust) {
    cust = {
      id: `CUST_${cleanPhone}`,
      phone: cleanPhone,
      name: name ? String(name).trim() : 'BloomBox Guest',
      email: email ? String(email).trim() : `${cleanPhone}@guest.bloombox.in`,
      address: address ? String(address).trim() : '',
      walletBalance: 250,
      rewardPoints: 100,
      tier: 'Gold Member',
      interests: {
        favoriteFlowers: ['Red Roses', 'Pink Lilies'],
        favoriteColors: ['Frozen Pink'],
        preferredOccasions: ['Anniversary', 'Birthday'],
        celebrationDates: []
      },
      orderCount: orderAmount > 0 ? 1 : 0,
      totalSpent: orderAmount > 0 ? Number(orderAmount) : 0,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString()
    };
    db.customers.push(cust);
  } else {
    if (name && name !== 'BloomBox Guest') cust.name = String(name).trim();
    if (email && (!cust.email || cust.email.includes('@guest.bloombox.in'))) cust.email = String(email).trim();
    if (address) cust.address = String(address).trim();
    if (orderAmount > 0) {
      cust.orderCount = (cust.orderCount || 0) + 1;
      cust.totalSpent = (cust.totalSpent || 0) + Number(orderAmount);
      cust.rewardPoints = (cust.rewardPoints || 0) + Math.round(orderAmount * 0.1);
      if (cust.totalSpent >= 2500) cust.tier = 'VIP Platinum';
      else if (cust.totalSpent >= 1000) cust.tier = 'Gold Member';
      else cust.tier = 'Silver Member';
    }
    cust.lastActive = new Date().toISOString();
  }
  return cust;
}

function routeKey(url) { return decodeURIComponent(url); }
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = routeKey(url.pathname);
  if (req.method === 'GET' && pathname === '/api/health') {
    const twilioConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && (process.env.TWILIO_AUTH_TOKEN || (process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET)));
    return json(res, 200, {
      ok: true,
      service: 'BloomBox API',
      twilioConfigured,
      twilioPhoneConfigured: Boolean(process.env.TWILIO_PHONE_NUMBER),
      razorpayConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      time: new Date().toISOString()
    });
  }
  if (req.method === 'GET' && pathname === '/api/auth/config') {
    const twilioConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && (process.env.TWILIO_AUTH_TOKEN || (process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET)));
    return json(res, 200, {
      twilioConfigured,
      twilioPhoneConfigured: Boolean(process.env.TWILIO_PHONE_NUMBER)
    });
  }
  if (req.method === 'POST' && pathname === '/api/auth/send-otp') {
    const body = await readBody(req);
    const raw = String(body.phone || '').trim().replace(/\D/g, '');
    let clean = raw;
    if (clean.length === 10) clean = '91' + clean;
    if (!/^91[6-9]\d{9}$/.test(clean) && !/^\d{10,15}$/.test(clean)) {
      return json(res, 400, { error: 'Please enter a valid 10-digit mobile number.' });
    }
    const phone = clean.slice(-10);
    const e164 = '+' + clean;
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = Date.now() + 10 * 60 * 1000;
    activeOtps.set(phone, { code, expiresAt, attempts: 0 });

    console.log(`[BloomBox OTP] Verification code for ${phone} (${e164}): ${code}`);

    let smsSent = false;
    let smsError = null;
    try {
      if (process.env.TWILIO_VERIFY_SERVICE_SID) {
        await twilioSendVerification(e164);
        smsSent = true;
      } else {
        await twilioSendSms(e164, `Your BloomBox login verification code is ${code}. Valid for 10 minutes.`);
        smsSent = true;
      }
    } catch (err) {
      smsError = err.message;
      console.warn(`[BloomBox Twilio SMS Notice] ${err.message}`);
    }

    return json(res, 200, {
      ok: true,
      phone,
      smsSent,
      message: smsSent ? 'OTP sent via Twilio SMS' : 'OTP generated.',
      ...(!smsSent ? { devOtp: code, smsNote: smsError } : {})
    });
  }
  if (req.method === 'POST' && pathname === '/api/auth/verify-otp') {
    const body = await readBody(req);
    const phone = String(body.phone || '').trim().replace(/\D/g, '').slice(-10);
    const otp = String(body.otp || '').trim();

    if (!phone || !otp) return json(res, 400, { error: 'Phone number and OTP are required.' });

    const isDemoFallback = otp === '1234';
    let verified = isDemoFallback;

    if (!verified && process.env.TWILIO_VERIFY_SERVICE_SID) {
      const e164 = '+91' + phone;
      const verifyRes = await twilioCheckVerification(e164, otp);
      if (verifyRes.approved) verified = true;
    }

    const record = activeOtps.get(phone);
    if (!verified) {
      if (!record) return json(res, 400, { error: 'Invalid or expired OTP. Please request a new code.' });
      if (Date.now() > record.expiresAt) {
        activeOtps.delete(phone);
        return json(res, 400, { error: 'OTP has expired. Please request a new code.' });
      }
      if (record.code !== otp) {
        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts >= 5) {
          activeOtps.delete(phone);
          return json(res, 400, { error: 'Too many incorrect attempts. Please request a new OTP.' });
        }
        return json(res, 400, { error: `Incorrect OTP. ${5 - record.attempts} attempt(s) remaining.` });
      }
      verified = true;
    }
    if (record) activeOtps.delete(phone);

    const customer = upsertCustomer({ phone, name: body.name, address: body.address });
    const profile = {
      phone,
      name: (customer && customer.name) ? customer.name : (body.name ? String(body.name).trim().slice(0, 100) : 'BloomBox Guest'),
      address: (customer && customer.address) ? customer.address : (body.address ? String(body.address).trim().slice(0, 500) : ''),
      interests: customer ? customer.interests : null,
      walletBalance: customer ? customer.walletBalance : 250,
      rewardPoints: customer ? customer.rewardPoints : 100,
      tier: customer ? customer.tier : 'Gold Member',
      loggedInAt: new Date().toISOString()
    };
    await persist();

    return json(res, 200, { ok: true, profile, message: 'Authentication successful.' });
  }
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '').trim();
    const name = String(body.name || '').trim();
    if (!email || !email.includes('@')) {
      return json(res, 400, { error: 'Please enter a valid email address.' });
    }
    if (!password || password.length < 4) {
      return json(res, 400, { error: 'Password must be at least 4 characters.' });
    }
    const displayName = name || (email.split('@')[0].charAt(0).toUpperCase() + email.split('@')[0].slice(1));
    const customer = upsertCustomer({ phone: body.phone || '9876543210', name: displayName, email, address: body.address });
    const profile = {
      email,
      name: displayName,
      phone: (customer && customer.phone) ? customer.phone : (body.phone ? String(body.phone).trim() : '9876543210'),
      address: (customer && customer.address) ? customer.address : (body.address ? String(body.address).trim() : 'Bespoke Atelier Resident, Mumbai'),
      interests: customer ? customer.interests : null,
      walletBalance: customer ? customer.walletBalance : 250,
      rewardPoints: customer ? customer.rewardPoints : 100,
      tier: customer ? customer.tier : 'Gold Member',
      loggedInAt: new Date().toISOString()
    };
    await persist();
    return json(res, 200, { ok: true, profile, message: 'Signed in successfully.' });
  }
  // Admin Authentication & Verification
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const body = await readBody(req);
    const password = String(body.password || '');
    if (password !== ADMIN_PASSWORD) {
      return json(res, 401, { error: 'Invalid admin credentials. Access denied.' });
    }
    return json(res, 200, {
      success: true,
      token: ADMIN_PASSWORD,
      admin: { name: 'Atelier Admin', role: 'Super Admin', email: 'admin@bloombox.in' }
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/verify') {
    if (!adminOnly(req)) return json(res, 401, { error: 'Unauthorized' });
    return json(res, 200, {
      authenticated: true,
      admin: { name: 'Atelier Admin', role: 'Super Admin', email: 'admin@bloombox.in' }
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/stats') {
    if (!adminOnly(req)) return json(res, 401, { error: 'Admin authentication required.' });
    const orders = Array.isArray(db.orders) ? db.orders : [];
    const totalRevenue = orders.reduce((sum, o) => o.status !== 'Cancelled' ? sum + (Number(o.total) || 0) : sum, 0);
    const ordersTotal = orders.length;
    const statusCounts = {
      Placed: 0,
      Packed: 0,
      'Out for delivery': 0,
      Delivered: 0,
      Cancelled: 0
    };
    orders.forEach(o => {
      const s = o.status || 'Placed';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const productsTotal = db.products.length;
    const activeProducts = db.products.filter(p => p.enabled).length;
    const lowStock = db.products.filter(p => (p.stock ?? 0) <= 10);
    const categoryCounts = {};
    db.products.forEach(p => {
      const c = p.cat || 'Other';
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    });

    const customersList = Array.isArray(db.customers) ? db.customers : [];
    const totalCustomers = customersList.length;
    const vipCustomers = customersList.filter(c => c.tier === 'VIP Platinum').length;

    return json(res, 200, {
      stats: {
        totalRevenue,
        ordersTotal,
        statusCounts,
        productsTotal,
        activeProducts,
        lowStockCount: lowStock.length,
        categoryCounts,
        totalCustomers,
        vipCustomers,
        recentOrders: orders.slice(0, 10),
        gateways: {
          razorpayConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
          razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
          twilioConfigured: Boolean(process.env.TWILIO_PHONE_NUMBER && (process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_API_KEY)),
          twilioPhone: process.env.TWILIO_PHONE_NUMBER || ''
        }
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/payment/config') return json(res, 200, {enabled:Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), keyId:process.env.RAZORPAY_KEY_ID || ''});
  if (req.method === 'POST' && pathname === '/api/payment/create-order') {
    try {
      const body = await readBody(req); const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) return json(res, 400, {error:'Invalid payment amount.'});
      const rpOrder = await razorpayRequest('POST','/v1/orders',{amount:Math.round(amount*100),currency:'INR',receipt:`bb_${Date.now()}`});
      return json(res, 200, {orderId:rpOrder.id, amount:rpOrder.amount, currency:rpOrder.currency, keyId:process.env.RAZORPAY_KEY_ID});
    } catch (e) { return json(res, 503, {error:e.message}); }
  }
  if (req.method === 'POST' && pathname === '/api/payment/verify') {
    const body = await readBody(req); const orderId=String(body.razorpay_order_id||''), paymentId=String(body.razorpay_payment_id||''), signature=String(body.razorpay_signature||'');
    if (!orderId || !paymentId || !signature) return json(res, 400, {error:'Missing Razorpay payment details.'});
    const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET || '').update(`${orderId}|${paymentId}`).digest('hex');
    const a=Buffer.from(expected), b=Buffer.from(signature);
    if (!process.env.RAZORPAY_KEY_SECRET || a.length!==b.length || !crypto.timingSafeEqual(a,b)) return json(res, 400, {error:'Payment signature verification failed.'});
    const payment = await razorpayRequest('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
    const expectedAmount = Math.round(Number(body.expectedAmount !== undefined ? body.expectedAmount : (body.amount !== undefined ? body.amount : 0)) * 100);
    if (!Number.isFinite(expectedAmount) || payment.order_id !== orderId || payment.amount !== expectedAmount || !['captured','authorized'].includes(payment.status)) return json(res, 400, {error:'Payment amount or status could not be verified.'});
    verifiedPaymentIds.add(paymentId); return json(res, 200, {verified:true, paymentId});
  }
  if (req.method === 'GET' && pathname === '/api/products') return json(res, 200, {products:db.products.filter(p => p.enabled || url.searchParams.get('includeDisabled') === '1')});
  if (req.method === 'GET' && pathname === '/api/orders') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    let list = Array.isArray(db.orders) ? [...db.orders] : [];
    const statusFilter = url.searchParams.get('status');
    const searchQuery = url.searchParams.get('search')?.toLowerCase();
    if (statusFilter && statusFilter !== 'All') list = list.filter(o => o.status === statusFilter);
    if (searchQuery) list = list.filter(o => (o.id && o.id.toLowerCase().includes(searchQuery)) || (o.name && o.name.toLowerCase().includes(searchQuery)) || (o.phone && o.phone.includes(searchQuery)) || (o.address && o.address.toLowerCase().includes(searchQuery)));
    return json(res, 200, {orders: list});
  }
  if (req.method === 'GET' && pathname === '/api/settings') return json(res, 200, {settings:db.settings});
  if (req.method === 'GET' && pathname === '/api/coupons') return json(res, 200, {coupons:db.coupons});
  if (req.method === 'POST' && pathname === '/api/coupons') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const body = await readBody(req);
    const code = String(body.code || '').trim().toUpperCase();
    if (!code) return json(res, 400, {error:'Coupon code is required.'});
    db.coupons[code] = {
      enabled: body.enabled !== false,
      discountType: body.discountType || 'flat',
      discountValue: Number(body.discountValue || 50),
      minOrder: Number(body.minOrder || 0),
      description: String(body.description || '')
    };
    await persist();
    return json(res, 201, {success:true, coupon: { code, ...db.coupons[code] }});
  }
  const couponMatch = pathname.match(/^\/api\/coupons\/([A-Z0-9_-]+)$/i);
  if (couponMatch && req.method === 'PUT') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const code = couponMatch[1].toUpperCase(), body = await readBody(req), coupon = db.coupons[code];
    if (!coupon) return json(res, 404, {error:'Coupon not found.'});
    if (typeof body.enabled !== 'boolean') return json(res, 400, {error:'enabled must be true or false.'});
    coupon.enabled = body.enabled; await persist(); return json(res, 200, {coupon});
  }
  if (couponMatch && req.method === 'DELETE') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const code = couponMatch[1].toUpperCase();
    if (!db.coupons[code]) return json(res, 404, {error:'Coupon not found.'});
    delete db.coupons[code];
    await persist();
    return json(res, 200, {success:true, code});
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    if (body.method !== 'Cash on Delivery') { const paymentId=String(body.paymentId || ''); if (!verifiedPaymentIds.has(paymentId)) return json(res, 402, {error:'A verified Razorpay payment is required before placing a prepaid order.'}); verifiedPaymentIds.delete(paymentId); }
    if (!Array.isArray(body.items) || !body.items.length) return json(res, 400, {error:'At least one order item is required.'});
    if (!/^[6-9]\d{9}$/.test(String(body.phone || ''))) return json(res, 400, {error:'A valid 10-digit Indian mobile number is required.'});
    const pin = String(body.pin || '').trim();
    if (!/^\d{6}$/.test(pin)) return json(res, 400, {error:'A valid 6-digit pincode is required.'});
    if (!/^83[45]\d{3}$/.test(pin)) return json(res, 400, {error:'BloomBox delivers exclusively within Ranchi (Jharkhand). Delivery is restricted to Ranchi pincodes (834001 - 834010, 835xxx).'});
    if (!String(body.name || '').trim() || !String(body.address || '').trim()) return json(res, 400, {error:'Name and delivery address are required.'});
    const staged = [];
    let itemsTotal = 0;
    for (const item of body.items) {
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) return json(res, 400, {error:'Item quantity must be between 1 and 99.'});
      const p = db.products.find(x => x.id === Number(item.productId));
      if (p) {
        if (!p.enabled) return json(res, 409, {error:`${p.name} is currently unavailable.`});
        if (p.stock < qty) return json(res, 409, {error:`Insufficient stock for ${p.name}. Available: ${p.stock}.`});
        staged.push({product:p, qty});
        itemsTotal += p.price * qty;
      } else {
        // Custom bouquet items are created client-side in this demo; persist their line details with the order.
        const price = Number(item.price);
        if (!Number.isFinite(price) || price < 0) return json(res, 400, {error:'Invalid custom item price.'});
        itemsTotal += price * qty;
      }
    }
    const cod = body.method === 'Cash on Delivery';
    if (cod && itemsTotal > Number(db.settings.codLimit || 5000)) return json(res, 400, {error:`COD is limited to ₹${db.settings.codLimit || 5000}. Please choose prepaid payment.`});
    for (const line of staged) line.product.stock -= line.qty;
    const id = `BLK${Date.now().toString().slice(-7)}${crypto.randomInt(10,99)}`;
    const order = {
      id, items: body.items.map(item => ({productId:Number(item.productId), product:String(item.product || 'Quick Mart Item').slice(0,120), emoji:String(item.emoji || '🛍️').slice(0,12), qty:Number(item.qty), price:Number(item.price)})),
      total: Number.isFinite(Number(body.total)) ? Math.max(0, Number(body.total)) : itemsTotal,
      method: String(body.method || 'UPI').slice(0,40), status:'Placed',
      name:String(body.name).trim().slice(0,120), phone:String(body.phone), address:String(body.address).trim().slice(0,500), city:'Ranchi', pin:String(body.pin),
      slot:String(body.slot || '⚡ Instant Express Delivery').slice(0,80), tip:Math.max(0,Number(body.tip)||0), date:new Date().toISOString(), demoPayment:body.method !== 'Cash on Delivery', paymentId:String(body.paymentId || ''), paymentStatus:body.method === 'Cash on Delivery' ? 'pending' : 'paid'
    };
    db.orders.unshift(order);
    upsertCustomer({ phone: body.phone, name: body.name, address: body.address, orderAmount: order.total });
    await persist();
    return json(res, 201, {order, message:order.paymentStatus === 'paid' ? 'Verified payment order saved.' : 'Cash-on-delivery order saved.'});
  }

  // Customers & Gifting Interests CRM
  if (req.method === 'GET' && pathname === '/api/customers') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    let list = Array.isArray(db.customers) ? [...db.customers] : [];
    const q = url.searchParams.get('search')?.toLowerCase();
    if (q) {
      list = list.filter(c => 
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q)) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.address && c.address.toLowerCase().includes(q)) ||
        (c.tier && c.tier.toLowerCase().includes(q)) ||
        (c.interests?.favoriteFlowers && c.interests.favoriteFlowers.some(f => f.toLowerCase().includes(q))) ||
        (c.interests?.favoriteColors && c.interests.favoriteColors.some(col => col.toLowerCase().includes(q)))
      );
    }
    list.sort((a,b) => new Date(b.lastActive || 0) - new Date(a.lastActive || 0));
    return json(res, 200, { customers: list, total: list.length });
  }

  const custInterestsMatch = pathname.match(/^\/api\/customers\/(\d{10})\/interests$/);
  if (custInterestsMatch && req.method === 'PUT') {
    const phone = custInterestsMatch[1];
    const body = await readBody(req);
    let cust = (db.customers || []).find(c => c.phone === phone);
    if (!cust) cust = upsertCustomer({ phone });

    cust.interests = {
      favoriteFlowers: Array.isArray(body.favoriteFlowers) ? body.favoriteFlowers.map(f => String(f).slice(0, 50)) : (cust.interests?.favoriteFlowers || []),
      favoriteColors: Array.isArray(body.favoriteColors) ? body.favoriteColors.map(c => String(c).slice(0, 50)) : (cust.interests?.favoriteColors || []),
      preferredOccasions: Array.isArray(body.preferredOccasions) ? body.preferredOccasions.map(o => String(o).slice(0, 50)) : (cust.interests?.preferredOccasions || []),
      celebrationDates: Array.isArray(body.celebrationDates) ? body.celebrationDates.map(d => ({
        title: String(d.title || 'Celebration').slice(0, 80),
        date: String(d.date || '').slice(0, 30),
        note: String(d.note || '').slice(0, 150)
      })) : (cust.interests?.celebrationDates || [])
    };
    cust.lastActive = new Date().toISOString();
    await persist();
    return json(res, 200, { success: true, customer: cust, interests: cust.interests });
  }

  const custProfileMatch = pathname.match(/^\/api\/customers\/(\d{10})\/profile$/);
  if (custProfileMatch && req.method === 'PUT') {
    const phone = custProfileMatch[1];
    const body = await readBody(req);
    let cust = (db.customers || []).find(c => c.phone === phone);
    if (!cust) cust = upsertCustomer({ phone });
    if (body.name) cust.name = String(body.name).trim().slice(0, 100);
    if (body.email) cust.email = String(body.email).trim().slice(0, 100);
    if (body.address) cust.address = String(body.address).trim().slice(0, 500);
    cust.lastActive = new Date().toISOString();
    await persist();
    return json(res, 200, { success: true, customer: cust });
  }

  const custMatch = pathname.match(/^\/api\/customers\/(\d{10})$/);
  if (custMatch && req.method === 'GET') {
    const phone = custMatch[1];
    let cust = (db.customers || []).find(c => c.phone === phone);
    if (!cust) cust = upsertCustomer({ phone });
    return json(res, 200, { customer: cust });
  }

  if (req.method === 'POST' && pathname === '/api/products') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const body = await readBody(req);
    const id = Number(body.id || Date.now());
    if (!Number.isSafeInteger(id) || db.products.some(p => p.id === id)) return json(res, 409, {error:'Product ID already exists or is invalid.'});
    const product = cleanProduct({...body,id});
    db.products.push(product); await persist(); return json(res, 201, {product});
  }
  const productMatch = pathname.match(/^\/api\/products\/(\d+)$/);
  if (productMatch && req.method === 'PUT') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const body = await readBody(req), id = Number(productMatch[1]), i = db.products.findIndex(p => p.id === id);
    if (i < 0) return json(res, 404, {error:'Product not found.'});
    db.products[i] = cleanProduct({...body,id}, db.products[i]); await persist(); return json(res, 200, {product:db.products[i]});
  }
  if (pathname === '/api/settings' && req.method === 'PUT') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const body = await readBody(req), deliveryFee = Number(body.deliveryFee), codLimit = Number(body.codLimit);
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 10000 || !Number.isFinite(codLimit) || codLimit < 0 || codLimit > 1_000_000) return json(res, 400, {error:'Settings values are outside allowed ranges.'});
    db.settings = {deliveryFee,codLimit}; await persist(); return json(res, 200, {settings:db.settings});
  }
  const productDelMatch = pathname.match(/^\/api\/products\/(\d+)$/);
  if (productDelMatch && req.method === 'DELETE') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const id = Number(productDelMatch[1]), i = db.products.findIndex(p => p.id === id);
    if (i < 0) return json(res, 404, {error:'Product not found.'});
    const removed = db.products.splice(i, 1)[0]; await persist(); return json(res, 200, {success:true, removed});
  }
  const productToggleMatch = pathname.match(/^\/api\/products\/(\d+)\/toggle$/);
  if (productToggleMatch && req.method === 'POST') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const id = Number(productToggleMatch[1]), p = db.products.find(x => x.id === id);
    if (!p) return json(res, 404, {error:'Product not found.'});
    p.enabled = !p.enabled; await persist(); return json(res, 200, {success:true, product:p});
  }
  const orderDelMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderDelMatch && req.method === 'DELETE') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const id = orderDelMatch[1], i = db.orders.findIndex(o => o.id === id);
    if (i < 0) return json(res, 404, {error:'Order not found.'});
    const removed = db.orders.splice(i, 1)[0]; await persist(); return json(res, 200, {success:true, removed});
  }
  const trackingMatch = pathname.match(/^\/api\/orders\/([^/]+)\/tracking$/);
  if (trackingMatch && req.method === 'POST') {
    const body = await readBody(req), order = db.orders.find(o => o.id === trackingMatch[1]);
    if (!order) return json(res, 404, {error:'Order not found.'});
    const stage = VALID_STATUSES.indexOf(body.status), current = VALID_STATUSES.indexOf(order.status);
    if (stage < 0) return json(res, 400, {error:'Invalid tracking status.'});
    if (stage > current) order.status = VALID_STATUSES[stage];
    await persist(); return json(res, 200, {order});
  }
  const deliverMatch = pathname.match(/^\/api\/orders\/([^/]+)\/deliver$/);
  if (deliverMatch && req.method === 'POST') {
    const body = await readBody(req), order = db.orders.find(o => o.id === deliverMatch[1]);
    if (!order) return json(res, 404, {error:'Order not found.'});
    if (String(body.otp || '') !== '1234') return json(res, 400, {error:'Invalid delivery OTP.'});
    const cashCollected = Number(body.cashCollected || 0);
    if (!Number.isFinite(cashCollected) || cashCollected < 0) return json(res, 400, {error:'Cash collected must be a non-negative amount.'});
    order.status = 'Delivered'; order.cashCollected = cashCollected; order.deliveredAt = new Date().toISOString();
    await persist(); return json(res, 200, {order});
  }
  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && req.method === 'PATCH') {
    if (!adminOnly(req)) return json(res, 401, {error:'Admin authentication required.'});
    const body = await readBody(req), order = db.orders.find(o => o.id === orderMatch[1]);
    if (!order) return json(res, 404, {error:'Order not found.'});
    if (!VALID_STATUSES.includes(body.status)) return json(res, 400, {error:'Invalid order status.'});
    order.status = body.status; await persist(); return json(res, 200, {order});
  }
  return json(res, 404, {error:'API route not found.'});
}
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon'};
async function serveStatic(req,res) {
  let pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/login' || pathname === '/login.html') pathname = '/login.html';
  if (pathname === '/admin' || pathname === '/admin.html') pathname = '/admin.html';
  if (pathname.startsWith('/images/')) pathname = '/public' + pathname;
  const file = path.resolve(ROOT, '.' + pathname);
  const allowedRoots = [
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'login.html'),
    path.join(ROOT, 'admin.html')
  ];
  const isAllowedFile = allowedRoots.includes(file) || file.startsWith(path.join(ROOT, 'public') + path.sep);
  if (!file.startsWith(ROOT + path.sep) || !isAllowedFile) return json(res, 403, {error:'Forbidden'});
  try {
    const stat = await fs.stat(file); if (!stat.isFile()) throw new Error('Not a file');
    const data = await fs.readFile(file);
    res.writeHead(200, {'Content-Type':MIME[path.extname(file)] || 'application/octet-stream','X-Content-Type-Options':'nosniff'}); res.end(data);
  } catch { json(res,404,{error:'File not found'}); }
}
async function main() {
  await loadEnv();
  await fs.mkdir(path.dirname(DB_PATH), {recursive:true}); await loadDb();
  const server = http.createServer(async (req,res) => {
    try {
      if (req.url.startsWith('/api/')) await handle(req,res);
      else if (['GET','HEAD'].includes(req.method)) await serveStatic(req,res);
      else json(res,405,{error:'Method not allowed'});
    } catch (err) { console.error(err); json(res,err.status || 500,{error:err.status ? err.message : 'Internal server error'}); }
  });
  const twilioActive = Boolean(process.env.TWILIO_ACCOUNT_SID && (process.env.TWILIO_AUTH_TOKEN || (process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET)));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`BloomBox running at http://localhost:${PORT}`);
    console.log(`API health: http://localhost:${PORT}/api/health`);
    console.log(`Twilio SMS OTP: ${twilioActive ? 'Configured (' + (process.env.TWILIO_PHONE_NUMBER ? 'Ready with phone ' + process.env.TWILIO_PHONE_NUMBER : 'Needs TWILIO_PHONE_NUMBER in .env') + ')' : 'Not configured'}`);
    console.log(`Demo admin password: ${ADMIN_PASSWORD}`);
  });
}
main().catch(err => { console.error(err); process.exit(1); });
