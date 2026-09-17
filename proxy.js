/**
 * 天禧 AI → OpenAI 兼容代理
 *
 * 把天禧的云端接口包装成标准 OpenAI 格式，这样任何支持 OpenAI API 的第三方
 * agent（OpenCode / Claude Code / Cursor / DSH / Continue 等）都能直接接进来。
 *
 *   ┌─────────────────┐  OpenAI 格式  ┌──────────────┐  天禧私有格式  ┌──────────────┐
 *   │ 第三方 Agent     │ ───────────► │ 本代理 :8787 │ ─────────────► │ ai.lenovomm.com│
 *   │ baseURL=127.0.0.1│ ◄─────────── │ 注入 Bearer  │ ◄───────────── │ (SSE 流式)    │
 *   └─────────────────┘  OpenAI 格式  └──────────────┘                └──────────────┘
 *
 * 用法：
 *   node get-token.js --write     # 第一步：取出 token
 *   node proxy.js                 # 第二步：起服务
 *   node proxy.js --debug         # 打印天禧原始响应，方便适配字段
 *
 * 零依赖，只用 Node 内置模块。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
const PORT = Number(process.env.TX_PORT || 8787);
const HOST = process.env.TX_HOST || '127.0.0.1';
const DEBUG = process.argv.includes('--debug');

const UPSTREAM_HOST = 'ai.lenovomm.com';
const UPSTREAM_PATH = '/cloud-ai-core/rest/v1/chat/completion';

// 生产环境 merchantId，来自天禧前端 app.js 的 env.production 配置
const MERCHANT_ID = '1213110283744128';   // 0x44f513f893380
const APP_VERSION = '4.2.1.8111';

// 天禧的模型标识 → 对外暴露成 OpenAI 的模型名
const MODELS = [
  { id: 'tianxi', name: '天禧智能体（默认）', upstream: '' },
  { id: 'tianxi-deepseek', name: '天禧 · DeepSeek', upstream: 'deepseek' },
  { id: 'tianxi-qwen', name: '天禧 · 通义千问', upstream: 'qwen' },
];

// ---------- token ----------
function loadToken() {
  const candidates = [
    path.join(__dirname, 'token.txt'),
    process.env.TX_TOKEN || '',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      const t = fs.readFileSync(c, 'utf8').trim();
      if (t) return t;
    }
  }
  if (process.env.TX_TOKEN) return process.env.TX_TOKEN.trim();
  return '';
}

// ---------- 从天禧的 SSE 事件里尽力抠出文本 ----------
// 天禧的响应结构未公开，这里按常见命名做宽松适配；--debug 可看原始报文自行调整。
function pickText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const direct = [
    'content', 'text', 'delta', 'answer', 'output', 'result', 'msg',
  ];
  for (const k of direct) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      const inner = pickText(v);
      if (inner) return inner;
    }
  }
  for (const k of ['data', 'choices', 'delta', 'message']) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && v.length) {
      const inner = pickText(v[0]);
      if (inner) return inner;
    } else if (v && typeof v === 'object') {
      const inner = pickText(v);
      if (inner) return inner;
    }
  }
  return '';
}

function pickReasoning(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of ['reasoningContent', 'reasoning_content', 'reasoning']) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function isDone(obj, raw) {
  if (raw === '[DONE]') return true;
  if (!obj) return false;
  if (obj.error_code === 1050) return true;      // 天禧的流结束码
  if (obj.done === true || obj.finished === true) return true;
  if (obj.event === 'finish' || obj.type === 'finish') return true;
  return false;
}

// ---------- 上游调用 ----------
function callTianxi(token, payload, onChunk, onDone, onError) {
  const body = JSON.stringify(payload);
  const req = https.request({
    hostname: UPSTREAM_HOST,
    path: UPSTREAM_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
      'User-Agent': `TianxiAI/${APP_VERSION}`,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 120000,
  }, (res) => {
    if (res.statusCode === 401) {
      onError(401, 'token 无效或已过期，重新抓包后跑：node get-token.js save "eyJ..."');
      res.resume();
      return;
    }
    if (res.statusCode >= 400) {
      onError(res.statusCode, `上游返回 HTTP ${res.statusCode}`);
      res.resume();
      return;
    }

    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (DEBUG) console.error('[上游原始] ' + raw.slice(0, 300));
        if (raw === '[DONE]') { onDone(); continue; }
        let obj = null;
        try { obj = JSON.parse(raw); } catch { continue; }
        if (obj.error_code && obj.error_code !== 0) {
          onError(obj.error_code, obj.error_msg || obj.message || ('上游错误码 ' + obj.error_code));
          continue;
        }
        if (isDone(obj, raw)) { onDone(); continue; }
        onChunk({ content: pickText(obj), reasoning: pickReasoning(obj), raw: obj });
      }
    });
    res.on('end', () => onDone());
  });

  req.on('timeout', () => { req.destroy(); onError(-1, '上游请求超时'); });
  req.on('error', (e) => onError(-1, '网络错误: ' + e.message));
  req.write(body);
  req.end();
}

// ---------- 构造天禧请求体 ----------
function buildPayload(openaiReq, model) {
  const msgs = Array.isArray(openaiReq.messages) ? openaiReq.messages : [];
  const hasSystem = msgs.some(m => m.role === 'system');
  const uuid = require('crypto').randomUUID();

  return {
    disableSearch: openaiReq.disableSearch !== false,
    stream: openaiReq.stream !== false,
    meechantId: MERCHANT_ID,          // 注意：天禧前端源码里就是这个拼写，别改成 merchantId
    pluginIds: '[]',
    enableTrace: true,
    maxOutputTokens: openaiReq.max_tokens || 2048,
    promptCode: openaiReq.promptCode || '',
    version: APP_VERSION,
    user: uuid,
    hasSystem,
    messages: JSON.stringify(msgs.map(m => ({ role: m.role, content: m.content }))),
    // 若上游需要指定模型，把映射后的标识带上
    ...(model && model.upstream ? { model: model.upstream } : {}),
  };
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // CORS，方便浏览器里的 agent 或调试页直接调
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 健康检查
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, service: 'tianxi-openai-bridge', upstream: UPSTREAM_HOST + UPSTREAM_PATH,
    }));
  }

  // 模型列表
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map(m => ({ id: m.id, object: 'model', owned_by: 'lenovo', created: 0 })),
    }));
  }

  if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'not found: ' + url.pathname } }));
  }

  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let openaiReq;
    try { openaiReq = JSON.parse(raw); }
    catch { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'invalid json'}})); }

    const token = loadToken();
    if (!token) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: { message: '未找到 token。抓包拿到后跑：node get-token.js save "eyJ..."（或设 TX_TOKEN 环境变量）' },
      }));
    }

    const model = MODELS.find(m => m.id === openaiReq.model) || MODELS[0];
    const payload = buildPayload(openaiReq, model);
    const wantStream = openaiReq.stream !== false;
    const id = 'chatcmpl-' + require('crypto').randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(Date.now() / 1000);

    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      let sent = false;
      callTianxi(
        token, payload,
        ({ content, reasoning }) => {
          const delta = {};
          if (content) delta.content = content;
          if (reasoning) delta.reasoning_content = reasoning;
          if (!content && !reasoning) return;
          sent = true;
          res.write('data: ' + JSON.stringify({
            id, object: 'chat.completion.chunk', created, model: model.id,
            choices: [{ index: 0, delta, finish_reason: null }],
          }) + '\n\n');
        },
        () => {
          res.write('data: ' + JSON.stringify({
            id, object: 'chat.completion.chunk', created, model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        },
        (code, msg) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `天禧上游错误 ${code}: ${msg}` } }));
          } else {
            res.write('data: ' + JSON.stringify({ error: { code, message: msg } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }
      );
      return;
    }

    // 非流式：攒完一次性返回
    let acc = '', accReason = '';
    callTianxi(
      token, payload,
      ({ content, reasoning }) => { acc += content || ''; accReason += reasoning || ''; },
      () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id, object: 'chat.completion', created, model: model.id,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: acc, ...(accReason ? { reasoning_content: accReason } : {}) },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
        }));
      },
      (code, msg) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `天禧上游错误 ${code}: ${msg}` } }));
      }
    );
  });
});

server.listen(PORT, HOST, () => {
  const hasToken = !!loadToken();
  console.log('');
  console.log('  天禧 AI → OpenAI 兼容代理已启动');
  console.log('  ────────────────────────────────');
  console.log(`  监听      http://${HOST}:${PORT}`);
  console.log(`  上游      https://${UPSTREAM_HOST}${UPSTREAM_PATH}`);
  console.log(`  Token     ${hasToken ? '已加载' : '缺失！请跑 node get-token.js --write'}`);
  console.log('');
  console.log('  第三方 agent 里这样填：');
  console.log(`    baseURL = http://${HOST}:${PORT}/v1`);
  console.log('    apiKey  = 任意值（本代理不校验，真 token 走本地 token.txt）');
  console.log('    model   = tianxi');
  console.log('');
  if (DEBUG) console.log('  --debug 已开启，上游原始报文会打到 stderr\n');
});
