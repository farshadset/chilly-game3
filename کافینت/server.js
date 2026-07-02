const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const compression = require('compression');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const rootDir = path.resolve(__dirname);

app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const oneYear = 1000 * 60 * 60 * 24 * 365;
const staticOptions = {
  maxAge: oneYear,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const pathString = filePath.toString();
    if (pathString.endsWith('.html') || pathString.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
};
app.use('/public', express.static(path.join(rootDir, 'public'), staticOptions));
app.use(express.static(path.join(rootDir, 'public'), staticOptions));

// --- RAWG Gaming API: Cache & Rate Limiting ---
const rawgCache = new Map();
const MAX_CACHE_SIZE = 500;
const CACHE_TTL = 1000 * 60 * 60;

function getCacheKey(p, params) {
    return p + ':' + crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex');
}

function getFromCache(key) {
    const entry = rawgCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
        rawgCache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data) {
    if (rawgCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = rawgCache.keys().next().value;
        if (oldestKey !== undefined) rawgCache.delete(oldestKey);
    }
    rawgCache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30;

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + RATE_LIMIT_WINDOW;
    }
    record.count++;
    rateLimitMap.set(ip, record);
    if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'درخواست‌های بیش از حد. لطفاً کمی صبر کنید.' });
    }
    next();
}

const isVercel = !!process.env.VERCEL;
const DB_PATH = isVercel
    ? path.join('/tmp', 'database.json')
    : path.join(rootDir, 'database.json');
const ATTACHMENTS_DIR = path.join(rootDir, 'public', 'uploads', 'attachments');

fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

function sanitizeAttachmentName(name) {
    const safeName = String(name || 'attachment')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120);
    return safeName || 'attachment';
}

function decodeDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return {
        type: match[1],
        buffer: Buffer.from(match[2], 'base64')
    };
}

function readDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch {
        return { users: [], orders: [], banners: [], chat: [] };
    }
}

function migrateChatData(db) {
    if (!db.chat) db.chat = [];
    db.chatMeta = db.chatMeta || {};
    var changed = false;
    db.chat.forEach(function(msg) {
        if (msg.role === 'customer' && !msg.username) {
            msg.username = 'مهمان';
            changed = true;
        }
    });
    if (changed) writeDB(db);
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Failed to write DB:', e.message);
    }
}

// Auth routes
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    if (db.users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'کاربر وجود دارد' });
    }
    db.users.push({ username, password });
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username && u.password === password);
    if (user) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'sedeb' && password === 'sedeb75') {
        res.json({ success: true, token: 'admin-token' });
    } else {
        res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
    }
});

// Order routes
app.post('/api/order', async (req, res) => {
    const trackingCode = 'CFT-' + Date.now().toString().slice(-8);
    const order = {
        username: (req.body.username || '').trim() || null,
        ...req.body,
        trackingCode,
        created_at: new Date()
    };
    const db = readDB();
    db.orders = db.orders || [];
    db.orders.push(order);
    writeDB(db);
    res.json({ success: true, trackingCode });
});

app.get('/api/order/:trackingCode', async (req, res) => {
    const { trackingCode } = req.params;
    const db = readDB();
    const order = (db.orders || []).find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    res.json(order);
});

app.post('/api/order-attachment', async (req, res) => {
    const { trackingCode, attachment } = req.body;
    if (!trackingCode || !/^[A-Za-z0-9-]+$/.test(trackingCode)) {
        return res.status(400).json({ error: 'کد سفارش نامعتبر است' });
    }
    if (!attachment || !attachment.name || !attachment.dataUrl) {
        return res.status(400).json({ error: 'فایل پیوست نامعتبر است' });
    }

    const decoded = decodeDataUrl(attachment.dataUrl);
    if (!decoded || decoded.buffer.length === 0) {
        return res.status(400).json({ error: 'داده فایل نامعتبر است' });
    }

    const db = readDB();
    const order = (db.orders || []).find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }

    const fileName = sanitizeAttachmentName(attachment.name);
    const orderDir = path.join(ATTACHMENTS_DIR, trackingCode);
    fs.mkdirSync(orderDir, { recursive: true });
    const filePath = path.join(orderDir, fileName);
    fs.writeFileSync(filePath, decoded.buffer);

    const savedAttachment = {
        id: attachment.id || ('att_' + Date.now() + '_' + Math.random().toString(16).slice(2)),
        name: fileName,
        type: attachment.type || decoded.type,
        size: decoded.buffer.length,
        url: '/uploads/attachments/' + encodeURIComponent(trackingCode) + '/' + encodeURIComponent(fileName),
        uploadedAt: attachment.uploadedAt || new Date().toISOString()
    };

    order.attachments = order.attachments || [];
    const existingIndex = order.attachments.findIndex(a => a.id === savedAttachment.id);
    if (existingIndex >= 0) {
        order.attachments[existingIndex] = savedAttachment;
    } else {
        order.attachments.push(savedAttachment);
    }
    order.updated_at = new Date().toISOString();
    writeDB(db);

    res.json({ success: true, attachment: savedAttachment });
});

app.post('/api/order/confirm', async (req, res) => {
    const { trackingCode } = req.body;
    const db = readDB();
    const order = db.orders.find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    order.status = 'pending';
    order.confirmed_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/order/status', async (req, res) => {
    const { trackingCode, status } = req.body;
    if (!['pending', 'processing', 'completed'].includes(status)) {
        return res.status(400).json({ error: 'وضعیت نامعتبر' });
    }
    const db = readDB();
    const order = db.orders.find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    order.status = status;
    order.updated_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/order/result', async (req, res) => {
    const { trackingCode, result } = req.body;
    const db = readDB();
    const order = db.orders.find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    if (result && result.trim()) {
        order.result = result.trim();
    } else {
        delete order.result;
    }
    order.result_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/order/price-proposal', async (req, res) => {
    const { trackingCode, proposedPrice } = req.body;
    if (!trackingCode || !proposedPrice) {
        return res.status(400).json({ error: 'کد سفارش و قیمت الزامی است' });
    }
    const db = readDB();
    const order = db.orders.find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    order.proposedPrice = proposedPrice;
    order.priceStatus = 'usercounter';
    order.updated_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/order/price-counter', async (req, res) => {
    const { trackingCode, adminProposedPrice } = req.body;
    if (!trackingCode || !adminProposedPrice) {
        return res.status(400).json({ error: 'کد سفارش و قیمت الزامی است' });
    }
    const db = readDB();
    const order = db.orders.find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    order.adminProposedPrice = adminProposedPrice;
    order.priceStatus = 'countersent';
    order.updated_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/order/price-accept', async (req, res) => {
    const { trackingCode } = req.body;
    if (!trackingCode) {
        return res.status(400).json({ error: 'کد سفارش الزامی است' });
    }
    const db = readDB();
    const order = db.orders.find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    order.priceStatus = 'accepted';
    order.cost = 'قیمت توافقی - ' + (order.adminProposedPrice || order.proposedPrice);
    order.updated_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/order/pay', async (req, res) => {
    const { trackingCode } = req.body;
    if (!trackingCode) {
        return res.status(400).json({ error: 'کد سفارش الزامی است' });
    }
    const db = readDB();
    const order = db.orders.find(o => o.trackingCode === trackingCode);
    if (!order) {
        return res.status(404).json({ error: 'سفارش پیدا نشد' });
    }
    if (order.priceStatus !== 'accepted') {
        return res.status(400).json({ error: 'قیمت هنوز تایید نشده است' });
    }
    order.paid = true;
    order.paymentStatus = 'paid';
    order.updated_at = new Date().toISOString();
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/change-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) {
        return res.status(404).json({ error: 'کاربر پیدا نشد' });
    }
    if (user.password !== currentPassword) {
        return res.status(400).json({ error: 'رمز عبور فعلی اشتباه است' });
    }
    user.password = newPassword;
    writeDB(db);
    res.json({ success: true });
});

app.get('/api/orders', async (req, res) => {
    const { status } = req.query;
    const db = readDB();
    let orders = db.orders || [];
    if (status) {
        orders = orders.filter(o => o.status === status);
    }
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(orders);
});

app.get('/api/orders/user', async (req, res) => {
    const { username, status } = req.query;
    if (!username) {
        return res.status(400).json({ error: 'نام کاربری الزامی است' });
    }
    const db = readDB();
    let userOrders = (db.orders || []).filter(o => o.username === username);
    if (status) {
        userOrders = userOrders.filter(o => o.status === status);
    }
    userOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(userOrders);
});

app.get('/api/admin/customers', async (req, res) => {
    const db = readDB();
    const completedOrders = (db.orders || []).filter(o => o.status === 'completed');
    
    var customerStats = {};
    var uniqueCustomers = new Set();
    completedOrders.forEach(function(order) {
        var username = order.username;
        if (!username) return;
        uniqueCustomers.add(username);
        
        if (!customerStats[username]) {
            customerStats[username] = {
                username: username,
                totalOrders: 0,
                totalSpent: 0,
                orders: []
            };
        }
        
        customerStats[username].totalOrders += 1;
        customerStats[username].orders.push({
            trackingCode: order.trackingCode,
            title: order.title,
            created_at: order.created_at,
            result: order.result
        });
        
        var orderCost = 0;
        if (order.paid && order.adminProposedPrice) {
            var priceStr = String(order.adminProposedPrice).replace(/[۰-۹]/g, function(d) { return d.charCodeAt(0) - 0x06F0; });
            priceStr = priceStr.replace(/[,٬٫]/g, '').replace(/[^\d]/g, '');
            if (priceStr) orderCost = parseInt(priceStr, 10);
        } else if (order.paid && order.proposedPrice) {
            var priceStr = String(order.proposedPrice).replace(/[۰-۹]/g, function(d) { return d.charCodeAt(0) - 0x06F0; });
            priceStr = priceStr.replace(/[,٬٫]/g, '').replace(/[^\d]/g, '');
            if (priceStr) orderCost = parseInt(priceStr, 10);
        } else if (order.cost) {
            var costStr = String(order.cost).replace(/[۰-۹]/g, function(d) { return d.charCodeAt(0) - 0x06F0; });
            costStr = costStr.replace(/[,٬٫]/g, '').replace(/[^\d]/g, '');
            if (costStr) orderCost = parseInt(costStr, 10);
        }
        
        customerStats[username].totalSpent += orderCost;
    });
    
    var customersList = Object.keys(customerStats).map(function(k) { 
        return customerStats[k]; 
    });
    customersList.sort(function(a, b) { return b.totalSpent - a.totalSpent; });
    
    res.json({ customers: customersList, totalCustomers: uniqueCustomers.size });
});

