# Issues #60–#62 调研与测试方案

本文件保留修复前的调研基线。后续实现和实机验证见 [修复记录](issues-60-62-fixes.md)；其中首轮未完成的 Obsidian 实测已经补跑。基线探针在修复版本上会提示使用正式回归测试。

日期：2026-10-25。基线：`aefc8d5`，发布版本 `0.11.0`。
分支：`codex/investigate-issues-60-62`。本轮新增调查脚本和报告，产品代码尚未修改。

## 结论

| Issue | 已验证的情况 | 修复方向 |
| --- | --- | --- |
| [#60](https://github.com/o1xhack/obsidian-chatting/issues/60) | 桌面 DNS、连接拒绝和 TLS 证书失败，在服务端未收到 HTTP 请求时也禁止 MCP 回退；两个 API 适配器都产生错误的远程副作用警告 | 在桌面传输层提供可信的“确定未发送”状态，贯穿适配器和恢复逻辑；未知结果继续禁止自动重发 |
| [#61](https://github.com/o1xhack/obsidian-chatting/issues/61) | OpenAI/ChatGPT 连续加密压缩后，请求缩短，保存的 API 历史继续线性增长 | 用滚动的可读摘要覆盖早期事实，再释放旧原文；单纯保留两轮会丢失跨供应商上下文 |
| [#62](https://github.com/o1xhack/obsidian-chatting/issues/62) | 创建语音会话时的 HTTP 错误丢弃正文；三种不同 404 原因在 UI 完全相同 | 先补充安全、结构化诊断，再根据服务端错误确定是模型访问、账号限制、路由还是代理问题；报告者的根因尚未证实 |

复现命令：`node test/investigate-issues-60-62.mjs`。
它在本机临时端口启动 TLS 服务，使用虚构凭据和模拟的 Obsidian fallback，不调用真实 MCP 或 OpenAI 服务。结果写入忽略目录 `temp/issues-60-62/evidence.json`。
本次结果的脱敏快照为 [issues-60-62-evidence.json](issues-60-62-evidence.json)。脚本是基线调查，明确不属于 `npm test` 的回归套件；修复后应将对应预期写成正式回归测试。

## #60：连接失败被误判为可能执行远程工具

### 原因与影响

`src/api/stream.ts` 的 `NoResponse` 只说明没有 HTTP 响应，并没有区分请求是否到达服务器。`streamSSE()` 在启用 MCP 时统一拒绝 fallback。
`src/api/responses-format.ts` 的 catch 和 `src/api/anthropic.ts` 的 `withReceipts()` 又把任何启用 MCP 的传输失败转换为 `remoteEffectsPossible=true`，因此背景恢复也被 `src/agent/loop.ts` 禁止。

本地真实 Node/TLS 实验：

| 故障 | 服务器收到的请求 | 观察到的阶段 | MCP 关闭时 fallback | MCP 开启时 fallback |
| --- | ---: | --- | ---: | ---: |
| DNS 失败 | 0 | socket → ENOTFOUND | 1 | 0 |
| 连接拒绝 | 0 | socket → ECONNREFUSED | 1 | 0 |
| 自签名证书不受信任 | 0 | socket → TCP connect → 证书错误 | 1 | 0 |
| 收到完整请求后关闭连接、不发响应 | 1 | TLS secureConnect → finish → ECONNRESET | 1 | 0 |

最后一行证明现有安全保护确实必要：没有响应不代表没执行。前面三行证明可以做更精确的判断。DNS 使用确定性的自定义 lookup 失败；连接、证书和响应丢失使用本机真实 socket。

### 建议实现

1. 传输层增加不可被服务器内容伪造的类型，例如 `RequestNotSent`；只在本地证据能保证 HTTP 请求没有发出时使用。
2. 优先考虑将 Node 请求的 `write/end` 延后到 TLS 就绪，明确标记“开始提交”；也可追踪新 socket 的 TLS 建立阶段。复用连接、未知 socket 状态、自定义 agent 和已经提交的请求保持保守判断。
3. 对确定未发送的失败允许一次 `requestUrl()` fallback。fallback 已经开始后，其失败再次属于未知结果，不能继承最初的安全状态。
4. OpenAI 和 Anthropic 适配器都保留这个类型；只有它能避免误加远程副作用警告。后续背景恢复必须遵守相同判定及现有次数限制。
5. 用户 Stop 优先，无论是否确定未发送都不应自动回退。移动端 fetch 继续保持未知结果策略。
6. 不靠错误码字符串、`!responded`、`!finish` 或 `bytesWritten===0` 单独证明安全；尤其注意复用 socket 的累计计数和部分写入。

[Node HTTP 文档](https://nodejs.org/api/http.html#event-finish) 说明 `finish` 是请求数据交给操作系统，不保证服务端收到；缺少 `finish` 也不能证明完全没发送。[复用 socket 文档](https://nodejs.org/api/http.html#requestreusedsocket) 说明连接复用本身也会遇到 ECONNRESET，不能仅按错误码自动重试。

### 附带的 checkpoint 性能问题

报告者的评论方向成立，但“每次重试都重新写完整聊天”需要修正：每次确实等待 `checkpointChatHistory()`；内容不变时，digest 会跳过聊天文件写入。

测量中，一个约 1 MiB 的聊天只改变 `pendingTurn`，仍写入两个约 1 MiB 的聊天文件副本和两个小索引。紧接着完全不变的 checkpoint 只写两个索引，不重写聊天文件。正常下一步或 marker 改变时仍会触发大文件写入。

这适合独立后续修复：小型 uncertainty journal，在发送前持久化 `conversationId/turnId/attemptId`；失败时禁止发送。加载必须优先合并未解除的 journal，不能被晚到的聊天保存覆盖。删除、Stop、切换聊天、旧格式和进程中断都要有明确恢复规则。它与 #61 的文件膨胀相互放大，但不应混入传输安全的第一份补丁。

### 回归与验收

- DNS、连接拒绝、证书失败：MCP 打开时也只 fallback 一次，模拟服务器的写操作计数最终为 1。
- 完整提交后无响应、部分提交后断线、接收响应后中断、复用连接重置：禁止自动重发，写操作计数不增加。
- fallback 自身失败、未知 transport、移动 fetch 失败：显示结果不确定，禁止 Continue 自动重复远程操作。
- 背景失败再返回：确定未发送才恢复；Stop/删除聊天不恢复；checkpoint 失败零请求。
- 两个 provider 都验证；增加真实 Node TLS 用例，不能仅靠 fake request 的方法调用顺序。
- Electron 实机加系统代理和 OS 信任但 Node 不信任的证书，确认 UI、fallback 和外部写操作次数一致。

## #61：加密压缩只减少请求，不减少留存

### 原因与测量

`src/agent/history.ts:fromLastCompaction()` 只在 `compaction.summary` 可读时删除旧前缀。OpenAI/ChatGPT 的标记为 `compaction: {}`，因此连续加密压缩不会触发删除。
`src/chat-state.ts:savedConversation()` 也调用同一函数，保存继续保留全部 API 原文。

`src/agent/compaction.ts:afterCompaction()` 和 `buildResponsesInput()` 会从最后一个兼容的原生压缩开始发送，所以网络侧通常正常；问题集中在磁盘、内存和跨供应商摘要成本。

每轮放入 64 KiB 的合成用户文字，两种 provider 都得到以下结果：

| 压缩轮数 | 保存的 API 消息数 | 保存记录字节数（OpenAI） | 原生请求字节数 |
| ---: | ---: | ---: | ---: |
| 1 | 2 | 65,944 | 67 |
| 2 | 4 | 131,736 | 67 |
| 4 | 8 | 263,320 | 67 |
| 8 | 16 | 526,488 | 67 |

这些是合成记录的序列化尺寸，不代表真实模型窗口的大小。实际聊天还保留可见 UI 历史，两个文件副本也增加总占用。

### 为什么不能直接删到上一次加密压缩

加密项可以交回兼容的 provider/model/account，但插件无法读出它里面的旧事实。在换供应商时，`prepareContext()` 从原文生成可读摘要；如果原文已经删除，最早事实就无法传给新供应商。
现有行为是为这个兼容性保留上下文。调查脚本用 `EARLIEST-FACT` 验证了直接截断后的事实丢失。

[OpenAI 压缩文档](https://developers.openai.com/api/docs/guides/compaction) 说明原生压缩项是 opaque，可以用于后续请求；这不提供跨供应商解码能力。现有 `previous_response_id` 和数组重放策略也应分别验证，不能在删除本地消息后继续使用已经失效的游标状态。

### 推荐方案

保留最近约两次原生压缩覆盖的原文，同时维护一份滚动的可读摘要：在释放更老前缀前，先将上一份摘要和新覆盖的文字合并成可读摘要，安装到保留边界。原生 provider 仍使用自己的最新加密项；切换供应商使用可读摘要加近期原文。

- 复用 `AgentLoop.summarize()`：无本地工具、无 MCP、无网页搜索；继续记录摘要 token 用量。
- 摘要成功、非空且没有 Stop 后才提交新边界；错误或取消保留原文，不得静默丢弃事实。
- 在请求之间串行执行，避免正在执行的工具、编辑回滚、附件历史和后台聊天引用失效。
- 对历史上已经很大的聊天，分块生成一次摘要；之后滚动处理新段，避免每次切换都重读全部历史。
- 同时考虑 API 历史的字节/估算 token 阈值，因为“两轮”不等于固定字节数。
- 摘要失败后需要冷却与可见提示；这种安全退化会暂时超过目标预算，不能宣称严格硬上限。若要求摘要一直失败时仍有硬上限，应另外设计原文分块归档和恢复，不能直接丢弃。

需要区分两个目标：API 原文增长可以被这份修复控制；完整的可见聊天记录仍随用户对话增长。若要求整个聊天文件永不超过固定大小，需要额外的分页/归档存储设计。

### 回归与验收

- 至少 10 次连续原生压缩，对 OpenAI、ChatGPT 分别测 API 原文数量、序列化字节和内存引用。
- 把唯一早期事实、文件改动、用户约束、MCP 已完成/未知结果放入第一轮；多次压缩并重启后切换 provider/model/account，再验证事实保留且工具不重复执行。
- 摘要失败、空摘要、Stop、切换聊天、后台运行时不截断；摘要成功后持久化重载得到同一边界。
- 函数调用/结果配对、目录 AGENTS.md 重发、历史编辑限制、用户附件和 omission chip 保持正确。
- 旧版大文件迁移、新版/损坏文件保护、`.next.json` 中断恢复、标题来源和保存 digest 都需测试。
- 长对话 UI 和 API 历史分别测量，不能用“请求缩短”替代“存储受控”的证据。

## #62：语音创建 404，服务端原因尚未取得

### 已知与排除范围

报告者使用插件 0.11.0 / Obsidian 1.14.4，文字与工具正常，PC、Android 手机和平板都报 HTTP 404。语音使用独立的 `gpt-live-1-codex`，切换文字模型不会改变创建语音会话的请求。

`VoiceSession.start()` 先获取麦克风、建立本地 SDP，然后调用 `src/voice/codex.ts` 的 `connect()`。该函数在非 2xx 时只抛出 HTTP 状态，丢弃响应正文和 request ID；关闭通道是失败后的资源清理。

基线模拟三种不同 404：`model_not_found`、`route_not_found`、代理 HTML，全部得到相同的 `Couldn't start voice (HTTP 404).`。因此当前日志不能分辨根因。没有 401 时不刷新 token，本次 404 也不会触发凭据刷新。

本轮核对了 [上游 Codex 的请求实现](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/codex-api/src/endpoint/realtime_call.rs)，并再次读取默认分支：backend-api 的 `realtime/calls`、JSON `{sdp, session}` 以及 `intent=quicksilver&architecture=avas` 仍存在。不能仅凭 404 就改成另一个地址。

[公开 WebRTC 文档](https://developers.openai.com/api/docs/guides/realtime-webrtc) 描述的是项目 API key 的 Live/Realtime 服务，不能用它证明这个 ChatGPT 账号的私有 Codex 路由可访问，也不能把换成 API key 当作当前 OAuth 功能的直接修复。

### 诊断补丁及后续修复分支

先引入结构化语音启动错误：阶段、HTTP 状态、受限的错误 code/type、脱敏并限制长度的 message、允许的 request ID、响应类型、客户端版本。UI 保留简短解释；诊断日志补充具体失败阶段。禁止记录 Authorization、token、完整 headers、SDP、账号标识或响应中的任意对象。HTML 返回只标记为非 JSON，不原样保存。

然后按同一请求的实际响应处理：

| 证据 | 下一步 |
| --- | --- |
| `model_not_found` 或明确模型访问提示 | 核对账号/工作区访问与上游当前语音型号；不能假定任意文字模型有语音资格 |
| `route_not_found`，且不同获准账号也一致 | 对照当前上游及官方客户端实际请求再修改路由/协议，并验证已有账号不回归 |
| HTML 或代理响应 | 在相同设备换网络做对照，记录脱敏 request ID/响应类型；不自动绕过网络策略 |
| 401 | 继续现有同账号一次刷新策略，测试刷新失败和账号变化 |
| 403/明确拒绝访问 | 给出账号服务不可用的准确提示；代码不能制造权限 |
| 同账号官方 Codex 语音也失败 | 账号或上游服务方向优先；保留诊断资料 |
| 同账号官方 Codex 正常、插件失败 | 比较客户端版本、必要 headers、session 参数和返回内容，定位兼容性差异 |

### 实机测试与当前限制

1. 在本机已登录的测试 vault 中，用生成的静音音轨创建一次真实 WebRTC 会话，不读取真实麦克风、不委派任务；捕获安全的 HTTP 错误和启动阶段。成功必须到 `session.started`，仅有 HTTP 201 不够。
2. 再在报告者的 Windows/PC 和 Android 同账号、同网络下测试，收集账号方案/工作区类别、地区、网络代理有无、结构化错误及 request ID。不得要求对方提供 token 或完整私密日志。
3. 路由修复后测试短语音、一次笔记读取、一次沙盒写入、Stop、断网、后台返回、401 刷新，核对每个操作只执行一次。
4. 404/401/403/429/5xx、无效 JSON、HTML、请求超时、空/异常 SDP 均需覆盖；失败必须释放音轨与 peer，不能残留忙碌状态。

本轮未取得真实语音调用结果：本机 Obsidian CLI 在仓库目录和测试 vault 目录都返回 `Vault not found.`，尽管测试 vault 路径存在且注册表列有该路径。未更改 Obsidian 配置、测试 vault 或登录状态。历史语音成功证据不算当前复测；报告者的服务端 404 根因仍待结构化响应确认。

## 本轮验证和实施顺序

相关现有测试：396 项通过，0 失败，覆盖桌面流、MCP、后台恢复、压缩、跨供应商历史、聊天保存和语音。这是修复前基线，不能当作修复验收。

建议先做 #62 的诊断小补丁来取得真实错误，同时实施 #60 的传输状态修复；#61 使用独立历史留存补丁。checkpoint journal 优化单列，避免一次改动同时触及网络副作用保护、历史删除和崩溃恢复。

所有补丁仍需各自的回归测试、真实 Electron/设备验证和正常审查流程，再考虑合并或发布。
