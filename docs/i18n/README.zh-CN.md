# Chatting with AI

[![最新版本](https://img.shields.io/github/v/release/o1xhack/obsidian-chatting?include_prereleases&label=release&color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![下载总数](https://img.shields.io/github/downloads/o1xhack/obsidian-chatting/total?color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![许可证](https://img.shields.io/github/license/o1xhack/obsidian-chatting?color=7c3aed)](../../LICENSE)
[![Obsidian](https://img.shields.io/badge/obsidian-1.11.4%2B-7c3aed)](https://obsidian.md)
<br>
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-o1xhack-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/o1xhack)

**移动端优先的 AI 助手，通过对话阅读、修改和整理你的 Obsidian 笔记库。**

> 🌐 [English](../../README.md) · **简体中文** · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

<p align="center">
  <img src="../../assets/screenshot-settings.png" alt="iPhone 上的 Provider 设置页" width="260">
  <img src="../../assets/screenshot-chat-cn.png" alt="联网搜索后的中文回答" width="260">
  <img src="../../assets/screenshot-chat-en.png" alt="带列表的英文回答" width="260">
</p>

---

## ✨ 用对话完成笔记里的工作

Chatting with AI 把一句话变成 Obsidian 里的实际操作：查找相关笔记、修改草稿、整理项目，或调整 Canvas。核心能力分为六组：

- 📱 **移动端优先，轻量使用** — 手机、平板和桌面都能用，无需建立笔记库索引或部署独立后端。
- 🧰 **能动手的笔记助手** — 通过 22 个内置工具搜索和修改笔记、整理文件与属性、查看链接、操作 Canvas、读取网页。
- 📎 **由你选择任务上下文** — 使用当前笔记、把修改限制在选区、通过 `@` 或 `[[` 引用文件，并带上图片、PDF 和 Office 文档。
- 🧩 **可复用的个人工作流** — 用 `AGENTS.md` 说明笔记库规则，用 Skills 保存常用任务，也能通过 `/name` 直接调用。
- 👀 **看得见、可撤销的改动** — 跟随修改定位到笔记段落或 Canvas 卡片，查看执行步骤，并在本次会话的快照仍可用时撤销某次回答的改动。
- 💬 **独立且可继续的对话** — 为不同任务保留命名会话，重启后接着聊，也能编辑之前的消息、重新生成回答。

支持 **Anthropic API**、**OpenAI API** 和 **ChatGPT 账号登录**三种连接方式，沿用你已有的 AI 使用习惯。

## 🎬 可以拿它做什么

### 在笔记、文件和 Canvas 之间完成工作

直接用自然语言提要求。助手会选择工具、阅读相关资料，再在笔记库里执行操作。

> 找出 Books 文件夹里缺少评分的笔记，加上 `rating: ?`。
>
> 对比这几篇会议记录，把决定整理成项目计划。
>
> 把 Canvas 上的想法分组，连接相关卡片。

按内容、标签或属性查找笔记；检查入链、出链和未链接提及；读取和编辑 Canvas 卡片及连线；查看库内图片，并把网页读成文本。

### 为每个任务提供合适的上下文

从当前笔记开始，或输入 `@` / `[[` 引用指定文件。通过输入框或粘贴附加图片、PDF、Word、Excel、PowerPoint 和文本文件。Canvas 可以提供结构大纲，也能由助手查看画面布局。

只想改一段时，选中文字并选择 **Send selection to chat**。工具会把对该笔记的直接编辑限制在选区内；其他笔记仍可编辑，重命名其他文件时，Obsidian 也仍可能更新这里的链接。

### 让助手遵循你的工作方式

根目录的 `AGENTS.md` 定义整个库的规则；某个文件夹中的 `AGENTS.md` 会在对话首次涉及该目录时补充局部规则。在库内 `Skills` 文件夹中保存可复用任务，每个任务包含 `SKILL.md`，还可以带模板和示例。助手能按任务加载相应技能，你也可以输入 `/` 主动选择。

Skills 沿用 Claude Code / Codex 的文件夹格式。助手可以读取说明和配套文件，但不会执行其中的脚本。

### 检查改动，继续对话

**Follow the AI's edits** 会定位到修改的笔记段落或 Canvas 卡片，同时保留聊天输入焦点。完成的工具步骤折叠成一行，需要时展开。每次回答的 **Undo** 可以还原记录下来的编辑、创建、重命名和删除；如果文件之后又被修改，会先询问。撤销快照有容量限制且仅保存在内存里，重启或快照过期后不能再撤销。

可以新建、切换、重命名和删除独立会话，每个会话只向模型发送自己的聊天记录，重启 Obsidian 后也能继续。还支持编辑历史消息、复制回答和重新生成最后一次回答。编辑或重新生成不会撤销已经发生的文件改动。

回答随模型写作实时显示，并支持 Markdown、表格、双链和数学公式。向上阅读旧消息时不会被强制拉回底部，需要时可以一键回到最新回答。

## ⚙️ 三种连接方式

| 连接方式 | 需要什么 | 如何使用 |
|---|---|---|
| **Anthropic** | Anthropic API key | 使用 Claude 模型；思考和网页搜索能力取决于模型。 |
| **OpenAI** | OpenAI API key | 通过 Responses API 使用 OpenAI 模型；推理和网页搜索能力取决于模型。 |
| **ChatGPT 账号** | 具备 Codex 访问权限的 ChatGPT 套餐 | 登录账号，使用该账号可访问的 Codex 模型。 |

模型列表从对应服务或账号获取，缓存 24 小时，也可以随时手动刷新；服务提供相关信息时，思考等级跟随模型目录。实际可用模型及权限取决于服务和账号。

桌面端 ChatGPT 登录会打开浏览器并自动返回。桌面也可用设备验证码登录，手机当前采用这一方式。凭据按设备保存，同步笔记库不会让另一台设备自动登录。

## 🚀 快速上手

需要 **Obsidian 1.11.4 或更新版本**，支持桌面、iOS 和 Android。

1. 打开 **设置 → 社区插件 → 浏览**。
2. 搜索 **Chatting with AI**，点击 **安装**，再点击 **启用**。
3. 打开 **设置 → Chatting with AI**，选择连接方式。
4. 填入 API key，或连接 ChatGPT 账号。
5. 从侧边栏图标或命令面板打开聊天，开始处理笔记。

## 📦 安装

### 社区插件(推荐)

Chatting with AI 已进入官方 Obsidian 社区插件目录,这是默认的首选安装方式。

1. 在 Obsidian 里打开 **设置 → 社区插件**。
2. 如果有提示,先关闭 Restricted Mode / 打开社区插件。
3. 点击 **浏览**,搜索 **Chatting with AI**。
4. 点击 **安装**,然后点击 **启用**。

### 从 BRAT 迁移

如果你之前通过 BRAT 安装了 beta 版本,等插件市场里能搜到后可以迁移到社区版本:

1. 在 **设置 → 社区插件 → 已安装插件** 里先停用 **Chatting with AI**。
2. 打开 **BRAT** 设置,从 beta 插件列表中移除 `o1xhack/obsidian-chatting`。
3. 回到 **设置 → 社区插件 → 浏览**,搜索 **Chatting with AI**。
4. 如果 Obsidian 显示 **已安装**,进入插件详情后点击 **启用**。如果显示 **安装**,点击 **安装**,然后 **启用**。
5. 打开 **设置 → Chatting with AI**,确认 provider 设置仍然存在。

插件首次启动时会把旧的 `obsidian-chatting` 文件夹数据迁移到 `chatting-with-ai`。如果你用的是很早的 beta,社区插件浏览器没有识别为已安装,直接安装社区版本也可以;新插件启动时会执行迁移。

<details>
<summary><b>手动 release 安装</b></summary>

1. 从 [最新发布版本](https://github.com/o1xhack/obsidian-chatting/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<vault>/.obsidian/plugins/chatting-with-ai/`
3. 重启 Obsidian,在社区插件里启用 **Chatting with AI**

</details>

<details>
<summary><b>从源码构建</b></summary>

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run build
```

软链到测试 vault:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/chatting-with-ai
```

</details>

## 🔐 隐私与控制

- **不在后台上传或索引整个库。** 消息、当前笔记上下文、引用或附加的文件、加载的规则及工具读取的资料，会按对话需要发送给选定的模型服务。这是云端模型助手，不是设备端本地模型。
- **凭据使用 Obsidian SecretStorage。** API key 和 ChatGPT 登录凭据不写入插件的 `data.json`，每台设备需要单独连接。
- **聊天历史保存在笔记库的插件目录。** 命名会话的列表写入 `chat-state.json`，每个聊天各存为 `chats` 文件夹中的一个文件。插件没有聊天同步服务，这些文件是否到达其他设备取决于你的同步设置。附件数据有保留上限，较旧附件可能只显示名称。
- **改动直接发生在笔记库里。** 选区限制针对选中笔记的直接编辑；撤销依赖当前可用的快照，长期恢复请使用日常备份或版本历史。
- **网页与附件属于外部输入。** 读取网页会使用本机网络，包括本机能访问的局域网地址。不要把网页或文件里隐藏的指令当作可信规则。附件和请求设有容量限制，以控制设备内存和请求大小。

附件限制、不同模型对 PDF / Office 的处理方式、完整工具列表、设置和恢复说明见 **[使用指南（英文）](../user-guide.md)**。已记录的验证范围见[桌面与 iPhone 验收记录](../phase1-review.md)。

## 🗺️ 接下来

命名会话、图片和文档附件、模型目录刷新、Canvas、笔记库规则和 Skills 均已提供。**历史会话的归档与搜索仍在路线图中。** 每个版本的变化见[发布记录](https://github.com/o1xhack/obsidian-chatting/releases)，也欢迎[提交 Issue](https://github.com/o1xhack/obsidian-chatting/issues) 反馈。

## 🤝 参与贡献

欢迎 Issue 和 PR。代码改动请运行 `npm test`、`npx tsc --noEmit`、`npm run svelte-check` 和 `npm run build`；影响应用使用的改动，还应至少在一个移动平台上验证。较大改动请先开 Issue 对齐方向。

## 🙏 致谢

最初衍生自 [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat)（MIT），原版权信息保留在 `LICENSE` 中。Chatting with AI 现在是独立项目，拥有自己的 agent loop、移动端支持、ChatGPT 账号连接和笔记库工作流。

感谢 [Thomas Schierl](https://github.com/thomas0schierl) 对聊天持久化、渲染、笔记工具和回归测试框架的贡献。

## 📄 许可证

[MIT](../../LICENSE)。

---

作者：[Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