// Pricing routes
app.get('/api/pricing', async (req, res) => {
    const db = readDB();
    res.json(db.pricing || []);
});

app.post('/api/pricing', async (req, res) => {
    const { service, price } = req.body;
    if (!service) {
        return res.status(400).json({ error: 'سرویس الزامی است' });
    }
    const db = readDB();
    db.pricing = db.pricing || [];
    const existing = db.pricing.find(p => p.service === service);
    if (existing) {
        existing.price = price;
    } else {
        db.pricing.push({ service, price });
    }
    writeDB(db);
    res.json({ success: true });
});

// Banner routes
app.post('/api/banner', async (req, res) => {
    const { src, link, duration, group } = req.body;
    const db = readDB();
    db.banners = db.banners || [];
    const targetGroup = [1, 2].includes(parseInt(group, 10)) ? parseInt(group, 10) : 1;
    const groupBanners = db.banners.filter(b => (parseInt(b.group, 10) || 1) == targetGroup);
    if (groupBanners.length >= 3) {
        return res.status(400).json({ error: 'حداکثر تعداد بنرهای هر گروه ۳ عدد است' });
    }
    db.banners.push({
        id: Date.now(),
        src,
        link: link || '',
        duration: parseInt(duration) || 5,
        group: targetGroup,
        date: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true });
});

app.get('/api/banner', async (req, res) => {
    const { group } = req.query;
    const db = readDB();
    var allBanners = db.banners || [];
    allBanners.forEach(b => {
        if (!b.group) b.group = 1;
        if (!b.duration) b.duration = 5;
    });
    if (group) {
        const groupNum = parseInt(group);
        if (!Number.isNaN(groupNum)) {
            return res.json(allBanners.filter(b => parseInt(b.group, 10) == groupNum));
        }
    }
    res.json(allBanners);
});

app.delete('/api/banner/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const db = readDB();
    db.banners = (db.banners || []).filter(b => b.id != id);
    writeDB(db);
    res.json({ success: true });
});

app.put('/api/banner/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { src, link, duration, group } = req.body;
    const db = readDB();
    const banner = (db.banners || []).find(b => b.id == id);
    if (banner) {
        var newGroup = [1, 2].includes(parseInt(group, 10)) ? parseInt(group, 10) : (parseInt(banner.group, 10) || 1);
        if (newGroup !== parseInt(banner.group, 10)) {
            var groupBanners = (db.banners || []).filter(b => (parseInt(b.group, 10) || 1) == newGroup);
            if (groupBanners.length >= 3) {
                return res.status(400).json({ error: 'حداکثر تعداد بنرهای هر گروه ۳ عدد است' });
            }
        }
        banner.src = src;
        banner.link = link || '';
        banner.duration = parseInt(duration) || 5;
        banner.group = newGroup;
        banner.date = new Date().toISOString();
        writeDB(db);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'بنر پیدا نشد' });
    }
});

// Chat routes
app.get('/api/chat', async (req, res) => {
    const { username } = req.query;
    const db = readDB();
    migrateChatData(db);
    if (username) {
        const messages = (db.chat || []).filter(m =>
            (m.role === 'customer' && m.username === username) ||
            (m.role === 'admin')
        );
        res.json(messages);
    } else {
        res.json((db.chat || []).filter(m => m.role === 'customer'));
    }
});

app.post('/api/chat', async (req, res) => {
    const { username, text, conversationId, attachments } = req.body;
    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'متن پیام الزامی است' });
    }
    const db = readDB();
    if (!db.chat) db.chat = [];
    const message = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        role: 'customer',
        username: username || 'مهمان',
        text: text.trim(),
        timestamp: new Date().toISOString(),
        conversationId: conversationId || null,
        attachments: Array.isArray(attachments) ? attachments : []
    };
    db.chat.push(message);
    writeDB(db);
    res.json(message);
});

app.get('/api/admin/chat', async (req, res) => {
    const db = readDB();
    migrateChatData(db);
    res.json({
        messages: db.chat || [],
        lastReadAt: db.chatMeta && db.chatMeta.lastReadAt ? db.chatMeta.lastReadAt : null
    });
});

app.post('/api/admin/chat/read', async (req, res) => {
    const { lastReadAt } = req.body;
    const db = readDB();
    db.chatMeta = db.chatMeta || {};
    if (lastReadAt) {
        db.chatMeta.lastReadAt = lastReadAt;
    }
    writeDB(db);
    res.json({ success: true });
});

app.post('/api/admin/chat', async (req, res) => {
    const { text, username, conversationId, attachments } = req.body;
    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'متن پیام الزامی است' });
    }
    const db = readDB();
    if (!db.chat) db.chat = [];
    const message = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        role: 'admin',
        username: username || null,
        text: text.trim(),
        timestamp: new Date().toISOString(),
        conversationId: conversationId || null,
        attachments: Array.isArray(attachments) ? attachments : []
    };
    db.chat.push(message);
    writeDB(db);
    res.json(message);
});

app.get('/api/admin/chat/conversation', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ error: 'نام کاربری الزامی است' });
    }
    const db = readDB();
    migrateChatData(db);
    var messages = (db.chat || []).filter(function(m) {
        return (m.role === 'customer' && m.username === username) || (m.role === 'admin' && !m.username);
    });
    messages.sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
    res.json(messages);
});

app.get('/api/admin/chat/conversations', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ error: 'نام کاربری الزامی است' });
    }
    const db = readDB();
    migrateChatData(db);
    var convs = {};
    (db.chat || []).forEach(function(m) {
        if (m.role === 'customer' && m.username === username && m.conversationId) {
            if (!convs[m.conversationId]) {
                convs[m.conversationId] = {
                    id: m.conversationId,
                    username: m.username,
                    createdAt: m.timestamp,
                    lastMessage: m.text,
                    lastTimestamp: m.timestamp,
                    messageCount: 0
                };
            }
            convs[m.conversationId].lastMessage = m.text;
            convs[m.conversationId].lastTimestamp = m.timestamp;
            convs[m.conversationId].messageCount++;
        }
    });
    var list = Object.keys(convs).map(function(k) { return convs[k]; });
    list.sort(function(a, b) { return new Date(b.lastTimestamp) - new Date(a.lastTimestamp); });
    res.json(list);
});

app.get('/api/admin/chat/conversation/:id', async (req, res) => {
    const { id } = req.params;
    const db = readDB();
    var messages = (db.chat || []).filter(function(m) {
        return m.conversationId === id;
    });
    messages.sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
    res.json(messages);
});

app.get('/api/admin/chat/customers', async (req, res) => {
    const db = readDB();
    migrateChatData(db);
    var customers = {};
    (db.chat || []).forEach(function(m) {
        if (m.role === 'customer') {
            if (!customers[m.username]) {
                customers[m.username] = { username: m.username, lastMessage: m.text, lastTimestamp: m.timestamp, unread: 0 };
            }
            customers[m.username].lastMessage = m.text;
            customers[m.username].lastTimestamp = m.timestamp;
        }
    });
    var lastAdminGlobal = db.chatMeta && db.chatMeta.lastReadAt ? db.chatMeta.lastReadAt : null;
    Object.keys(customers).forEach(function(key) {
        var customer = customers[key];
        var hasAdminReply = (db.chat || []).some(function(m) {
            return m.role === 'admin' && (!m.username || m.username === customer.username) && m.timestamp >= customer.lastTimestamp;
        });
        if (!hasAdminReply) customer.unread = 1;
    });
    var list = Object.keys(customers).map(function(k) { return customers[k]; });
    list.sort(function(a, b) { return new Date(b.lastTimestamp) - new Date(a.lastTimestamp); });
    res.json(list);
});

app.post('/api/chat/conversation', async (req, res) => {
    const { username } = req.body;
    const db = readDB();
    if (!db.chatConversations) db.chatConversations = [];
    const conv = {
        id: 'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        username: username || 'مهمان',
        createdAt: new Date().toISOString(),
        status: 'open'
    };
    db.chatConversations.push(conv);
    writeDB(db);
    res.json(conv);
});

app.get('/api/chat/conversation/:id', async (req, res) => {
    const { id } = req.params;
    const { username } = req.query;
    const db = readDB();
    var messages = (db.chat || []).filter(function(m) {
        return m.conversationId === id;
    });
    messages.sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
    if (username && !messages.some(function(m) { return m.role === 'customer' && m.username === username; })) {
        messages = messages.filter(function(m) { return m.role === 'admin'; });
    }
    res.json(messages);
});

app.get('/api/chat/conversations', async (req, res) => {
    const { username } = req.query;
    const db = readDB();
    var convs = {};
    (db.chat || []).forEach(function(m) {
        if (!m.conversationId) return;
        if (!convs[m.conversationId]) {
            convs[m.conversationId] = {
                id: m.conversationId,
                username: m.username,
                createdAt: m.timestamp,
                lastMessage: m.text,
                lastTimestamp: m.timestamp,
                messageCount: 0
            };
        }
        convs[m.conversationId].lastMessage = m.text;
        convs[m.conversationId].lastTimestamp = m.timestamp;
        convs[m.conversationId].messageCount++;
    });
    var list = Object.keys(convs).map(function(k) { return convs[k]; });
    if (username) {
        list = list.filter(function(c) { return c.username === username; });
    }
    list.sort(function(a, b) { return new Date(b.lastTimestamp) - new Date(a.lastTimestamp); });
    res.json(list);
});

// --- RAWG Gaming API routes ---
const translationCache = new Map();
const TRANSLATION_CACHE_TTL = 1000 * 60 * 60 * 24 * 30;
const TRANSLATION_API = 'https://api.mymemory.translated.net/get';

