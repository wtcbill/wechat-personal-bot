# Weave

以个人微信聊天窗口作为自然语言交互终端，通过 iLink 接入应用，远程使用部署侧的工具与服务。应用独立于具体后端，各服务按独立模块接入。

首版只接入 DS API（DeepSeek API），先跑通微信文本问答；DSH、SSH 远程执行和其他后端在后续版本接入。具体范围、模块隔离与验收条件以 [首版方案](docs/首版方案.md) 为准。

## 当前状态

当前已接通本人专用的 iLink → 应用 → AI 路由 → chat → 微信回复，普通问答和搜索回复已通过手机收发验收。`npm start` 默认真实微信问答，固定回复诊断已删除；其他用户、群消息和附件不处理。技术选择见 [技术栈](docs/技术栈.md)，功能范围与验收要求见 [首版方案](docs/首版方案.md)，最新验证记录、未覆盖边界和已知问题见 [项目交接](docs/交接文档.md#4-当前验证与下一步)。

支持 [命令行调试模式](#命令行调试模式) 的真实 API 对话：终端输入经独立路由模型选择 chat，执行问答或搜索，再格式化输出。模拟模型、模拟后端与使用模拟 HTTP／模型的自动测试已按用户要求删除。

当前微信侧入口是扫码绑定的机器人会话（用户界面中的 OpenClaw 入口），不是普通微信好友或小号。消息经腾讯 iLink 服务到达本机 Weave；本机不运行 OpenClaw 宿主，也不接管普通微信账号的好友列表或聊天。

该机器人入口已完成本人实际收发验证。后续产品希望使用普通微信好友入口，具体渠道仍在选型，尚未安装或实施；当前版本保留已验证的 iLink 实现。

程序将扫码登录者绑定为唯一允许的用户。[chat 服务](src/chat/L2.md) 提供模型问答、搜索／读取／查找及内存上下文，终端与微信共用同一路由和应用流程。历史与结果重启清空，当前按消息串行处理，整轮完成后发送。

旧实现已归档，不参与后续开发。Weave 沿用开发约束和 GEB 维护规则；旧实现地图与历史测试结果不作为本项目的实现或验证结论。

## 开发入口

1. 阅读 [AGENTS.md](AGENTS.md)，确认开发与操作边界。
2. 从 [L1.md](L1.md) 定位当前实际文件；iLink 接入见 [渠道 L2](src/weixin_ilink/L2.md)，独立问答与搜索见 [chat L2](src/chat/L2.md)。
3. 按 [GEB 使用与维护指南](docs/GEB使用与维护指南.md) 执行改动与同步检查。

## 换电脑继续开发

克隆本仓库，或在已有副本执行 `git pull --ff-only`，然后阅读 [当前交接](docs/交接文档.md)；开发规则见 [工作须知](docs/工作须知.md)，历史决策与验证记录见 [项目日志](docs/项目日志.md)。交接引用的架构和搜索方案也在 `docs`，不依赖原电脑的父工作区。

使用 Node.js 24，在安装项目依赖后按下方“测试”运行完整检查；依赖安装前也可运行 chat 离线结构检查。密钥、本机配置与 `.weave` 登录状态各自在新电脑配置，Git 仅同步代码和文档。具体接续步骤见 [交接文档](docs/交接文档.md#6-在另一台电脑继续)。

## 本机运行

使用 Node.js 24 LTS 和 npm；当前具体版本见 [.node-version](.node-version) 与 [package.json](package.json)。在项目根目录执行：

```powershell
npm ci --ignore-scripts
npm run config:check
```

然后按 [API 配置说明](#路由调试与-api-配置) 保存本机 `services.config.local.json` 并填写 Key；已有本机配置时继续使用，不要用示例覆盖。也可按该说明配置环境变量。完成后启动真实微信问答：

```powershell
npm.cmd start
```

程序先检查 API 配置，再进入微信登录与收发。无本机登录状态时会自动获取二维码，将图片保存至 `.weave/login-qr.png`，在手机微信扫码并按提示确认。需要重新登录时运行 `npm run login`；该命令与正在运行的服务互斥。

登录后，在手机微信对应的机器人会话发送问题，即可经真实路由与 chat 回复。终端出现 `request_received`、`route_selected:chat`、`backend_completed` 表示后端处理完成；`reply_accepted` 表示微信接口返回明确成功码，`reply_submitted` 表示提交完成但没有明确成功码；手机实际看到回复后才算送达验收通过。

使用 Ctrl+C 停止。普通网络失败会退避重试；微信登录状态失效时停止并提示重新登录。发送失败或超时后不会自动重发同一条入站消息，避免发送结果未知时重复回复；可发送一条新消息继续。

配置文件可选：将 [config.example.json](config.example.json) 另存为本机 `config.local.json` 后调整请求超时。默认配置可直接使用，`npm run config:check` 只检查本机环境、配置和登录结构，不联网、不写文件。

## 命令行调试模式

保存本机 API 配置后，在 Weave 仓库目录执行：

```powershell
npm.cmd start -- --debug
```

输入消息并回车即可真实对话，例如先输入“把明天见翻译成日语”，再输入“再给一种更口语的说法”。默认链路为 `终端 → ConsoleChannel → Application → ServiceRouter → ChatService → ServiceResult → formatReply → 终端`。

每行是一条消息，空行忽略。输入 `/exit`、按 Ctrl+C 或结束标准输入均可退出；管道结束时会处理完已接收的消息，`/exit` 之后的内容不再处理。Ctrl+C 可取消当前处理。普通事件日志不记录聊天正文，终端会显示最终回复。

终端渠道使用本地调试身份，不读取微信凭据或占用 iLink 锁；回复由通用 Application 调用真实服务生成。正常微信启动使用 `npm.cmd start`，同样进入真实问答。`--debug` 仅能用于启动，不能与 login／check 组合。编译后同样可运行 `node dist/main.js start --debug`。

## 路由调试与 API 配置

配置样例为 [services.config.example.json](services.config.example.json)。将其另存为 `services.config.local.json`，在最上面的 `apiKey` 填写一次真实 Key，路由与 chat 即可共用。`router`、`chat` 可分别设置模型和请求超时；角色内填写 `apiKey` 可覆盖共享值。

**真实 Key 只填写在本机 services.config.local.json，不要写入 example。** 本机文件已被 .gitignore 排除且未受 Git 跟踪；正常添加、提交与推送不会包含它，公开样例的 Key 保持空白。程序及配置错误不输出密钥。角色与共享 Key 都为空时，才读取 `apiKeyEnv` 命名的进程环境变量；不自动读取 .env。

只检查文件结构、不联网，可执行：

```powershell
npm.cmd run api:check
```

填写并保存后直接运行 `npm.cmd start -- --debug`。先前完整命令 `npm.cmd start -- --debug --mode routed --backend api` 仍兼容；后端仅保留 api，模拟启动分支已删除。不加 `--debug` 即走真实微信渠道；`--mode routed` 保留旧命令兼容。

真实链路：`本机配置与密钥 → 独立路由模型（关闭思考、无工具）→ 严格决定校验 → chat 绑定会话 → ChatService（检索／Search／Fetch／思考与补查）→ 公共结果 → 共享格式化 → 终端或微信输出`。缺少路由或 chat 密钥会在读取输入前拒绝启动。真实调用使用该账号的 API 配额。

真实 API 受控样本与微信手机验收的结果统一见 [项目交接](docs/交接文档.md#4-当前验证与下一步)；更广泛的意图判断、补查、失败处理与引用语义仍需实际样本评估。

搜索回复默认只展示正文和必要限制，不自动附加整串来源标题／URL，并隐藏内部 `[S数字]` 引用标记；来源证据仍保留在内部校验。明确索要出处或链接时，模型可按需在正文提供相关链接。微信、终端路由与独立 chat CLI 使用同一格式化逻辑。

后端结果与发送分别记录。分段发送失败后保留答案、发送进度及失败／未知状态，重复入站不会自动重跑或重发；人工重发交互尚未实现。状态有界且重启清空，见 [应用状态](src/L2.md#职责契约与状态)。

## 本地状态

- `.weave/credentials.json`：登录凭据、扫码者身份、Bot 标识和 API 地址。
- `.weave/cursor.json`：该登录账号的收消息游标，用于后续轮询；不是模型历史。
- `.weave/login-qr.png`：最近一次登录二维码；超时后重新登录获取。
- `.weave/instance.lock`：单实例锁，避免同时开启两个收发进程。

该目录整体忽略提交。事件日志不打印凭据、用户标识或聊天正文；终端调试会显示本地回复。应用的去重、结果与发送记录只在内存中，有容量和时间限制，见 [应用状态](src/L2.md#职责契约与状态)；独立 chat 的内存生命周期见 [chat 状态说明](src/chat/L2.md#内存与并发)。收消息游标在处理完一批消息后保存；跨进程崩溃、缓存淘汰与发送结果未知时不保证严格恰好一次投递。

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

检索阶段只决定是否搜索、搜索什么、读取哪些来源或是否缺少条件；程序调用 Search／Fetch 并回传资料。思考作答阶段取得原问题、问答历史及实际工具结果，资料够用时直接回答；发现关键缺口且预算允许时，最多交回检索阶段补查一次，再结合两次资料完成回答。思考阶段不直接执行工具，补查沿用原来的联网限制、来源和总预算；失败或仍缺资料时说明限制。具体默认值和边界见 [chat 模块](src/chat/L2.md)；当前真实样本验证了思考作答和搜索读取，补查分支及更广泛的质量、耗时仍需另行评估。

不带选项时使用 `auto`，由模型判断是否搜索，不按“搜索／联网”等词语改写策略；引用或翻译这些词不等于要求查网。独立 chat CLI 的 `--offline` 显式传 `off`，`--search` 显式传 `required`；公共接口也可传 `network`。微信与主程序 `--debug` 默认使用 auto，没有独立 chat CLI 的这两个选项。auto 下“不要搜索”等要求由模型理解并遵守，显式 off 才由程序强制禁止 Search／Fetch。

```powershell
# 一次提问；--search 要求外部证据
node src/chat/cli.ts ask --search "查一下 DeepSeek 官方的工具调用说明"
# --offline 仅禁止 Search/Fetch，仍会调用联网的 Chat API
node src/chat/cli.ts ask --offline "把这句话翻译成日语：明天见"
```

交互模式支持连续问答、`/clear` 清空本会话历史、`/exit` 退出，Ctrl+C 取消并退出。结果展示精简答案和必要限制，默认不罗列搜索来源；明确索要的相关链接可在正文中保留。搜索失败、来源检查失败、预算用完等会返回明确状态；不会输出未通过来源检查的草稿。

服务也可通过 [公共接口](src/services.ts) 调用：构造 `ChatService(model, searchProvider)` 后调用 `run(request, signal)`。调用方提供稳定的 `sessionId`／`requestId`，以便重复请求复用结果；缓存有数量与时间限制，重启清空。发送与后端执行分别管理，chat 本身不做微信发送。预算、工具、并发与来源说明见 [模块地图](src/chat/L2.md)。

## 测试

```powershell
# 离线工程检查：类型、自动测试、编译
npm.cmd run check
# 独立 chat 的离线结构检查
npm.cmd run chat:check
# 显式真实 API 验收：读取本机配置并使用账号配额
npm.cmd run test:api
# 本轮审查的受控真实样本及来源状态／缓存验收，同样使用账号配额
npm.cmd run test:review-api
```

默认测试仅保留配置／路由决定解析／回复格式化／答案链接归属／来源目录等纯逻辑与实际终端收发测试，不包含模拟模型、模拟后端或模拟 HTTP，不调用真实 API 或微信。启动子进程限制文件读写权限，验证真实配置检查先于渠道初始化；API 验收独立于默认测试。

`test:api` 用三个固定公开问题检查直接问答、连续追问及搜索读取，所有 HTTP 都真实转发，检查成功响应、思考作答、已读取来源和引用；只显示安全状态与最终答案，不输出密钥、请求头或思考过程。它不代替引用语义人工核对、微信登录或手机送达验收。

`test:review-api` 检查默认／显式网络策略、模型对搜索词与引用／润色要求的理解、真实工具调用、required 下普通中文／英文天气请求的澄清和答案锚点保留，再直接验证真实 Research 搜索摘要／正文状态、同轮缓存与跨轮 unread 初始化。澄清样本不指定固定提问，检查模型最终返回结构化 clarify；普通回答仍保留 required 证据约束。只输出策略、决定类型、调用状态、来源状态及固定公开问题的最终答案，不输出密钥或思考过程；不验证锚点存在、实时新闻准确性或微信送达。验证结果与时间上下文等限制见 [本轮验证记录](docs/首轮审查修复验证_2026-10-23.md)。
