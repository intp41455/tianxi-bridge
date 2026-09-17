/**
 * 天禧 access token 获取助手
 *
 * ── 为什么不能自动提取 ────────────────────────────────────────────
 * 天禧的 AI_TOKEN 只存在于渲染进程的 JS 内存里（window.AI_TOKEN），
 * 由 gateWayToken() 动态签发，不写到磁盘。已实测排除的落盘位置：
 *   · CEF Local Storage (leveldb)  → 只有被 Snappy 压缩切碎的 license 串
 *   · CEF Cookies (SQLite)         → 无 JWT
 *   · storagedb / *.db / *.dat     → 无 JWT
 *   · 注册表 / AppData             → 无 JWT
 * 敏感项（localStorage 里的 token 键）是 AES 加密的，前缀 U2FsdGVkX1。
 * 所以要拿到 token，只能从网络流量里截获。
 *
 * ── 用法 ─────────────────────────────────────────────────────────
 *   node get-token.js scan                 扫描本机可能残留的 token（诊断用）
 *   node get-token.js save "eyJhbGci..."   把你抓到的 token 存入 token.txt
 *   node get-token.js check                检查 token.txt 里的 token 是否过期
 */
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, 'token.txt');
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
const LS_DIR = 'C:\\ProgramData\\Lenovo\\AIAgent\\cefcache\\Local Storage\\leveldb';

function scan() {
  console.log('扫描本机天禧残留 token（诊断用）...\n');
  if (!fs.existsSync(LS_DIR)) {
    console.log('[x] 未找到天禧 Local Storage，天禧可能未安装。');
    return;
  }
  const files = fs.readdirSync(LS_DIR).filter(f => /\.(ldb|log)$/i.test(f));
  let found = 0;
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(path.join(LS_DIR, f)).toString('latin1'); }
    catch { continue; }
    const hits = new Set();
    let m;
    while ((m = JWT_RE.exec(txt)) !== null) hits.add(m[0]);
    for (const jwt of hits) {
      found++;
      const p = decode(jwt);
      console.log(`  文件=${f}  长度=${jwt.length}`);
      console.log(`    ${jwt.slice(0, 36)}...`);
      if (p && p.exp) {
        console.log(`    过期时间=${new Date(p.exp * 1000).toLocaleString('zh-CN')}  ${p.exp * 1000 < Date.now() ? '[已过期]' : '[有效]'}`);
      }
    }
  }
  if (found === 0) {
    console.log('  [x] 无标准三段式 JWT。');
    console.log('      localStorage 里那个 eyJ... 是 license（缺签名段且被压缩截断），不是 access token。');
  }
  console.log('\n结论：access token 不落盘，请走抓包。见下方 save 命令配合 README 的抓包步骤。');
}

function decode(jwt) {
  try {
    const b = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
  } catch { return null; }
}

function save(token) {
  const t = (token || '').trim().replace(/^Bearer\s+/i, '');
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) {
    console.error('[x] 这不像一个 JWT。应该是 eyJxxx.yyy.zzz 三段结构。');
    console.error('    从抓包里复制 Authorization 头时，去掉前面的 "Bearer "。');
    process.exit(1);
  }
  fs.writeFileSync(TOKEN_FILE, t, 'utf8');
  const p = decode(t);
  console.log('[√] token 已写入 ' + TOKEN_FILE);
  if (p && p.exp) {
    const d = new Date(p.exp * 1000);
    const ok = p.exp * 1000 > Date.now();
    console.log(`    过期时间：${d.toLocaleString('zh-CN')}  ${ok ? '[当前有效]' : '[已过期！]'}`);
    if (!ok) console.log('    [!] 已过期，需要重新抓。');
  }
  console.log('\n下一步：node proxy.js');
}

function check() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.log('[x] token.txt 不存在。先抓包拿到 token 后执行：');
    console.log('    node get-token.js save "eyJhbGci..."');
    process.exit(1);
  }
  const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const p = decode(t);
  console.log(`token.txt 长度=${t.length}`);
  console.log(`  ${t.slice(0, 36)}...${t.slice(-8)}`);
  if (p && p.exp) {
    const d = new Date(p.exp * 1000);
    const ok = p.exp * 1000 > Date.now();
    console.log(`  过期时间：${d.toLocaleString('zh-CN')}  ${ok ? '[有效]' : '[已过期]'}`);
    process.exit(ok ? 0 : 1);
  }
  console.log('  无法解析 payload（可能不是 JWT），但代理仍会尝试用它。');
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'scan':  scan(); break;
  case 'save':  save(arg); break;
  case 'check': check(); break;
  default:
    console.log(`天禧 token 助手

  node get-token.js scan                 扫描本机残留 token（诊断）
  node get-token.js save "eyJhbGci..."   保存抓到的 token
  node get-token.js check                检查 token.txt 是否过期

Token 只能抓包拿到（它不落盘）。抓包步骤见 README.md 的「第一步」。`);
}