async function translateToPersian(text) {
    if (!text || text.length < 3) return text;
    const lower = text.toLowerCase();
    if (/[\u0600-\u06FF]/.test(text)) return text;

    const cacheKey = crypto.createHash('sha1').update(text).digest('hex');
    const cached = translationCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) return cached.text;

    const langpair = 'en|fa';
    const url = `${TRANSLATION_API}?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${langpair}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        let translated = text;
        if (data.responseData && data.responseData.translatedText) {
            translated = data.responseData.translatedText;
        }
        translationCache.set(cacheKey, { text: translated, expiry: Date.now() + TRANSLATION_CACHE_TTL });
        return translated;
    } catch (error) {
        translationCache.set(cacheKey, { text: text, expiry: Date.now() + TRANSLATION_CACHE_TTL });
        return text;
    }
}

async function fetchFromRawg(p, params = {}) {
    const apiKey = process.env.RAW_API_KEY || process.env.RAWG_API_KEY;
    if (!apiKey || apiKey === 'your-rawg-api-key-here') {
        throw new Error('RAWG API key not configured');
    }
    const url = new URL(`https://api.rawg.io/api/${p}`);
    url.searchParams.set('key', apiKey);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, v);
        }
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const fetchOptions = { signal: controller.signal };
        const response = await fetch(url.toString(), fetchOptions);
        clearTimeout(timeout);
        if (!response.ok) {
            const errText = await response.text().catch(() => 'Unknown error');
            throw new Error(`RAWG API error ${response.status}: ${errText}`);
        }
        return await response.json();
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            throw new Error('RAWG API request timeout');
        }
        if (error.message.includes('API key is not found')) {
            throw new Error('RAWG API key not configured');
        }
        throw error;
    }
}

