# Kite x402 Hono

[![CI](https://github.com/BrKDDD/kite-x402-hono/actions/workflows/ci.yml/badge.svg)](https://github.com/BrKDDD/kite-x402-hono/actions/workflows/ci.yml)

English: [README.md](README.md)

这是一个基于 Bun 和 Hono 的 HTTP 付费 API 反向代理模板，使用 x402 协议在 Kite
网络上按请求收费。它补充了 [Kite 官方 Express 和 Go 模板](https://github.com/gokite-ai/kite-x402-services)，
复用相同的环境变量和 `/v1/*` 路由约定，并使用官方 `@x402/hono` 中间件处理支付。

这是独立的社区项目，采用 Apache-2.0 许可证。上游来源和署名见 `NOTICE`。

## 快速开始

需要 Bun 1.3 或更高版本。npm 构建工具需要 Node.js 22 或更高版本；CI 使用 Bun 1.4.2。

```sh
git clone https://github.com/BrKDDD/kite-x402-hono.git
cd kite-x402-hono
npm ci
cp .env.example .env
# 将 .env 中的 PAY_TO 替换为你自己的收款地址。
bun run example
```

在另一个终端启动代理：

```sh
bun run start
curl -i http://localhost:8080/healthz
curl -i http://localhost:8080/readyz
curl -i 'http://localhost:8080/v1/echo?message=hello'
```

`/healthz` 返回 200，且不会访问 facilitator。`/readyz` 会实际调用
facilitator 的 `/supported` 接口，只有当前配置的 Kite 网络仍被支持时才返回
200，编排系统可据此区分“进程存活”和“可以收款”。`/v1/echo` 在 facilitator 可访问并支持
所选网络时，未付款请求会返回带有 x402 v2 `PAYMENT-REQUIRED` 的 402。如果 facilitator
不可用，会返回 503；未完成付款验证前，代理不会调用上游。

示例是本地 echo API，不是已部署的服务，也不构成真实付费调用凭证。Bun 会自动读取
`.env`；库函数 `loadConfig()` 只读取传入的环境对象。

## 安装 npm 包

```sh
npm install kite-x402-hono
bunx kite-x402-hono --help
# 配置 PAY_TO 和 UPSTREAM_URL 后启动。
bunx kite-x402-hono
```

公开版本及安装信息：[kite-x402-hono](https://www.npmjs.com/package/kite-x402-hono)。

也可以作为库使用：

```ts
import { createApp, loadConfig } from "kite-x402-hono";

const config = loadConfig();
const app = createApp(config);
Bun.serve({ port: config.port, fetch: app.fetch });
```

`createApp(config, { facilitator, fetchUpstream })` 支持依赖注入，便于测试。生产服务
不要使用模拟 facilitator。

## 配置项

| 变量                   | 默认值                               | 说明                                                |
| ---------------------- | ------------------------------------ | --------------------------------------------------- |
| `PAY_TO`               | 必填                                 | 非零 EVM 收款地址                                   |
| `UPSTREAM_URL`         | 必填                                 | 固定的 HTTP(S) origin，不得包含路径、凭据或查询参数 |
| `KITE_NETWORK`         | `mainnet`                            | `mainnet` 或 `testnet`                              |
| `PRICE_USD`            | `0.001`                              | 正小数，最多 6 位小数，可带 `$` 前缀                |
| `FACILITATOR_URL`      | `https://facilitator.pieverse.io/v2` | 保留 `/v2` 后缀                                     |
| `UPSTREAM_AUTH_HEADER` | `Authorization`                      | 发给上游的认证头名称                                |
| `UPSTREAM_AUTH_VALUE`  | 空                                   | 服务端上游凭据，会覆盖买方提供的同名值              |
| `SERVICE_DESCRIPTION`  | Kite paid API description            | 写入付款挑战的服务说明                              |
| `PORT`                 | `8080`                               | 代理监听端口                                        |
| `UPSTREAM_TIMEOUT_MS`  | `10000`                              | 请求体读取、上游响应头和响应体的超时时间            |
| `MAX_BODY_BYTES`       | `1048576`                            | 请求和响应大小限制，最大 16 MiB                     |

除本地开发外，上游和 facilitator 必须使用 HTTPS。示例 `.env` 明确选择 testnet，
但兼容性默认值仍是 mainnet。本代理不需要钱包私钥。

| 网络   | CAIP-2        | 代币   | 精度 | EIP-712 域                         |
| ------ | ------------- | ------ | ---- | ---------------------------------- |
| 主网   | `eip155:2366` | USDC.e | 6    | `Bridged USDC (Kite AI)`，版本 `2` |
| 测试网 | `eip155:2368` | pieUSD | 18   | `pieUSD`，版本 `1`                 |

代币地址固定在 `src/networks.ts`，来源是 Kite 官方模板 revision
`893a27509648b660bbba626b0da59619a94f04ab`。金额换算使用整数运算，包含测试网的 18 位精度。

## 支付与代理流程

1. 没有付款或付款无效：返回 402，不调用上游。
2. 付款验证成功：去掉 `/v1` 前缀，保留查询参数、方法和请求体，注入配置的上游凭据，调用固定 origin。
3. 上游返回 2xx：缓存有大小上限的响应，然后请求 facilitator 结算。
4. 结算成功：返回上游响应和 `PAYMENT-RESPONSE`。
5. 上游返回 4xx/5xx、超时、请求或响应超限、连接失败：不结算。
6. 结算拒绝：返回 SDK 的失败响应，不泄露受保护数据。

兼容性和安全行为：

- `/v1/echo` 会映射到上游 `/echo`；`/v1/v1/forecast` 会映射到上游 `/v1/forecast`。
- `/v1/*` 下的所有 HTTP 方法都需要付款；上游必须支持对应方法。
- 本模板拒绝上游重定向并返回 502，不结算，避免凭据被带到其他主机。请直接配置最终上游 origin。条件请求的 304 Not Modified 不属于重定向，会正常转发，客户端的 If-None-Match / If-Modified-Since 仍然有效。
- 会删除支付头、客户端认证头、Cookie、代理头和 hop-by-hop 头；上游返回的认证头和 Cookie 也会被删除。
- 响应会被缓存，因此本模板不支持流式响应、SSE、WebSocket 和无限大小下载。
- 上游动作发生在结算之前。非幂等 POST 在结算失败时不会回滚；需要 exactly-once 行为时，上游必须自行提供幂等机制。
- facilitator 超时可能无法确定链上结算结果；错误响应不等于确定没有扣款，重试前应先核对。
- `/healthz` 只表示进程存活，不代表上游或 facilitator 已就绪。可用 `/readyz` 检查 facilitator 是否可达且支持所配置的网络。

## 验证

### 并发准入限制（0.2.0 新增）

`MAX_CONCURRENT_REQUESTS` 默认 64，接受 1 至 10000 的整数。每个 `createApp()` 实例
独立限制 `/v1/*` 的在途请求数，从 facilitator 初始化、付款验证、上游处理一直覆盖到结算完成。
达到上限后立即返回 `503 {"error":"service_busy"}`，附带 `Retry-After: 1` 和
`Cache-Control: no-store`，不验证付款、不调用上游，也不排队保存请求。
完成或失败都会释放名额；健康检查和无关路由不占用名额，未付款请求会占用名额。

这不是跨实例限流、付款防重放或幂等机制。应根据上游能力和响应大小调整上限，多个副本分别计数，
恶意流量仍应通过入口限流控制。不能把所有 503 都当成可安全重试：只有本代理的
`service_busy` 表示付款前拒绝；结算错误仍需先核对结果。

### Facilitator 超时（0.3.0 新增）

`FACILITATOR_TIMEOUT_MS` 默认 90000 毫秒，允许 1 至 300000 的整数。
使用官方 SDK 的 HTTP 取消机制，对 `/supported`、`/verify`、`/settle` 的每次请求
限制等待时间，覆盖响应头和响应体。它独立于上游 API 的 `UPSTREAM_TIMEOUT_MS`，
不是整个付费请求的总时限；SDK 对 `/supported` 的 429 响应可能退避重试。
自行注入的 facilitator 需要自行实现超时及取消策略。

初始化超时返回 503 `facilitator_unavailable`；付款验证及结算超时返回 SDK 的 502。
验证超时不会调用上游或结算。结算超时不返回受保护内容，但上游已经执行，链上可能已经扣款。
不自动重试验证和结算；结果不明时先核对再重试。请求结束后释放并发名额，健康检查保持可用。
超时设得过短会增加结算结果不明的情况，应按实际部署选择。

### 数据流清理（0.3.1 修复）

拒绝超大请求/响应、拒绝上游重定向或取消读取时，会发起数据流取消，
但不会等待生产者完成清理。清理卡住或报错不会占住并发名额，也不会覆盖原始错误。
读取器在成功和失败时均释放锁，正常响应内容保持不变。
清理属于尽力执行：自定义流生产者仍须管理底层资源。
此改动不会取消或撤销付款结算，也不增加付款重试。

### 检查命令

```sh
npm run typecheck
bun test --coverage
npm run build
npm audit --omit=dev --audit-level=high
npm pack
```

测试使用真实的 x402 Hono 中间件。确定性的模拟 facilitator 提供验证和结算结果；另有 HTTP
集成测试通过本地 `/v2/supported`、`/v2/verify`、`/v2/settle` 端点运行真实 HTTP 请求代理。
测试 fixture 不是有效签名，也不是真实链上付款证明。CI 会执行测试、构建、依赖审计、打包和
安装包验证，并保存覆盖率及 JUnit 报告。

如需真实付费验收，请部署公开 HTTPS origin，替换 `PAY_TO`，使用 Kite Passport 测试网
pieUSD 会话，并保存真实响应和交易哈希。主网交易不是本地开发所必需的。

## 发布与贡献

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，活动范围和证据清单见 [docs/week-1.md](docs/week-1.md)。
AI 工具参与了开发；BrK 审核并负责此贡献。项目自己的 Wrapper、配置校验、代理逻辑、测试和
打包工作与上游 x402 SDK 功能已明确区分。
