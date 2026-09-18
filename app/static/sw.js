/*!
 * 课时本 LessonDesk - Service Worker
 * ---------------------------------------------------------------------------
 * 设计原则（重要，别改坏）：
 *
 *   1. **只缓存 /static/ 下的静态资源**。其它一律不拦、不存 —— 登录态、
 *      学员课时、报名数据、后台页面全部走网络，绝不停留在 Cache 里。
 *   2. **HTML 页面一律 network-first，且永不写入缓存**。离线时只回退到
 *      一个离线提示页，不会出现"白屏"或"看到昨天缓存的数据"。
 *   3. 带 Set-Cookie 的响应、带 Range 的请求、非 GET/非同源请求，一律放行。
 *   4. 网络恢复后不需要任何特殊处理：页面与接口本来就走网络，自然恢复。
 *
 * 目录：
 *   - 缓存策略      ：CACHE_STRATEGY
 *   - 安装/激活     ：install / activate
 *   - 取数          ：fetch
 *   - 离线页        ：offlineResponse()  （内联兜底 + /static/offline.html）
 *   - 消息通道      ：message        （版本/缓存运维用）
 *   - 推送预留      ：push / notificationclick（PUSH_ENABLED = false，暂不启用）
 * ---------------------------------------------------------------------------
 */

const VERSION = 'v1.0.2';
const STATIC_CACHE = 'ld-static-' + VERSION;

const OFFLINE_URL = '/static/offline.html';

/* 安装时预缓存：只放静态资源 + 离线页 */
const PRECACHE = [
  '/static/css/style.css',
  '/static/vendor/css/bootstrap.min.css',
  '/static/vendor/css/bootstrap-icons.css',
  '/static/vendor/js/bootstrap.bundle.min.js',
  '/static/vendor/fonts/bootstrap-icons.woff2',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/apple-touch-icon.png',
  OFFLINE_URL,
];

/* 允许进入缓存的路径前缀（白名单，宁缺勿滥） */
const CACHEABLE_PREFIXES = ['/static/'];

/* 明确永不缓存的路径（双保险；正常情况下上面的白名单已经挡住了）
   注意：精确匹配和前缀匹配要分开写！
   （踩过的坑：把 '/' 当前缀会导致“所有路径都以前缀 / 开头”→ 全站都不缓）*/ 
const NEVER_CACHE_EXACT = [
  '/', '/login', '/logout', '/setup', '/profile',
  '/students', '/classes', '/lessons', '/me', '/attendance',
  '/register', '/admin', '/finance', '/healthz',
  '/sw.js', '/manifest.webmanifest', '/offline',
];
const NEVER_CACHE_PREFIX = [
  '/r/',                  // 家长报名（带 token，敏感）
  '/register/',           // 报名管理子页
  '/students/', '/lessons/', '/classes/', '/admin/', '/finance/', '/r/',
];

/* 推送预留开关：等老爹说做推送时，把它打开并补上订阅逻辑即可 */
const PUSH_ENABLED = false;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isNeverCache(url) {
  if (NEVER_CACHE_EXACT.includes(url.pathname)) return true;
  return NEVER_CACHE_PREFIX.some(p => url.pathname.startsWith(p));
}

function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (!isSameOrigin(url)) return false;
  if (request.headers.has('range')) return false;          // 音视频分段
  if (isNeverCache(url)) return false;                     // 双保险
  return CACHEABLE_PREFIXES.some(p => url.pathname.startsWith(p));
}

