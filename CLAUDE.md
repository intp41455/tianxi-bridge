# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目目的

天禧 AI 接入第三方 Agent 的**协议适配器**（个人学习性质的互操作性研究）：把联想天禧（个人超级智能体）闭源客户端的云端私有接口（`ai.lenovomm.com` 的 SSE 流式接口）包装成标准 **OpenAI 兼容接口**，让任何支持 OpenAI API 的第三方 agent（OpenCode / Cursor / Continue / Cline 等）直接接入。

关键约束（README 免责声明）：
- 只观察客户端自己的网络流量，不修改、不反编译、不破解客户端本体；
- 必须使用用户自己账号的凭据；仅供本机自用，不对外提供服务；
- 官方接口一旦变更，本项目随时可能失效（预期内）。

## 技术栈

- **零依赖** Node.js 脚本，只用 Node 内置模块（`http` / `https` / `fs` / `path` / `crypto`），Node 18+ 即可运行。没有 package.json，没有构建步骤，没有测试。
- 代理协议：上游 SSE（`text/event-stream`）→ 下游 OpenAI chat.completion chunk / 非流式 JSON。
- 上游接口为逆向所得，字段细节见 README「接口细节」节。

## 目录结构

```
proxy.js          # 核心：OpenAI 兼容代理（HTTP 服务 + 上游调用 + 字段适配）
get-token.js      # token 助手：scan（扫描本机残留）/ save（存抓包所得 token）/ check（查过期）
README.md         # 使用文档（抓包步骤、agent 配置、接口细节）
docs/             # 架构图（architecture.png / .html / .json）
token.txt         # 运行时生成，存 access token（.gitignore 已排除，等同登录凭据，绝不入库）
```

## 如何安装 / 运行 / 测试

无安装步骤（无 package.json、无依赖）。

```bash
# 1. 抓包拿到 token（唯一必须的手动操作，token 不落盘、无法自动提取）
node get-token.js save "eyJhbGci..."   # 抓包步骤见 README「第一步」（Fiddler/mitmproxy）
node get-token.js check               # 检查 token.txt 是否过期

# 2. 启动代理
node proxy.js              # 默认监听 127.0.0.1:8787
node proxy.js --debug      # 打印天禧原始响应（stderr），便于适配字段
TX_PORT=9000 node proxy.js # 换端口（TX_HOST 可改监听地址，TX_TOKEN 可替代 token.txt）

# 3. 自测（无测试框架，用 curl 验证）
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"tianxi","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

第三方 agent 配置：`baseURL = http://127.0.0.1:8787/v1`，`apiKey = 任意值`（代理不校验），`model = tianxi`。各客户端示例见 README「第三步」。

## 关键约定与坑点

- **`meechantId` 是上游字段的真实拼写**（源自天禧前端源码），不要"修正"成 `merchantId`，改了会被上游拒绝。
- **上游请求体的 `messages` 是 JSON 字符串**（`JSON.stringify` 后的数组），不是数组本身，见 `buildPayload()`。
- **token 获取**：`loadToken()` 依次尝试 `token.txt`（与 proxy.js 同目录）→ `TX_TOKEN` 环境变量。token 过期后上游返回 401，需重新抓包；`token.txt` 等同登录凭据，切勿提交/外传。
- **字段适配是宽松猜测**：`pickText()` / `pickReasoning()` 按常见命名（`content`/`text`/`delta`/`answer`/`data`/`choices`…）递归提取，天禧响应结构未公开。若接上后输出为空，用 `node proxy.js --debug` 看上游原始字段名再调整这两个函数。
- **流结束判定**：上游 `[DONE]` 或 `error_code === 1050`（天禧的流结束码）都算结束；`error_code` 非 0 且非 1050 视为上游错误（已知错误码还有 1207、1208）。
- **模型映射**：`MODELS` 表把 `tianxi` / `tianxi-deepseek` / `tianxi-qwen` 暴露为 OpenAI 模型名，`upstream` 字段非空时会在请求体里带上 `model`。
- **不支持 Anthropic 格式**：Claude Code 走 Anthropic 协议，本代理只覆盖 OpenAI 格式（README 已注明）。
- **MERCHANT_ID / APP_VERSION 是硬编码的生产环境常量**（`1213110283744128` / `4.2.1.8111`），来自天禧前端 app.js 的 env.production；天禧版本更新后可能需同步修改。
- **仅监听 127.0.0.1**（`TX_HOST` 默认值），请勿改成对外地址。
