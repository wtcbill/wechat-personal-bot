# Weave

以个人微信聊天窗口作为自然语言交互终端，通过 iLink 接入应用，远程使用部署侧的工具与服务。应用独立于具体后端，各服务按独立模块接入。

首版只接入 DS API（DeepSeek API），先跑通微信文本问答；DSH、SSH 远程执行和其他后端在后续版本接入。具体范围、模块隔离与验收条件以 [首版方案](docs/首版方案.md) 为准。

## 当前状态

当前已实现本人专用的 iLink 文本收发验证：本人发送“你好”，回复“收到”。其余文本、其他用户、群消息和附件不触发回复。技术选择见 [技术栈](docs/技术栈.md)，本轮范围与后续问答验收见 [首版方案](docs/首版方案.md)。

当前微信侧入口是扫码绑定的机器人会话（用户界面中的 OpenClaw 入口），不是普通微信好友或小号。消息经腾讯 iLink 服务到达本机 Weave；本机不运行 OpenClaw 宿主，也不接管普通微信账号的好友列表或聊天。

该机器人入口已完成本人实际收发验证。后续产品希望使用普通微信好友入口，具体渠道仍在选型，尚未安装或实施；当前版本保留已验证的 iLink 实现。

程序将扫码登录者绑定为唯一允许的用户。微信应用尚未接入 DeepSeek；独立的 [chat 服务](src/chat/L2.md) 已实现模型问答、搜索／读取／查找循环及内存上下文，可从本机命令行运行。chat 历史与结果重启清空，尚未进行真实 API 联调；真实微信送达仍需单独确认。

旧实现已归档，不参与后续开发。Weave 沿用开发约束和 GEB 维护规则；旧实现地图与历史测试结果不作为本项目的实现或验证结论。

## 开发入口

1. 阅读 [AGENTS.md](AGENTS.md)，确认开发与操作边界。
2. 从 [L1.md](L1.md) 定位当前实际文件；iLink 接入见 [渠道 L2](src/weixin_ilink/L2.md)，独立问答与搜索见 [chat L2](src/chat/L2.md)。
3. 按 [GEB 使用与维护指南](docs/GEB使用与维护指南.md) 执行改动与同步检查。

## 换电脑继续开发

克隆本仓库，或在已有副本执行 `git pull --ff-only`，然后阅读 [当前交接](docs/交接文档.md)；开发规则见 [工作须知](docs/工作须知.md)，历史决策与验证记录见 [项目日志](docs/项目日志.md)。交接引用的架构和搜索方案也在 `docs`，不依赖原电脑的父工作区。

