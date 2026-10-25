# Issues #60–#62 修复记录

日期：2026-10-25。基于 `0.11.0`，分支 `codex/fix-issues-60-62`。未更改发布版本。

## #60：安全回退与 checkpoint 性能

- 启用 MCP 的桌面请求在 TLS 就绪前不提交 HTTP headers/body；这个阶段失败会得到本地 `RequestNotSent` 类型，可以回退或等待返回前台后恢复。
- 已经提交、复用连接、未知 socket、移动 fetch 或 fallback 自身失败仍按未知结果处理，禁止自动重复远程工具。
- 两个 provider 都保留未发送状态，背景恢复经过完整 agent/view 路径验证：两次连接尝试，只有一次 POST。
- 每个新的 MCP 回合先完整保存一次原始用户输入和不确定性标记。后续步骤及重试只更新两个小型索引副本，避免每步重新序列化、写入大聊天和附件。
- 索引增加可选 `pendingTurn` / `pendingSavedAt`，按每个聊天的修订与文件 `savedAt` 比较；旧文件不能清除新标记，新完成文件也不会被旧标记覆盖。
- 完整保存、小型 checkpoint 和插件重载共享有序队列；专门覆盖 checkpoint 先等旧写入、完整保存后排队的交错情况。

实机测试在含有既有多条聊天的测试 vault 内进行：1 MiB 合成聊天的后续变更，只写入两个各 25,876 字节的索引，未写任何聊天文件。索引大小随聊天数量变化，并非固定字节数。

## #61：滚动可读摘要与原文留存

- 在请求之间，为早期原文生成滚动可读摘要后，再保留最近约两轮原生压缩窗口的原文。
- 摘要成功前不删除原文；失败有一分钟冷却，Stop 保留原文。摘要边界使用新消息对象，避免破坏编辑/预检回滚快照。
- 切换 provider/model/account 时优先生成一次 handoff 摘要，避免先做存储摘要再重复做 handoff。
- handoff 摘要失败时，仍把之前已保留的可读摘要加入请求，不能丢掉已经释放原文的早期事实。
- 测试连续十轮加密压缩、保存重载、四种身份/模型切换、摘要失败/取消、早期事实和工具相关状态。

实机测试通过真实 ChatGPT OAuth 服务生成摘要，确认保留精确的合成归档键和公制单位约束，释放旧原文，同时不修改旧回滚快照。

这里控制的是 API 原文留存。可见聊天文字继续保留；摘要服务失败时原文会暂时超过目标预算，以免丢失用户内容。

## #62：安全诊断和真实语音复测

- 语音错误保留受限的 service code/message/request ID；识别 HTML 返回，禁止复制代理页面。
- 精确遮盖当前/刷新后的 access token、refresh token、账号 ID，另遮盖 Bearer/JWT/API key 形式及邮箱；不复制任意响应对象、headers 或 SDP。
- 增加 `VOICE_START_FAILED`，标明麦克风、offer、创建会话、answer 或 channel 的失败阶段；失败释放音轨与 peer。
- 在专用测试 vault 中完成 OAuth 登录，用静音生成音轨调用真实语音服务：会话创建、连接及 `session.started` 均成功，结束后音轨已释放。未读取真实麦克风，也未委派工具。

本机账号没有复现报告者的 404，因此这部分是已验证的诊断改进，不能声称报告者的问题已修好。#62 保持打开，需要用新的安全错误信息继续确定其账号、模型访问、路由或网络原因；Windows / Android 实机尚未验证。

## 验证与证据

- 912 项自动测试通过，0 失败。
- TypeScript、Svelte（0 errors / 0 warnings）和生产构建通过。
- 真实本地 Node TLS 覆盖 DNS、连接拒绝、证书失败和请求送达后丢响应。
- 真实 Electron 小型 checkpoint、真实 OAuth 摘要、真实 WebRTC 语音通过。
- [QA 证据](issues-60-62-qa.json) 记录生产 bundle 和测试 bundle 的 SHA-256。测试 bundle 只追加暴露 `VoiceSession` 的临时钩子；验证后已安装原始生产 bundle，钩子已移除。

三个 issue 的开工评论：[#60](https://github.com/o1xhack/obsidian-chatting/issues/60#issuecomment-6402531715)、[#61](https://github.com/o1xhack/obsidian-chatting/issues/61#issuecomment-6402531907)、[#62](https://github.com/o1xhack/obsidian-chatting/issues/62#issuecomment-6402532117)。