/* 响应本身允许被存吗？带 Set-Cookie / no-store 的绝不存 */
function responseIsStorable(resp) {
  if (!resp || !resp.ok) return false;
  if (resp.headers.has('Set-Cookie')) return false;
  const cc = (resp.headers.get('Cache-Control') || '').toLowerCase();
  if (cc.includes('no-store')) return false;
  if (resp.type === 'opaqueredirect' || resp.type === 'opaque') return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 离线页
 * ------------------------------------------------------------------ */
const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>网络未连接 · 课时本</title>
<style>
  :root{--red:#e12232;--bg:#f2f4f9;--text:#1f2733;--muted:#7a8494}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       display:flex;align-items:center;justify-content:center;padding:24px}
  .box{max-width:420px;width:100%;text-align:center;background:#fff;border-radius:18px;
       padding:36px 26px;box-shadow:0 6px 26px rgba(30,45,90,.08)}
  .ic{width:96px;height:96px;border-radius:24px;margin:0 auto 18px;display:block}
  h1{font-size:19px;margin:0 0 8px}
  p{color:var(--muted);font-size:14px;margin:0 0 22px}
  button{border:0;border-radius:12px;background:var(--red);color:#fff;font-size:15px;
         padding:12px 30px;font-weight:600;cursor:pointer}
  button:active{opacity:.85}
  .tip{margin-top:18px;font-size:12px;color:var(--muted)}
</style></head>
<body><div class="box">
  <img class="ic" src="/static/icons/icon-192.png" alt="课时本" onerror="this.style.display='none'">
  <h1>网络好像断开了</h1>
  <p>课时本需要联网才能读取最新的课时和报名数据。<br>请检查 Wi-Fi 或流量，然后重试。</p>
  <button onclick="location.reload()">重新加载</button>
  <div class="tip">网络恢复后会自动刷新</div>
</div>
<script>
  window.addEventListener('online', function () { location.reload(); });
  setTimeout(function () { if (navigator.onLine) location.reload(); }, 3000);
</script>
</body></html>`;

async function offlineResponse() {
  try {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(OFFLINE_URL);
    if (hit) return hit;
  } catch (e) { /* ignore */ }
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* ------------------------------------------------------------------ *
 * 安装 / 激活
 * ------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // 逐个加，任何一个 404 都不该让整次安装失败
    // 注意：用 URL 字符串当键 + 下面 match 时 ignoreVary，避免因 Vary/Accept 头
    // 不一致导致"东西明明在缓存里却 match 不到"（已踩过的坑）
    await Promise.all(PRECACHE.map(async (url) => {
      try { await cache.add(url); } catch (e) { /* skip */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉旧版本缓存
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== STATIC_CACHE ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ *
 * 取数策略
 * ------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) 页面导航：network-first，离线回退到离线页；**永不写缓存**
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        return await offlineResponse();
      }
    })());
    return;
  }

  // 2) 静态资源：stale-while-revalidate（先给缓存，后台悄悄更新）
  if (isCacheable(req, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req.url, { ignoreVary: true, ignoreSearch: false });
      const network = fetch(req).then((resp) => {
        if (responseIsStorable(resp)) cache.put(req.url, resp.clone()).catch(() => {});
        return resp;
      }).catch(() => null);
      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;
      return new Response('/* offline */', {
        status: 504, statusText: 'offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })());
    return;
  }

  // 3) 其余一律放行（不拦、不存）——登录、课时、报名、后台都走这条路
});

/* ------------------------------------------------------------------ *
 * 消息通道（运维/版本用；也留给后续功能）
 * ------------------------------------------------------------------ */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'PING') {
    event.source && event.source.postMessage({ type: 'PONG', version: VERSION, push: PUSH_ENABLED });
  }
});

/* ------------------------------------------------------------------ *
 * 推送 —— 预留（老爹说先不做，只留结构）
 * 启用步骤：
 *   1. PUSH_ENABLED 改 true
 *   2. 前端拿到用户授权后 POST 订阅信息到后端（如 /api/push/subscribe）
 *   3. 后端用 VAPID 私钥推送到该 endpoint
 * 下面两个 handler 现在不会被触发，留着是为了以后不用改结构。
 * ------------------------------------------------------------------ */
self.addEventListener('push', (event) => {
  if (!PUSH_ENABLED) return;
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { body: event.data && event.data.text() }; }
  const title = payload.title || '课时本';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/icon-192.png',
    data: { url: payload.url || '/' },
    tag: payload.tag || 'lessondesk',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(new URL(target, self.location.origin).pathname) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
