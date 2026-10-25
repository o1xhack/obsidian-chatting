# #62：账号访问差异与 404 提示

日期：2026-10-25。基于已发布的 `0.11.1`，本次仅改进错误提示、设置说明和文档，不更改语音入口或版本号。

## 新证据

[报告者的对照结果](https://github.com/o1xhack/obsidian-chatting/issues/62#issuecomment-6403786800)：免费账号在创建语音会话时得到 `404 / Not Found`，升级付费后没有做其他更改，Windows 立即连接成功；Android 使用未打补丁的插件也能正常语音。其日志包含 connected、session.started 和正常语音回复。

这是报告者自己的 Windows / Android 结果，不是维护者的实机复现。它强烈支持该账号的服务访问权限差异，不能推出所有 404 都是免费套餐限制，也不能保证付费账号一定获得访问。

[官方任务语音说明](https://learn.chatgpt.com/docs/features/voice)列出 Plus、Pro、Business、Edu、Enterprise，并说明账号、rollout 和 workspace 设置会影响可用性。普通 ChatGPT App 的语音可用不等于 Codex 语音可用。

## 修复

- 仅对未提供具体 service code、非 HTML 的通用 404 / Not Found，补充账号可能没有 Codex 语音访问权限的提示，并区分普通 App 语音。
- 保留 HTTP 状态、服务端文字和安全的 request ID；具体模型/路由错误与代理 HTML 仍显示原有诊断。
- 设置和使用指南提前说明访问条件。没有套餐硬编码、自动换入口、404 重试或购买订阅的要求；后续调用仍正常尝试。

## 验证

新增纯文本 Not Found、JSON detail 和空响应的回归用例，均先复现提示缺失，再验证新提示、原始诊断保留、不刷新/重试，以及同一 route 后续调用可成功。已有模型/路由与 HTML 用例确认不会误加账号提示。