const MOCK_GENRES = [
    { id: 4, slug: 'action', name: 'اکشن', games_count: 50000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Action' },
    { id: 31, slug: 'adventure', name: 'ماجراجویی', games_count: 40000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Adventure' },
    { id: 17, slug: 'rpg', name: 'نقش‌آفرینی', games_count: 30000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=RPG' },
    { id: 9, slug: 'shooter', name: 'تیراندازی', games_count: 25000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Shooter' },
    { id: 10, slug: 'strategy', name: 'استراتژی', games_count: 20000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Strategy' },
    { id: 11, slug: 'simulation', name: 'شبیه‌سازی', games_count: 18000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Simulation' },
    { id: 15, slug: 'sports', name: 'ورزشی', games_count: 15000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Sports' },
    { id: 16, slug: 'racing', name: 'مسابقه‌ای', games_count: 12000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Racing' },
    { id: 28, slug: 'horror', name: 'هیجانی/ترسناک', games_count: 10000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Horror' },
    { id: 2, slug: 'fighting', name: 'جنگیدن', games_count: 8000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Fighting' },
    { id: 7, slug: 'puzzle', name: 'پازل', games_count: 9000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Puzzle' },
    { id: 3, slug: 'arcade', name: 'آرکید', games_count: 11000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Arcade' },
    { id: 5, slug: 'platformer', name: 'پلتفرمر', games_count: 7000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Platformer' },
    { id: 8, slug: 'sandbox', name: 'سندباکس', games_count: 6000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Sandbox' },
    { id: 14, slug: 'casual', name: 'مناسب همه', games_count: 35000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Casual' },
    { id: 24, slug: 'massively-multiplayer', name: 'چندنفره آنلاین', games_count: 5000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=MMO' },
    { id: 25, slug: 'board-games', name: 'بازی های تخته ای', games_count: 3000, image_background: 'https://placehold.co/600x400/164A41/FFF?text=Board+Games' },
];

const MOCK_PLATFORMS = [
    { id: 4, slug: 'pc', name: 'PC', image: null, image_background: null, year_start: null, year_end: null, games_count: 50000 },
    { id: 1, slug: 'xbox-one', name: 'Xbox One', image: null, image_background: null, year_start: null, year_end: null, games_count: 6000 },
    { id: 2, slug: 'playstation4', name: 'PlayStation 4', image: null, image_background: null, year_start: null, year_end: null, games_count: 7000 },
    { id: 3, slug: 'playstation5', name: 'PlayStation 5', image: null, image_background: null, year_start: null, year_end: null, games_count: 5000 },
    { id: 6, slug: 'xbox-series-x', name: 'Xbox Series X/S', image: null, image_background: null, year_start: null, year_end: null, games_count: 4000 },
    { id: 7, slug: 'nintendo-switch', name: 'Nintendo Switch', image: null, image_background: null, year_start: null, year_end: null, games_count: 8000 },
    { id: 8, slug: 'ios', name: 'iOS', image: null, image_background: null, year_start: null, year_end: null, games_count: 30000 },
    { id: 9, slug: 'android', name: 'Android', image: null, image_background: null, year_start: null, year_end: null, games_count: 25000 },
    { id: 10, slug: 'macos', name: 'macOS', image: null, image_background: null, year_start: null, year_end: null, games_count: 20000 },
    { id: 11, slug: 'linux', name: 'Linux', image: null, image_background: null, year_start: null, year_end: null, games_count: 15000 },
    { id: 12, slug: 'xbox-360', name: 'Xbox 360', image: null, image_background: null, year_start: null, year_end: null, games_count: 2000 },
    { id: 13, slug: 'playstation3', name: 'PlayStation 3', image: null, image_background: null, year_start: null, year_end: null, games_count: 3000 },
];

const MOCK_RATINGS = [
    { id: 5, slug: 'everyone', name: 'همه سنین', games_count: 20000 },
    { id: 4, slug: 'everyone-10-plus', name: '10 سال به بالا', games_count: 18000 },
    { id: 3, slug: 'teen', name: 'نوجوان', games_count: 15000 },
    { id: 2, slug: 'mature', name: '17 به بالا', games_count: 12000 },
    { id: 1, slug: 'adults-only', name: '18 به بالا', games_count: 500 },
    { id: 6, slug: 'rating-pending', name: 'در انتظار ارزیابی', games_count: 3000 },
];

const MOCK_GAME_IMAGES = {
    'cyberpunk-2077': 'https://placehold.co/600x800/164A41/FFF?text=Cyberpunk+2077',
    'the-witcher-3-wild-hunt': 'https://placehold.co/600x800/164A41/FFF?text=The+Witcher+3',
    'red-dead-redemption-2': 'https://placehold.co/600x800/164A41/FFF?text=RDR+2',
    'grand-theft-auto-v': 'https://placehold.co/600x800/164A41/FFF?text=GTA+V',
    'assassins-creed-valhalla': 'https://placehold.co/600x800/164A41/FFF?text=AC+Valhalla',
    'call-of-duty-modern-warfare-ii': 'https://placehold.co/600x800/164A41/FFF?text=COD+MW2',
    'elden-ring': 'https://placehold.co/600x800/164A41/FFF?text=Elden+Ring',
    'counter-strike-2': 'https://placehold.co/600x800/164A41/FFF?text=CS2',
    'dota-2': 'https://placehold.co/600x800/164A41/FFF?text=Dota+2',
    'apex-legends': 'https://placehold.co/600x800/164A41/FFF?text=Apex',
    'fortnite': 'https://placehold.co/600x800/164A41/FFF?text=Fortnite',
    'valorant': 'https://placehold.co/600x800/164A41/FFF?text=Valorant',
    'minecraft': 'https://placehold.co/600x800/164A41/FFF?text=Minecraft',
    'among-us': 'https://placehold.co/600x800/164A41/FFF?text=Among+Us',
    'fall-guys': 'https://placehold.co/600x800/164A41/FFF?text=Fall+Guys',
    'rocket-league': 'https://placehold.co/600x800/164A41/FFF?text=Rocket+League',
    'dead-by-daylight': 'https://placehold.co/600x800/164A41/FFF?text=DbD',
    'phasmophobia': 'https://placehold.co/600x800/164A41/FFF?text=Phasmophobia',
    'the-sims-4': 'https://placehold.co/600x800/164A41/FFF?text=Sims+4',
    'cities-skylines': 'https://placehold.co/600x800/164A41/FFF?text=Cities+Skylines',
    'stardew-valley': 'https://placehold.co/600x800/164A41/FFF?text=Stardew+Valley',
    'terraria': 'https://placehold.co/600x800/164A41/FFF?text=Terraria',
    'portal-2': 'https://placehold.co/600x800/164A41/FFF?text=Portal+2',
    'half-life-2': 'https://placehold.co/600x800/164A41/FFF?text=Half-Life+2',
    'left-4-dead-2': 'https://placehold.co/600x800/164A41/FFF?text=L4D2',
    'world-of-warcraft': 'https://placehold.co/600x800/164A41/FFF?text=WoW',
    'final-fantasy-xiv': 'https://placehold.co/600x800/164A41/FFF?text=FFXIV',
    'path-of-exile': 'https://placehold.co/600x800/164A41/FFF?text=Path+of+Exile',
    'destiny-2': 'https://placehold.co/600x800/164A41/FFF?text=Destiny+2',
    'overwatch-2': 'https://placehold.co/600x800/164A41/FFF?text=Overwatch+2',
    'rainbow-six-siege': 'https://placehold.co/600x800/164A41/FFF?text=R6+S',
    'hearthstone': 'https://placehold.co/600x800/164A41/FFF?text=Hearthstone',
    'garrys-mod': 'https://placehold.co/600x800/164A41/FFF?text=GMod',
    'unturned': 'https://placehold.co/600x800/164A41/FFF?text=Unturned',
    'subnautica': 'https://placehold.co/600x800/164A41/FFF?text=Subnautica',
    'outer-wilds': 'https://placehold.co/600x800/164A41/FFF?text=Outer+Wilds',
    'hades': 'https://placehold.co/600x800/164A41/FFF?text=Hades',
    'celeste': 'https://placehold.co/600x800/164A41/FFF?text=Celeste',
    'hollow-knight': 'https://placehold.co/600x800/164A41/FFF?text=Hollow+Knight',
    'dead-cells': 'https://placehold.co/600x800/164A41/FFF?text=Dead+Cells',
    'sekiro': 'https://placehold.co/600x800/164A41/FFF?text=Sekiro',
    'dark-souls-iii': 'https://placehold.co/600x800/164A41/FFF?text=Dark+Souls+3',
    'bloodborne': 'https://placehold.co/600x800/164A41/FFF?text=Bloodborne',
    'god-of-war': 'https://placehold.co/600x800/164A41/FFF?text=God+of+War',
    'spider-man': 'https://placehold.co/600x800/164A41/FFF?text=Spider-Man',
    'the-last-of-us': 'https://placehold.co/600x800/164A41/FFF?text=The+Last+of+Us',
    'uncharted-4': 'https://placehold.co/600x800/164A41/FFF?text=Uncharted+4',
    'horizon-zero-dawn': 'https://placehold.co/600x800/164A41/FFF?text=Horizon+Z',
    'ghost-of-tsushima': 'https://placehold.co/600x800/164A41/FFF?text=Ghost+of+Tsushima',
};

const SLUG_TO_TITLE = {
    'cyberpunk-2077': 'Cyberpunk 2077',
    'the-witcher-3-wild-hunt': 'The Witcher 3: Wild Hunt',
    'red-dead-redemption-2': 'Red Dead Redemption 2',
    'grand-theft-auto-v': 'Grand Theft Auto V',
    'assassins-creed-valhalla': 'Assassin\'s Creed Valhalla',
    'call-of-duty-modern-warfare-ii': 'Call of Duty: Modern Warfare II',
    'elden-ring': 'Elden Ring',
    'counter-strike-2': 'Counter-Strike 2',
    'dota-2': 'Dota 2',
    'apex-legends': 'Apex Legends',
    'fortnite': 'Fortnite',
    'valorant': 'Valorant',
    'minecraft': 'Minecraft',
    'among-us': 'Among Us',
    'fall-guys': 'Fall Guys',
    'rocket-league': 'Rocket League',
    'dead-by-daylight': 'Dead by Daylight',
    'phasmophobia': 'Phasmophobia',
    'the-sims-4': 'The Sims 4',
    'cities-skylines': 'Cities: Skylines',
    'stardew-valley': 'Stardew Valley',
    'terraria': 'Terraria',
    'portal-2': 'Portal 2',
    'half-life-2': 'Half-Life 2',
    'left-4-dead-2': 'Left 4 Dead 2',
    'world-of-warcraft': 'World of Warcraft',
    'final-fantasy-xiv': 'Final Fantasy XIV',
    'path-of-exile': 'Path of Exile',
    'destiny-2': 'Destiny 2',
    'overwatch-2': 'Overwatch 2',
    'rainbow-six-siege': 'Rainbow Six Siege',
    'hearthstone': 'Hearthstone',
    'garrys-mod': 'Garry\'s Mod',
    'unturned': 'Unturned',
    'subnautica': 'Subnautica',
    'outer-wilds': 'Outer Wilds',
    'hades': 'Hades',
    'celeste': 'Celeste',
    'hollow-knight': 'Hollow Knight',
    'dead-cells': 'Dead Cells',
    'sekiro': 'Sekiro',
    'dark-souls-iii': 'Dark Souls III',
    'bloodborne': 'Bloodborne',
    'god-of-war': 'God of War',
    'spider-man': 'Spider-Man',
    'the-last-of-us': 'The Last of Us',
    'uncharted-4': 'Uncharted 4',
    'horizon-zero-dawn': 'Horizon Zero Dawn',
    'ghost-of-tsushima': 'Ghost of Tsushima',
};

const MOCK_GAME_DATA = {
    'cyberpunk-2077': { genres: ['action', 'rpg'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.1, released: '2020-12-10', developers: ['CD Projekt Red'], publishers: ['CD Projekt'], playtime: 45, description_raw: 'بازی نقش‌آفرینی اکشن در فضای علمی‌تخیلی شهر نیایت‌سیتی. شما در نقش V، یک سرباز fortunato، باید در این شهر هیپنوتیک و پر از رازها بر اساس انتخاب‌های خود زندگی کنید.' },
    'the-witcher-3-wild-hunt': { genres: ['action', 'rpg', 'adventure'], platforms: ['pc', 'playstation5', 'xbox-series-x', 'nintendo-switch'], rating: 4.8, released: '2015-05-19', developers: ['CD Projekt Red'], publishers: ['CD Projekt'], playtime: 60, description_raw: 'گریت Gard explores the vast open world, slaying monsters and making moral choices that shape the world around him. The last of the witchers, Geralt of Rivia, embarks on an epic journey to find his adopted daughter.' },
    'red-dead-redemption-2': { genres: ['action', 'adventure'], platforms: ['pc', 'playstation4', 'xbox-one'], rating: 4.7, released: '2018-10-26', developers: ['Rockstar Games'], publishers: ['Rockstar Games'], playtime: 55, description_raw: 'داستان آرثر مورگان، عضو گروه خشن دران و ماجراجویی‌های او در دوران گمشدگان آمریکا.' },
    'grand-theft-auto-v': { genres: ['action', 'adventure'], platforms: ['pc', 'playstation5', 'playstation4', 'xbox-series-x', 'xbox-one'], rating: 4.5, released: '2013-09-17', developers: ['Rockstar North'], publishers: ['Rockstar Games'], playtime: 40, description_raw: 'سه دزد حرفه‌ای در شهر لو州 سان آندئاس با فرار از پلیس، شاهکارهای بزرگ و خیخون‌های بزرگ سعی می‌کنند در این شهر بی‌رحمombsleben.' },
    'assassins-creed-valhalla': { genres: ['action', 'rpg', 'adventure'], platforms: ['pc', 'playstation5', 'playstation4', 'xbox-series-x', 'xbox-one'], rating: 4.2, released: '2020-11-10', developers: ['Ubisoft'], publishers: ['Ubisoft'], playtime: 50, description_raw: 'ایوور، وایکینگ نتره، به دنیای نبردهای بزرگ، واپایشی و کشف دنیای انگلستان در قرن نهم می‌سپارد.' },
    'call-of-duty-modern-warfare-ii': { genres: ['shooter', 'action'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.3, released: '2022-10-28', developers: ['Infinity Ward'], publishers: ['Activision'], playtime: 30, description_raw: 'بازی تیراندازی از نظر اولperson از سری Call of Duty با داستان کوتاه و حالت‌های چندنفره آنلاین پر از اکشن.' },
    'elden-ring': { genres: ['action', 'rpg'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.7, released: '2022-02-25', developers: ['FromSoftware'], publishers: ['Bandai Namco'], playtime: 55, description_raw: 'بازی نقش‌آفرینی اکشن open-world از سازنده Dark Souls با دنیایvast و مبارزات چالش‌برانگیز.' },
    'counter-strike-2': { genres: ['shooter', 'action'], platforms: ['pc'], rating: 4.4, released: '2023-03-27', developers: ['Valve'], publishers: ['Valve'], playtime: 100, description_raw: 'بازی تیراندازی competitive first-person که جایگزین Global Offensive شد و با گرافیک بهبود یافته عرضه شد.' },
    'dota-2': { genres: ['strategy', 'action'], platforms: ['pc'], rating: 4.5, released: '2013-07-09', developers: ['Valve'], publishers: ['Valve'], playtime: 200, description_raw: 'بازی استراتژی MOBA محبوب دو团队 که بازیکنان در دو تیم hero-based با هم مبارزه می‌کنند.' },
    'apex-legends': { genres: ['shooter', 'action'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.3, released: '2019-02-04', developers: ['Respawn Entertainment'], publishers: ['Electronic Arts'], playtime: 40, description_raw: 'بازی battle royale free-to-play با شخصیت‌های legend دارای قدرت‌های منحصربه‌فرد و game-play سریع.' },
    'fortnite': { genres: ['shooter', 'casual'], platforms: ['pc', 'playstation5', 'xbox-series-x', 'nintendo-switch', 'ios', 'android'], rating: 4.2, released: '2017-07-25', developers: ['Epic Games'], publishers: ['Epic Games'], playtime: 50, description_raw: 'بازی battle royale محبوب با ساختمان‌سازی در لحظه، رویدادهای فصلانه و همکاری با فیلم‌ها و شخصیت‌های معروف.' },
    'valorant': { genres: ['shooter', 'action'], platforms: ['pc'], rating: 4.4, released: '2020-06-02', developers: ['Riot Games'], publishers: ['Riot Games'], playtime: 35, description_raw: 'بازی تیراندازی taktic multiplayer 5v5 با agentهای دارای abilityهای unique.' },
    'minecraft': { genres: ['sandbox', 'casual'], platforms: ['pc', 'playstation5', 'xbox-series-x', 'nintendo-switch', 'ios', 'android'], rating: 4.8, released: '2011-11-18', developers: ['Mojang Studios'], publishers: ['Mojang Studios'], playtime: 100, description_raw: 'بازی sandbox با building، exploring و surviving در دنیای procedurally-generated از بلوک‌ها.' },
    'among-us': { genres: ['casual', 'strategy'], platforms: ['pc', 'playstation5', 'xbox-series-x', 'nintendo-switch', 'ios', 'android'], rating: 4.3, released: '2018-11-16', developers: ['InnerSloth'], publishers: ['InnerSloth'], playtime: 15, description_raw: 'بازی party multiplayer که بازیکنان در یک سفینه فضایی هستند و باید imposter را پیدا کنند.' },
    'fall-guys': { genres: ['casual', 'sports'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.1, released: '2020-08-04', developers: ['Mediatonic'], publishers: ['Devolver Digital'], playtime: 20, description_raw: 'بازی battle royale comedy با شخصیت‌های jelly bean که در موانع بی‌رحمانه شرکت می‌کنند.' },
    'rocket-league': { genres: ['sports', 'racing'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.4, released: '2015-07-07', developers: ['Psyonix'], publishers: ['Psyonix'], playtime: 30, description_raw: 'بازی ترکیبی فوتبال با ماشین‌های rc که بازیکنان با خودروهایشان توپ را به دروازه حریف می‌برند.' },
    'dead-by-daylight': { genres: ['horror', 'action'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.2, released: '2016-06-14', developers: ['Behaviour Interactive'], publishers: ['Behaviour Interactive'], playtime: 40, description_raw: 'بازی horror asymmetric multiplayer که بازیکنان به دو گروه killera و survivor تقسیم می‌شوند.' },
    'phasmophobia': { genres: ['horror', 'casual'], platforms: ['pc'], rating: 4.5, released: '2020-09-18', developers: ['Kinetic Games'], publishers: ['Kinetic Games'], playtime: 25, description_raw: 'بازی terror cooperative که بازیکنان به عنوانGhost Investigators وارد خانه‌های haunted می‌شوند.' },
    'the-sims-4': { genres: ['simulation'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.3, released: '2014-09-02', developers: ['Maxis'], publishers: ['Electronic Arts'], playtime: 50, description_raw: 'بازی شبیه‌سازی زندگی که بازیکنان کنترل Sims را به دست می‌گیرند و زندگی مجازی آن‌ها را مدیریت می‌کنند.' },
    'cities-skylines': { genres: ['simulation', 'strategy'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.6, released: '2015-03-10', developers: ['Colossal Order'], publishers: ['Paradox Interactive'], playtime: 60, description_raw: 'بازی شبیه‌سازی مدیریت شهر با طراحی معماری و مدیریت ترافیک، حمل و نقل و خدمات عمومی.' },
    'stardew-valley': { genres: ['simulation', 'casual'], platforms: ['pc', 'playstation5', 'xbox-series-x', 'nintendo-switch', 'ios', 'android'], rating: 4.8, released: '2016-02-26', developers: ['ConcernedApe'], publishers: ['ConcernedApe'], playtime: 60, description_raw: 'بازی farming simulation با المان‌های RPG که بازیکنان از شهر به مزرعه می‌روند و کشت و旌 می‌کنند.' },
    'terraria': { genres: ['sandbox', 'adventure'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.7, released: '2011-05-16', developers: ['Re-Logic'], publishers: ['Re-Logic'], playtime: 50, description_raw: 'بازی sandbox 2D با building، exploring و fighting در دنیای procedural generated.' },
    'portal-2': { genres: ['puzzle'], platforms: ['pc', 'playstation3'], rating: 4.8, released: '2011-04-18', developers: ['Valve'], publishers: ['Valve'], playtime: 10, description_raw: 'بازی پازل first-person که بازیکنان با استفاده از پرتگاه‌ها در آزمایشگاه Aperture Science چالش‌های智力 را حل می‌کنند.' },
    'half-life-2': { genres: ['shooter', 'action'], platforms: ['pc'], rating: 4.7, released: '2004-11-16', developers: ['Valve'], publishers: ['Valve'], playtime: 12, description_raw: 'بازی تیراندازی first-person که داستان Gordon Freeman را دنبال می‌کند و از نظر gameplay تاثیرگذار بود.' },
    'left-4-dead-2': { genres: ['shooter', 'horror'], platforms: ['pc', 'xbox-360'], rating: 4.5, released: '2009-11-17', developers: ['Valve'], publishers: ['Valve'], playtime: 15, description_raw: 'بازی terror cooperative first-person که بازیکنان به عنوان بازماندگان باید در برابر هجوم zombies فرار کنند.' },
    'world-of-warcraft': { genres: ['rpg', 'mmo'], platforms: ['pc'], rating: 4.5, released: '2004-11-23', developers: ['Blizzard Entertainment'], publishers: ['Blizzard Entertainment'], playtime: 200, description_raw: 'بازی MMORPG محبوب که بازیکنان در دنیای Azeroth quest می‌کنند و در dungeons و raids شرکت می‌کنند.' },
    'final-fantasy-xiv': { genres: ['rpg', 'mmo'], platforms: ['pc', 'playstation5'], rating: 4.6, released: '2013-08-27', developers: ['Square Enix'], publishers: ['Square Enix'], playtime: 150, description_raw: 'بازی MMORPG با داستان غنی و combat سیستم قوی که بازیکنان را به دنیای Eorzea دعوت می‌کند.' },
    'path-of-exile': { genres: ['rpg', 'action'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.5, released: '2013-10-23', developers: ['Grinding Gear Games'], publishers: ['Grinding Gear Games'], playtime: 80, description_raw: 'بازی action RPG free-to-play با سیستم skill tree گسترده و dark fantasy atmosphere.' },
    'destiny-2': { genres: ['shooter', 'rpg', 'mmo'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.3, released: '2017-09-06', developers: ['Bungie'], publishers: ['Bungie'], playtime: 60, description_raw: 'بازی shooter looter با المان‌های MMO و RPG که بازیکنان به عنوان Guardians مبارزه می‌کنند.' },
    'overwatch-2': { genres: ['shooter', 'action'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.2, released: '2022-10-04', developers: ['Blizzard Entertainment'], publishers: ['Blizzard Entertainment'], playtime: 30, description_raw: 'بازی تیراندازی hero-based 5v5 با شخصیت‌های colorful و game play سریع.' },
    'rainbow-six-siege': { genres: ['shooter', 'strategy'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.4, released: '2015-12-01', developers: ['Ubisoft'], publishers: ['Ubisoft'], playtime: 50, description_raw: 'بازی تیراندازی taktic multiplayer که بازیکنان به عنوان attacker یا defender در عملیات خاص شرکت می‌کنند.' },
    'hearthstone': { genres: ['strategy', 'casual'], platforms: ['pc', 'ios', 'android'], rating: 4.3, released: '2014-03-11', developers: ['Blizzard Entertainment'], publishers: ['Blizzard Entertainment'], playtime: 30, description_raw: 'بازی کارت strategic free-to-play از Blizzard با Heroهای Warcraft و deck-building.' },
    'garrys-mod': { genres: ['sandbox', 'casual'], platforms: ['pc'], rating: 4.5, released: '2006-11-29', developers: ['Facepunch Studios'], publishers: ['Valve'], playtime: 40, description_raw: 'بازی sandbox физиica که بازیکنان می‌توانند با ابزارهای مختلف objectهای dynamically manipulate کنند.' },
    'unturned': { genres: ['sandbox', 'horror'], platforms: ['pc'], rating: 4.1, released: '2014-07-07', developers: ['Smartly Dressed Games'], publishers: ['Smartly Dressed Games'], playtime: 30, description_raw: 'بازی survival sandbox با فروسی که بازیکنان باید در برابر zombies و دیگر بازیکنان زنده بمانند.' },
    'subnautica': { genres: ['adventure', 'survival'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.6, released: '2018-01-23', developers: ['Unknown Worlds Entertainment'], publishers: ['Unknown Worlds Entertainment'], playtime: 35, description_raw: 'بازی adventure survival submarine در دنیای زیر آب بیگانگان با کشف و ساخت تجهیزات.' },
    'outer-wilds': { genres: ['adventure', 'puzzle'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.7, released: '2019-05-28', developers: ['Mobius Digital'], publishers: ['Annapurna Interactive'], playtime: 20, description_raw: 'بازی mystery exploration که بازیکنان در یک منظومه شمسی کوچک با time loop سفر می‌کنند.' },
    'hades': { genres: ['rpg', 'action'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.7, released: '2020-09-17', developers: ['Supergiant Games'], publishers: ['Supergiant Games'], playtime: 25, description_raw: 'بازی roguelike dungeon crawler با داستان یونانی که بازیکنان به عنوان Zagreus از Underworld فرار می‌کنند.' },
    'celeste': { genres: ['platformer', 'casual'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.6, released: '2018-01-25', developers: ['Maddy Makes Games'], publishers: ['Maddy Makes Games'], playtime: 12, description_raw: 'بازی platformer دشوار که بازیکنان به作为 Madeline از کوه Celeste بالا می‌روند.' },
    'hollow-knight': { genres: ['adventure', 'action'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.7, released: '2017-02-24', developers: ['Team Cherry'], publishers: ['Team Cherry'], playtime: 30, description_raw: 'بازی metroidvania action-adventure در دنیای underground Hallownest با combat چالش‌برانگیز.' },
    'dead-cells': { genres: ['action', 'roguelike'], platforms: ['pc', 'playstation5', 'xbox-series-x'], rating: 4.5, released: '2018-08-07', developers: ['Motion Twin'], publishers: ['Motion Twin'], playtime: 25, description_raw: 'بازی roguelike metroidvania با combat سریع وProc-gen levels.' },
    'sekiro': { genres: ['action', 'adventure'], platforms: ['pc', 'playstation4'], rating: 4.6, released: '2019-03-22', developers: ['FromSoftware'], publishers: ['Activision'], playtime: 40, description_raw: 'بازی action-adventure dificil از سازنده Dark Souls با combat مبتنی بر deflection و maze fighting.' },
    'dark-souls-iii': { genres: ['action', 'rpg'], platforms: ['pc', 'playstation4', 'xbox-one'], rating: 4.7, released: '2016-04-12', developers: ['FromSoftware'], publishers: ['Bandai Namco'], playtime: 45, description_raw: 'بازی action RPG dificil با دنیای dark fantasy و combat RwS-oriented که به finale سری Dark Souls منجر شد.' },
    'bloodborne': { genres: ['action', 'horror'], platforms: ['playstation4'], rating: 4.8, released: '2015-03-24', developers: ['FromSoftware'], publishers: ['Sony Interactive Entertainment'], playtime: 40, description_raw: 'بازی action RPG horrific برای PS4 با combat سریع و atmosphere گاتی از(vectorized).' },
    'god-of-war': { genres: ['action', 'adventure'], platforms: ['pc', 'playstation5'], rating: 4.8, released: '2018-04-20', developers: ['Santa Monica Studio'], publishers: ['Sony Interactive Entertainment'], playtime: 35, description_raw: 'داستان Kratos و پسرش Atreus در ماجراجویی épisk در mitología نوردی با combat axe.' },
    'spider-man': { genres: ['action', 'adventure'], platforms: ['pc', 'playstation5'], rating: 4.6, released: '2023-10-20', developers: ['Insomniac Games'], publishers: ['Sony Interactive Entertainment'], playtime: 30, description_raw: 'بازی action-adventure Spider-Man با swinging در Manhattan و fight با Villains معروف.' },
    'the-last-of-us': { genres: ['action', 'adventure', 'horror'], platforms: ['pc', 'playstation5'], rating: 4.9, released: '2023-03-28', developers: ['Naughty Dog'], publishers: ['Sony Interactive Entertainment'], playtime: 25, description_raw: 'داستان Joel و Ellie در دنیای post-apocalyptic با zombies و انتخاب‌های維持 moral dificiles.' },
    'uncharted-4': { genres: ['action', 'adventure'], platforms: ['pc', 'playstation5'], rating: 4.6, released: '2016-05-10', developers: ['Naughty Dog'], publishers: ['Sony Interactive Entertainment'], playtime: 15, description_raw: 'بازی action-adventure با Drake Drayton که در حال کشفگشت وfight با شکارچیان873 booty است.' },
    'horizon-zero-dawn': { genres: ['action', 'rpg'], platforms: ['pc', 'playstation5'], rating: 4.7, released: '2017-02-28', developers: ['Guerrilla Games'], publishers: ['Sony Interactive Entertainment'], playtime: 35, description_raw: 'بازی action-RPG open-world با Aloy در دنیای post-apocalyptic که ماشین‌های biologic حیرت‌انگیز وجود دارد.' },
    'ghost-of-tsushima': { genres: ['action', 'adventure'], platforms: ['playstation5'], rating: 4.7, released: '2020-07-17', developers: ['Sucker Punch Productions'], publishers: ['Sony Interactive Entertainment'], playtime: 30, description_raw: 'بازی action-adventure در ژاپن دوره سامورایی با Jin Sakai که باید قبیله mongol را دفع کند.' },
};

function getMockGameData(slug) {
    const title = SLUG_TO_TITLE[slug];
    if (!title) return null;
    const info = MOCK_GAME_DATA[slug];
    if (!info) return null;
    const id = Object.keys(SLUG_TO_TITLE).indexOf(slug) + 1;
    return {
        id: id,
        slug: slug,
        name: title,
        background_image: MOCK_GAME_IMAGES[slug] || 'https://placehold.co/600x400/164A41/FFF?text=' + encodeURIComponent(title),
        rating: info.rating,
        released: info.released,
        genres: info.genres.map(g => MOCK_GENRES.find(mg => mg.slug === g)).filter(Boolean),
        platforms: info.platforms.map(p => ({ platform: { id: MOCK_PLATFORMS.find(mp => mp.slug === p).id, slug: p, name: MOCK_PLATFORMS.find(mp => mp.slug === p).name } })),
        description_raw: info.description_raw,
        developers: info.developers.map(d => ({ name: d })),
        publishers: info.publishers.map(p => ({ name: p })),
        playtime: info.playtime,
        rating_top: 3,
        ratings_count: 5000 + id * 100,
        updated: new Date().toISOString(),
        stores: [
            { store_id: 1, url: 'https://store.steampowered.com', store: { id: 1, name: 'Steam', slug: 'steam', domain: 'store.steampowered.com' } },
            { store_id: 2, url: 'https://www.epicgames.com', store: { id: 2, name: 'Epic Games', slug: 'epic-games', domain: 'epicgames.com' } },
        ],
        saturated_color: '#164A41',
        dominant_color: '#164A41',
    };
}

function getFallbackRawg(p, params) {
    const page = parseInt(params.page) || 1;
    const pageSize = parseInt(params.page_size) || 20;
    const search = params.search || '';
    const sort = params.ordering || params.sort || '';
    const genre = params.genres || '';
    const platform = params.platforms || '';

    if (p === 'genres') {
        return { count: MOCK_GENRES.length, next: null, previous: null, results: MOCK_GENRES };
    }

    if (p === 'platforms') {
        return { count: MOCK_PLATFORMS.length, next: null, previous: null, results: MOCK_PLATFORMS };
    }

    if (p === 'ratings') {
        return { results: MOCK_RATINGS };
    }

    if (p.startsWith('games/') && !p.endsWith('/screenshots') && !p.endsWith('/movies') && !p.endsWith('/stores') && !p.endsWith('/achievements')) {
        const slug = p.replace(/^games\//, '');
        const data = getMockGameData(slug);
        if (data) return data;
        return { error: 'Game not found' };
    }

    if (p.endsWith('/screenshots')) {
        return { count: 3, next: null, previous: null, results: [
            { id: 1, image: 'https://placehold.co/1920x1080/164A41/FFF?text=Screenshot+1', width: 1920, height: 1080 },
            { id: 2, image: 'https://placehold.co/1920x1080/164A41/FFF?text=Screenshot+2', width: 1920, height: 1080 },
            { id: 3, image: 'https://placehold.co/1920x1080/164A41/FFF?text=Screenshot+3', width: 1920, height: 1080 },
        ]};
    }

    if (p.endsWith('/movies')) {
        return { count: 2, next: null, previous: null, results: [
            { id: 1, name: 'Trailer', preview: 'https://placehold.co/640x360/164A41/FFF?text=Trailer', data: [{ quality: '1080p', FileType: 'mp4', width: 1920, height: 1080, link: '#', size: 50000000 }] },
        ]};
    }

    if (p.endsWith('/stores')) {
        return { count: 2, next: null, previous: null, results: [
            { store_id: 1, url: 'https://store.steampowered.com', store: { id: 1, name: 'Steam', slug: 'steam', domain: 'store.steampowered.com', image_background: null } },
            { store_id: 2, url: 'https://www.epicgames.com', store: { id: 2, name: 'Epic Games Store', slug: 'epic-games', domain: 'epicgames.com', image_background: null } },
        ]};
    }

    if (p.endsWith('/achievements')) {
        return { count: 3, next: null, previous: null, results: [
            { id: 1, name: ' achievment', description: 'First achievement', image: 'https://placehold.co/64x64/f97316/FFF?text=A', url: null },
            { id: 2, name: 'Second achievement', description: 'Second achievement', image: 'https://placehold.co/64x64/3b82f6/FFF?text=B', url: null },
        ]};
    }

    const allGames = Object.entries(SLUG_TO_TITLE).map(([slug, title], idx) => {
        const slugKey = slug;
    const info = getMockGameData(slugKey);
    const genres = info ? [...info.genres] : [];
    const platforms = info ? [...info.platforms] : [];
    return {
        id: idx + 1,
        slug: slugKey,
        name: title,
        background_image: MOCK_GAME_IMAGES[slug] || 'https://placehold.co/600x400/164A41/FFF?text=' + encodeURIComponent(title),
        rating: info ? info.rating : 3 + Math.random() * 2,
        released: info ? info.released : '2020-01-01',
        genres: genres,
        platforms: platforms,
        description_raw: info ? info.description_raw : 'توصیف در دسترس نیست.',
        developers: info ? info.developers : [{ name: 'Unknown' }],
        publishers: info ? info.publishers : [{ name: 'Unknown' }],
            playtime: info ? info.playtime : 20,
            rating_top: 3,
            ratings_count: 1000 + idx * 100,
            updated: new Date().toISOString(),
            stores: [
                { store_id: 1, url: 'https://store.steampowered.com', store: { id: 1, name: 'Steam', slug: 'steam', domain: 'store.steampowered.com' } },
            ],
            saturated_color: '#164A41',
            dominant_color: '#164A41',
        };
    });

    let filtered = allGames;
    if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(g => g.name.toLowerCase().includes(q) || (g.genres || []).some(g => g.name.includes(q)));
    }
    if (genre) {
        filtered = filtered.filter(g => (g.genres || []).some(g => g.slug === genre));
    }
    if (platform) {
        filtered = filtered.filter(g => (g.platforms || []).some(p => p.platform && (p.platform.id === platform || p.platform.slug === platform)));
    }

    if (sort) {
        switch (sort) {
            case '-rating':
                filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
                break;
            case '-added':
                filtered.sort((a, b) => b.id - a.id);
                break;
            case '-released':
                filtered.sort((a, b) => new Date(b.released || '2020-01-01') - new Date(a.released || '2020-01-01'));
                break;
        }
    }

    filtered = filtered.filter(g => (g.rating || 0) >= 3);

    if (sort === '-released') {
        const currentYear = new Date().getFullYear();
        filtered = filtered.filter(g => {
            if (!g.released) return false;
            const releaseYear = new Date(g.released).getFullYear();
            return releaseYear >= currentYear - 10 && releaseYear <= currentYear;
        });
    }

    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    return {
        count: filtered.length,
        next: page * pageSize < filtered.length ? `?page=${page + 1}&page_size=${pageSize}${search ? '&search=' + encodeURIComponent(search) : ''}` : null,
        previous: page > 1 ? `?page=${page - 1}&page_size=${pageSize}${search ? '&search=' + encodeURIComponent(search) : ''}` : null,
        results: paged,
    };
}

function rawgProxy(p, req, res) {
    const params = {};
    for (const [key, value] of Object.entries(req.query)) {
        if (key !== 'key') params[key] = value;
    }
    const cacheKey = getCacheKey(p, params);
    const cached = getFromCache(cacheKey);
    if (cached) {
        res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=60');
        res.json(cached);
        return;
    }
    fetchFromRawg(p, params)
        .then(data => {
            setCache(cacheKey, data);
            res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=60');
            res.json(data);
            prefetchImages(data);
        })
        .catch(err => {
            console.error('RAWG proxy error:', err.message);
            const fallback = getFallbackRawg(p, params, req);
            if (!err.message.includes('not configured')) {
                console.log('Using fallback data for ' + p);
            }
            res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=60');
            res.json(fallback);
            prefetchImages(fallback);
        });
}

async function fetchImageToCache(url) {
    const cacheKey = crypto.createHash('sha1').update(url).digest('hex');
    if (imageCache.has(cacheKey)) return;

    try {
        const response = await fetch(url);
        if (!response.ok) return;
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (imageCache.size >= IMAGE_CACHE_SIZE) {
            const oldestKey = imageCache.keys().next().value;
            if (oldestKey !== undefined) imageCache.delete(oldestKey);
        }
        imageCache.set(cacheKey, {
            buffer: buffer,
            contentType: contentType,
            expiry: Date.now() + IMAGE_CACHE_TTL
        });
    } catch (error) {
        // Silently fail prefetch
    }
}

function prefetchImages(data) {
    const images = [];
    if (data.results && Array.isArray(data.results)) {
        data.results.forEach(item => {
            if (item.background_image) images.push(item.background_image);
            if (item.background_image_additional) images.push(item.background_image_additional);
        });
    }
    if (data.background_image) images.push(data.background_image);
    if (data.screenshots && Array.isArray(data.screenshots)) {
        data.screenshots.forEach(s => { if (s.image) images.push(s.image); });
    }
    const unique = [...new Set(images)].slice(0, 30);
    Promise.allSettled(unique.map(url => fetchImageToCache(url).catch(() => {})));
}

const imageCache = new Map();
const IMAGE_CACHE_SIZE = 200;
const IMAGE_CACHE_TTL = 1000 * 60 * 60 * 24;

app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('Missing url parameter');
    }

    const cacheKey = crypto.createHash('sha1').update(imageUrl).digest('hex');
    const cached = imageCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(cached.buffer);
    }

    try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error('Failed to fetch image: ' + response.status);
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (imageCache.size >= IMAGE_CACHE_SIZE) {
            const oldestKey = imageCache.keys().next().value;
            if (oldestKey !== undefined) imageCache.delete(oldestKey);
        }

        imageCache.set(cacheKey, {
            buffer: buffer,
            contentType: contentType,
            expiry: Date.now() + IMAGE_CACHE_TTL
        });

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (error) {
        console.error('Image proxy error:', error.message, error.stack);
        const fallbackSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect fill="#164A41" width="400" height="200"/><text fill="#fff" font-family="Arial" font-size="16" x="200" y="95" text-anchor="middle">تصویر موجود نیست</text><text fill="#999" font-family="Arial" font-size="12" x="200" y="125" text-anchor="middle">Image unavailable</text></svg>';
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(fallbackSvg);
    }
});

const WARMUP_SLUGS = [
    'cyberpunk-2077', 'the-witcher-3-wild-hunt', 'red-dead-redemption-2',
    'grand-theft-auto-v', 'elden-ring', 'minecraft', 'fortnite',
    'counter-strike-2', 'dota-2', 'apex-legends', 'valorant',
    'call-of-duty-modern-warfare-ii', 'assassins-creed-valhalla',
    'the-last-of-us', 'god-of-war', 'spider-man', 'ghost-of-tsushima',
    'portal-2', 'half-life-2', 'left-4-dead-2'
];

async function warmupImageCache() {
    const urls = [];
    for (const slug of WARMUP_SLUGS) {
        const data = getMockGameData(slug);
        if (data && data.background_image) urls.push(data.background_image);
    }
    const unique = [...new Set(urls)].slice(0, 20);
    const promises = unique.map(url => fetchImageToCache(url).catch(() => {}));
    await Promise.allSettled(promises);
    console.log(`Image cache warmed up with ${unique.length} images`);
}

app.get('/api/warmup', async (req, res) => {
    warmupImageCache().then(() => res.json({ status: 'warmed' })).catch(() => res.json({ status: 'error' }));
});

app.get('/api/games/search', rateLimit, (req, res) => {
     rawgProxy('games', req, res);
 });

const GAMEBRAIN_API_KEY = process.env.GAMEBRAIN_API_KEY || '65d9d9e4d9eb4edc8866ac23d7749548';
const GAMEBRAIN_BASE = 'https://api.gamebrain.co/v1';
const gamebrainCache = new Map();

async function fetchFromGamebrain(path, params) {
    const cacheKey = 'gb:' + path + ':' + JSON.stringify(params || {});
    const cached = gamebrainCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
        return cached.data;
    }

    const url = new URL(GAMEBRAIN_BASE + path);
    Object.entries(params || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const response = await fetch(url.toString(), {
            headers: { 'x-api-key': GAMEBRAIN_API_KEY, 'Accept': 'application/json' },
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error('Gamebrain error ' + response.status + ': ' + text.slice(0, 200));
        }
        const data = await response.json();
        gamebrainCache.set(cacheKey, { data, expiry: Date.now() + 1000 * 60 * 60 });
        return data;
    } catch (error) {
        clearTimeout(timeout);
        throw error;
    }
}

app.get('/api/games/news', rateLimit, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=120');
        const slugs = Object.keys(MOCK_GAME_DATA).slice(0, 8);
        const newsItems = [];
        const seen = new Set();
        for (const slug of slugs) {
            try {
                const search = await fetchFromGamebrain('/v1/games/suggestions', { query: slug, limit: 1 });
                const item = (search.results && search.results[0]) || null;
                if (!item || !item.id) continue;
                const gid = String(item.id);
                if (seen.has(gid)) continue;
                seen.add(gid);
                const news = await fetchFromGamebrain(`/v1/games/${gid}/news`, { limit: 3 });
                const articles = Array.isArray(news) ? news : (news.results || []);
                articles.forEach(article => {
                    newsItems.push({
                        game: item.name || MOCK_GAME_DATA[slug]?.title || slug,
                        game_image: item.image || '',
                        title: article.title || article.name || 'خبر',
                        snippet: article.snippet || article.description || '',
                        link: article.url || article.link || (item.link || ''),
                        date: article.date || article.published_at || ''
                    });
                });
            } catch (e) {
                console.warn('Gamebrain news skip', slug, e.message);
            }
        }
        newsItems.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        res.json({ results: newsItems.slice(0, 30) });
    } catch (error) {
        console.error('Gamebrain news error:', error.message);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({ results: [] });
    }
});

app.get('/api/games/:slug', rateLimit, (req, res) => {
     rawgProxy(`games/${req.params.slug}`, req, res);
 });

app.get('/api/games/:slug/screenshots', rateLimit, (req, res) => {
     rawgProxy(`games/${req.params.slug}/screenshots`, req, res);
 });

app.get('/api/games/:slug/movies', rateLimit, (req, res) => {
     rawgProxy(`games/${req.params.slug}/movies`, req, res);
 });

app.get('/api/games/:slug/achievements', rateLimit, (req, res) => {
     rawgProxy(`games/${req.params.slug}/achievements`, req, res);
 });

    app.get('/api/ratings', rateLimit, (req, res) => {
        rawgProxy('ratings', req, res);
    });

    app.get('/api/genres', rateLimit, (req, res) => {
        rawgProxy('genres', req, res);
    });

    app.get('/api/games/:slug/reddit', rateLimit, (req, res) => {
        rawgProxy(`games/${req.params.slug}/reddit`, req, res);
    });

    const METACRITIC_PLATFORMS = {
        'playstation': 'playstation-4',
        'ps4': 'playstation-4',
        'xbox': 'xbox-one',
        'xbox-one': 'xbox-one',
        'nintendo': 'switch',
        'switch': 'switch',
        'pc': 'pc',
        'mac': 'pc',
        'linux': 'pc',
        'ios': 'ios',
        'android': 'android',
        'xbox-series-x': 'xbox-series-x',
        'playstation-5': 'playstation-5'
    };

    function getMetacriticPlatformUrl(rawgPlatformSlug) {
        const base = String(rawgPlatformSlug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
        return METACRITIC_PLATFORMS[base] || 'playstation-4';
    }

    function parseMetacriticPage(html, gameName) {
        const result = { metascore: null, userscore: null, critic_reviews: null, user_reviews: null };
        if (!html) return result;

        const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const extractValue = (regex, str, group) => {
            group = group || 1;
            const m = str.match(regex);
            return m ? m[group] : null;
        };

        const gameNameEsc = escapeRegExp(gameName || '');
        const namePattern = gameNameEsc.length > 3 ? gameNameEsc : '(?:[^<]{3,120})';

        let metascoreMatch = null;
        const metascorePatterns = [
            new RegExp('class="metascore_w(?:all| xl) game"[^>]*>\\s*(?:<span[^>]*>)?\\s*<([0-9]{1,2})', 'i'),
            new RegExp(`data-qa=["']metascore["'].*?<span[^>]*>([0-9]{1,2})`, 'is'),
            new RegExp(`metascore[^>]*>\\s*<([0-9]{1,2})`, 'i'),
            new RegExp(`class="score[^"]*"\\s+id="game[^"]*"[^>]*>\\s*([0-9]{1,2})`, 'i'),
            new RegExp(`product_rating[^>]*>\\s*<span[^>]*>([0-9]{1,2})`, 'i'),
            new RegExp(`metascore.*?([0-9]{1,2}).*?out of 100`, 'is'),
            new RegExp(`<span[^>]*class="[^"]*metascore[^"]*"[^>]*>\\s*([0-9]{1,2})\\s*</span>`, 'i'),
            new RegExp(`"metascore":\s*"([0-9]{1,2})"`, 'i'),
            new RegExp(`metascore[^0-9]*([0-9]{1,2})`, 'i'),
            new RegExp(`ratingValue["']?\s*[:=]\s*["']?([0-9]{1,2})`, 'i'),
        ];

        for (const pattern of metascorePatterns) {
            const m = html.match(pattern);
            if (m) {
                metascoreMatch = m[1];
                break;
            }
        }

        if (!metascoreMatch) {
            const summaryBlockMatch = html.match(/<div[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            if (summaryBlockMatch) {
                const summaryMatch = summaryBlockMatch[1].match(/([0-9]{1,2})\s*\/\s*100/);
                if (summaryMatch) metascoreMatch = summaryMatch[1];
            }
        }

        if (!metascoreMatch) {
            const psMatch = html.match(/(?:metascore|metacritic).*?([0-9]{1,2}).*?out\s*of\s*100/is);
            if (psMatch) metascoreMatch = psMatch[1];
        }

        if (metascoreMatch) {
            const score = parseInt(metascoreMatch, 10);
            if (!isNaN(score) && score >= 0 && score <= 100) result.metascore = score;
        }

        let userscoreMatch = null;
        const userscorePatterns = [
            new RegExp(`data-qa=["']userscore["'].*?<span[^>]*>([0-9.]+)`, 'is'),
            new RegExp(`class="metascore_w(?:ell| user)[^"]*"[^>]*>\\s*<([0-9.]+)`, 'i'),
            new RegExp(`class="score[^"]*"[^>]*>\\s*([.0-9]+)`, 'i'),
            new RegExp(`userscore[^>]*>\\s*([.0-9]+)`, 'i'),
            new RegExp(`user_score[^"]*["']?\s*[:=]\s*["']?([.0-9]+)`, 'i'),
            new RegExp(`"userscore":\s*"([.0-9]+)"`, 'i'),
        ];

        for (const pattern of userscorePatterns) {
            const m = html.match(pattern);
            if (m) {
                userscoreMatch = m[1];
                break;
            }
        }

        if (!userscoreMatch) {
            const userSectionMatch = html.match(/<div[^>]*id=["']user_scores[^>]*>([\s\S]{0,2000})/i);
            if (userSectionMatch) {
                const usMatch = userSectionMatch[1].match(/([.0-9]+)\s*\/\s*10/);
                if (usMatch) userscoreMatch = usMatch[1];
            }
        }

        if (userscoreMatch) {
            const score = parseFloat(userscoreMatch);
            if (!isNaN(score) && score >= 0 && score <= 10) {
                result.userscore = score;
            }
        }

        try {
            const criticTco = (html.match(/critic[^}]*"tco"[:\s]*([0-9]+)/i) || []);
            if (criticTco[1]) result.critic_reviews = parseInt(criticTco[1], 10);
        } catch (e) {}

        try {
            const userRevMatch = html.match(/user_reviews[^}]*"count"[:\s]*"?([0-9]+)"?/i);
            if (userRevMatch) result.user_reviews = parseInt(userRevMatch[1], 10);
        } catch (e) {}

        return result;
    }

    async function scrapeMetacritic(gameName, platformSlug) {
        const safeSlug = String(platformSlug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
        const mcPlatform = METACRITIC_PLATFORMS[safeSlug] || METACRITIC_PLATFORMS['playstation'];

        const q = encodeURIComponent(String(gameName || '').trim());
        if (!q) return { error: 'نام بازی نامعتبر است' };

        let gameUrl = null;

        try {
            const searchUrl = `https://www.metacritic.com/search/${mcPlatform}/${q}?page=1`;
            const searchRes = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; Cafe-Bot/1.0; +https://localhost)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                signal: AbortSignal.timeout(10000)
            });

            if (searchRes.ok) {
                const searchHtml = await searchRes.text();
                const escapedPart = escapeRegExp('"/game/' + mcPlatform + '/');
                const urlRegex = new RegExp('href=' + escapedPart + '[^"]+"[^>]*>' + namePattern + '<', 'i');
                const urlMatch = searchHtml.match(urlRegex);
                if (urlMatch) {
                    const href = urlMatch[0].match(/href="([^"]+)"/);
                    if (href) gameUrl = 'https://www.metacritic.com' + href[1];
                }
            }
        } catch (e) {
            console.warn('Metacritic search failed:', e.message);
        }

        if (!gameUrl) {
            const slug = String(gameName || '').toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            gameUrl = `https://www.metacritic.com/game/${mcPlatform}/${slug}`;
        }

        try {
            const gameRes = await fetch(gameUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; Cafe-Bot/1.0; +https://localhost)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                signal: AbortSignal.timeout(10000)
            });

            if (gameRes.ok) {
                const gameHtml = await gameRes.text();
                const scores = parseMetacriticPage(gameHtml, gameName);
                if (scores.metascore !== null || scores.userscore !== null) {
                    return { game_url: gameUrl, ...scores };
                }
            }
        } catch (e) {
            console.warn('Metacritic game page fetch failed:', e.message);
        }

        return { error: 'امتیاز متاکریتیک پیدا نشد', game_url: gameUrl };
    }

    app.get('/api/games/:slug/metacritic', rateLimit, async (req, res) => {
        try {
            const rawgData = await fetchFromRawg(`games/${req.params.slug}`);
            const gameName = rawgData.name;
            const primaryPlatform = (rawgData.platforms && rawgData.platforms[0])
                ? (rawgData.platforms[0].platform ? rawgData.platforms[0].platform.name : rawgData.platforms[0].name)
                : 'playstation';

            const mcData = await scrapeMetacritic(gameName, primaryPlatform);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.json({ game: gameName, metacritic: mcData });
        } catch (error) {
            console.error('Metacritic proxy error:', error.message);
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.json({ game: req.params.slug, metacritic: { error: 'خطا در دریافت امتیاز متاکریتیک.' } });
        }
    });

    app.get('/api/ratings', rateLimit, (req, res) => {
        rawgProxy('ratings', req, res);
    });

app.get('/api/genres', rateLimit, (req, res) => {
    rawgProxy('genres', req, res);
});

app.get('/api/platforms', rateLimit, (req, res) => {
    rawgProxy('platforms', req, res);
});

// Gaming API routes
function getPCGames() {
    const categories = ['Action', 'RPG', 'FPS', 'Strategy', 'Adventure', 'Simulation', 'Sports', 'Horror', 'Casual', 'Sandbox', 'Battle Royale'];
    const now = new Date();
    const games = [];
    let id = 1;
    
    const popularGames = [
        'Cyberpunk 2077', 'Assassin\'s Creed Valhalla', 'Call of Duty: Modern Warfare II', 'Elden Ring',
        'Grand Theft Auto V', 'Red Dead Redemption 2', 'The Witcher 3', 'Counter-Strike 2', 'Dota 2',
        'Apex Legends', 'Fortnite', 'Valorant', 'Minecraft', 'Among Us', 'Fall Guys', 'Rocket League',
        'Dead by Daylight', 'Phasmophobia', 'The Sims 4', 'Cities: Skylines', 'Stardew Valley',
        'Terraria', 'Portal 2', 'Half-Life 2', 'Left 4 Dead 2', 'World of Warcraft', 'Final Fantasy XIV',
        'Guild Wars 2', 'Path of Exile', 'Destiny 2', 'Apex Legends', 'Overwatch 2', 'Rainbow Six Siege',
        'Hearthstone', 'Rocket League', 'Team Fortress 2', 'DOTA 2', 'CS:GO', 'PUBG', 'DayZ',
        'ARK: Survival Evolved', 'Rust', 'Garry\'s Mod', 'Unturned', 'Subnautica', 'Outer Wilds',
        'Hades', 'Celeste', 'Hollow Knight', 'Dead Cells', 'Sekiro', 'Dark Souls III', 'Bloodborne',
        'God of War', 'Spider-Man', 'The Last of Us', 'Uncharted 4', 'Horizon Zero Dawn', 'Ghost of Tsushima'
    ];
    
    for (let i = 0; i < popularGames.length; i++) {
        const randomDate = new Date(now.getTime() - Math.random() * 365 * 24 * 60 * 60 * 1000 * 5);
        games.push({
            id: id++,
            title: popularGames[i],
            category: categories[Math.floor(Math.random() * categories.length)],
            price: Math.random() > 0.5 ? Math.floor(Math.random() * 300000) + 50000 : 0,
            releaseDate: randomDate.toISOString().split('T')[0],
            trending: Math.random() > 0.3
        });
    }
    return games;
}

app.get('/api/games', (req, res) => {
    const { page = 1, limit = 10, sort = 'newest', category } = req.query;
    
    let games = getPCGames();
    
    if (category && category !== 'all') {
        games = games.filter(g => g.category.toLowerCase() === category.toLowerCase());
    }
    
    switch(sort) {
        case 'newest':
            games.sort((a, b) => b.id - a.id);
            break;
        case 'popular':
            games.sort((a, b) => (b.trending === true) - (a.trending === true));
            break;
        case 'price-low':
            games.sort((a, b) => a.price - b.price);
            break;
        case 'price-high':
            games.sort((a, b) => b.price - a.price);
            break;
    }
    
    const total = games.length;
    const start = (page - 1) * limit;
    const end = start + parseInt(limit);
    const paginatedGames = games.slice(start, end);
    
    res.json({
        games: paginatedGames,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / limit)
        }
    });
});

app.get('/api/games/categories', async (req, res) => {
    try {
        const steamResponse = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2');
        const steamData = await steamResponse.json();
        const apps = steamData.applist ? steamData.applist.apps : [];
        
        const categories = ['Action', 'Adventure', 'RPG', 'Strategy', 'Simulation', 'FPS', 'Sports', 'Horror', 'Casual', 'Sandbox', 'Battle Royale'];
        
        res.json(categories);
    } catch (error) {
        const games = getPCGames(); const categories = [...new Set(games.map(g => g.category))];
        res.json(categories);
    }
});

const PORT = process.env.PORT || 3005;
let server;
if (!isVercel && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
    server = http.createServer(app);
    const io = new Server(server, { path: '/socket.io' });

    io.on('connection', (socket) => {
        socket.on('join-admin-room', () => {
            socket.join('admin-room');
        });
        socket.on('customer-typing', (data) => {
            socket.to('admin-room').emit('customer-typing', data);
        });
        socket.on('customer-stop-typing', (data) => {
            socket.to('admin-room').emit('customer-stop-typing', data);
        });
    });

    app.set('io', io);

    server.listen(PORT, () => {
        console.log('Server running on http://localhost:' + PORT);
        warmupImageCache().catch(() => {});
    });

    const dbAtStart = readDB();
    if (!dbAtStart.banners || dbAtStart.banners.length === 0) {
        dbAtStart.banners = [
            {
                id: 1,
                src: 'https://placehold.co/1200x400/164A41/FFF?text=بنر+تخفیف+ویژه',
                link: 'deals.html',
                duration: 5,
                group: 1,
                date: new Date().toISOString()
            },
            {
                id: 2,
                src: 'https://placehold.co/1200x400/1a3c2a/FFF?text=بازی+های+جدید',
                link: 'games.html',
                duration: 5,
                group: 1,
                date: new Date().toISOString()
            },
            {
                id: 3,
                src: 'https://placehold.co/1200x400/0f2e22/FFF?text=گیفت+کارت+موبایل',
                link: 'giftcards-mobile.html',
                duration: 5,
                group: 2,
                date: new Date().toISOString()
            }
        ];
        writeDB(dbAtStart);
        console.log('Default banners seeded');
    }
} else {
    server = app;
}

function emitChatEvent(io, event, data) {
    try {
        if (io && typeof io.to === 'function') {
            io.to('admin-room').emit(event, data);
        }
    } catch (e) {}
}

const ORIGINAL_POST_CHAT = app._router && app._router.stack ? null : null;

module.exports = app;