使用 Node.js 24，在安装项目依赖后按下方“测试”运行完整检查；依赖安装前也可运行 chat 原生测试和离线检查。密钥、本机配置与 `.weave` 登录状态各自在新电脑配置，Git 仅同步代码和文档。具体接续步骤见 [交接文档](docs/交接文档.md#6-在另一台电脑继续)。

## 本机运行

使用 Node.js 24 LTS 和 npm；当前具体版本见 [.node-version](.node-version) 与 [package.json](package.json)。在项目根目录执行：

```powershell
npm ci --ignore-scripts
npm run config:check
npm start
```

完成依赖安装后，执行 `npm start`。无本机登录状态时会自动获取二维码，将图片保存至 `.weave/login-qr.png`，在手机微信扫码并按提示确认。需要重新登录时运行 `npm run login`；该命令与正在运行的服务互斥。

登录后，在手机微信新增的对应会话发送“你好”，应收到“收到”。两端空白会被去除。仅扫码账号可触发；本人另外发送一条“你好”可以再次验证。终端事件 `owner_hello_received` 表示已收到本人匹配消息，`reply_accepted` 表示微信接口返回明确成功码，`reply_submitted` 表示提交完成但没有明确成功码；手机实际看到回复后才算送达验收通过。

使用 Ctrl+C 停止。普通网络失败会退避重试；微信登录状态失效时停止并提示重新登录。发送失败或超时后不会自动重发同一条入站消息，避免发送结果未知时重复回复；可重新发送一条“你好”继续验证。

配置文件可选：将 [config.example.json](config.example.json) 另存为本机 `config.local.json` 后调整请求超时。默认配置可直接使用，`npm run config:check` 只检查本机环境、配置和登录结构，不联网、不写文件。

## 本地状态

- `.weave/credentials.json`：登录凭据、扫码者身份、Bot 标识和 API 地址。
- `.weave/cursor.json`：该登录账号的收消息游标，用于后续轮询；不是模型历史。
- `.weave/login-qr.png`：最近一次登录二维码；超时后重新登录获取。
- `.weave/instance.lock`：单实例锁，避免同时开启两个收发进程。

该目录整体忽略提交，运行日志不打印凭据、用户标识或聊天正文。微信固定回复的正文只在处理期间存在于内存；去重记录在内存保留最多一天、最多一万条，重启不保留。独立 chat 的内存生命周期见 [chat 状态说明](src/chat/L2.md#内存与并发)。收消息游标在处理完一批消息后保存；跨进程崩溃与发送结果未知时不保证严格恰好一次投递。

## chat 本机问答与搜索

本机入口独立于微信和服务路由，不需要扫码或读取微信凭据。只需要 Node.js 24，新增部分没有第三方依赖；已有完整项目安装环境可使用下面的 npm 命令，也可直接执行对应的 `node` 命令。

```powershell
# 离线检查：不读取密钥、不联网、不写文件
npm run chat:check
# 无 npm 时：node src/chat/cli.ts check

# 真实调用：先在当前进程配置 DEEPSEEK_API_KEY，再执行
npm run chat
# 无 npm 时：node src/chat/cli.ts ask
```

密钥仅从运行进程的 `DEEPSEEK_API_KEY` 读取，不自动加载 `.env` 或其他项目配置；不要将真实密钥写入代码、提交文件或命令示例。默认模型 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 更改。同一模型先关闭思考进行检索决策，再开启思考根据实际资料作答；无需搜索的问题和澄清也进入思考作答阶段。Chat／Search／Fetch 均请求 DeepSeek 官方 API，真实调用涉及该账号的权限与计费。

检索阶段只决定是否搜索、搜索什么、读取哪些来源或是否缺少条件；程序调用 Search／Fetch 并回传资料。思考作答阶段取得原问题、问答历史及实际工具结果，资料够用时直接回答；发现关键缺口且预算允许时，最多交回检索阶段补查一次，再结合两次资料完成回答。思考阶段不直接执行工具，补查沿用原来的联网限制、来源和总预算；失败或仍缺资料时说明限制。具体默认值和边界见 [chat 模块](src/chat/L2.md)；开启思考和补查不保证事实正确，实际质量与耗时仍待联调。

```powershell
# 一次提问；--search 要求外部证据
node src/chat/cli.ts ask --search "查一下 DeepSeek 官方的工具调用说明"
# --offline 仅禁止 Search/Fetch，仍会调用联网的 Chat API
node src/chat/cli.ts ask --offline "把这句话翻译成日语：明天见"
```

交互模式支持连续问答、`/clear` 清空本会话历史、`/exit` 退出，Ctrl+C 取消并退出。结果展示答案、来源和必要限制。搜索失败、来源检查失败、预算用完等会返回明确状态；不会输出未通过来源检查的草稿。

服务也可通过 [公共接口](src/services.ts) 调用：构造 `ChatService(model, searchProvider)` 后调用 `run(request, signal)`。调用方提供稳定的 `sessionId`／`requestId`，以便重复请求复用结果；缓存有数量与时间限制，重启清空。发送与后端执行分别管理，chat 本身不做微信发送。预算、工具、并发与来源说明见 [模块地图](src/chat/L2.md)。

## 测试

```powershell
npm run typecheck
npm test
npm run build
npm run config:check
npm run chat:check
npm run test:chat
```

`npm run check` 顺序执行类型检查、现有 Vitest 测试、chat 原生测试和编译。编译产物在 `dist/`，也可使用 `node dist/main.js check` 或 `node dist/main.js start`。测试使用假凭据和模拟 HTTP，不连接微信、不调用真实模型，临时状态仅创建于项目 `.cache/`。

没有安装项目依赖时，可以直接用 `node --test tests/chat/*.node.ts` 验证新增 chat 逻辑；这不代替 TypeScript 类型检查、原有 Vitest 回归和编译。`.node.ts` 测试由 Node 自己执行，不由 Vitest 收集。

验证分为：工程检查与模拟、本机配置检查、真实模型／搜索返回、真实微信登录、服务端接受发送、手机实际送达。chat 模拟可验证工具循环和错误处理，不能证明真实搜索质量、语义正确性或微信送达。
