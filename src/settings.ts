import { App, Modal, Notice, PluginSettingTab, Setting, SliderComponent, normalizePath, requireApiVersion, type SettingDefinitionItem, type TextComponent } from "obsidian";
import type ChatPlugin from "./main";
import type { ChatSettings, McpServer, Provider } from "./types";
import { DEFAULT_PROVIDER_MODELS } from "./types";
import type { ChatGPTDeviceAuthorization, PollHandle } from "./auth/chatgptOAuth";
import { clearDebugLog } from "./debug";
import { INSTRUCTIONS_FILE } from "./agent/instructions";
import { DEFAULT_SKILLS_FOLDER, SKILL_FILE, SKILL_TEMPLATE, findSkills, type Skill } from "./agent/skills";
import { validServerName, validServerUrl } from "./api/mcp";
import { MIN_COMPACT_TOKENS, compactThreshold, defaultCompactThreshold } from "./agent/compaction";
import { formatTokens } from "./agent/usage";
import { formatBytes } from "./images";

import { type ModelOption, type CatalogState, catalogIdentity, cachedCatalog, refreshCatalog, getCatalogModels, clearCatalogModels, catalogModel, catalogDefaultLevel, resolveThinkingLevel, thinkingLevelLabel, CATALOG_TTL } from "./api/model-catalog";

const CUSTOM_MODEL_OPTION = "__custom__";

/** The MCP heading row's name, in its definition and on the row (MCP is an acronym). */
const MCP_SERVERS = "MCP servers";

/** A new AGENTS.md: a comment saying what goes in it (the AI reads it too, harmlessly). */
const INSTRUCTIONS_TEMPLATE = "<!-- Instructions for AI assistants working in this vault (Chatting with AI and other tools that read AGENTS.md). Write each instruction as a plain sentence below. -->\n\n";

const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
  // CLI catalog entries are not guaranteed to be available to every account.
  // Keep the default confirmed by user reports; other IDs remain customizable.
  "chatgpt-oauth": [
    { value: "gpt-5.5", label: "GPT-5.5 (recommended)" },
  ],
};



/** Resolve a model ID to its display name */
export function getModelDisplayName(provider: string, modelId: string): string {
  const cached = getCatalogModels(provider as Provider);
  const models = cached || FALLBACK_MODELS[provider] || [];
  const match = models.find((m) => m.value === modelId);
  return match?.label || modelId;
}

/** Chat header: the model name, plus the thinking level when the model offers levels. */
export function getModelHeaderLabel(provider: Provider, modelId: string, level: string): string {
  const thinking = thinkingLevelLabel(catalogModel(provider, modelId), level);
  const name = getModelDisplayName(provider, modelId);
  return thinking ? `${name} · ${thinking}` : name;
}

/** A token number as typed: "160000", "160 000", "160k", "1.2M"; null when empty or not a number. */
export function parseTokens(value: string): number | null {
  const match = /^([\d.,]+)\s*([km]?)$/i.exec(value.replace(/[\s_']/g, ""));
  if (!match) return null;
  const number = Number.parseFloat(match[1].replace(/,/g, ""));
  const scale = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1000 : 1;
  return Number.isFinite(number) && number > 0 ? Math.round(number * scale) : null;
}

/**
 * Settings for the Test buttons: one word back, as fast as the model allows.
 * No web search, no MCP servers and the lightest thinking level the catalog
 * lists (providers list them lightest first); the chat settings stay as they are.
 */
function connectionTestSettings(settings: ChatSettings): ChatSettings {
  const efforts = catalogModel(settings.provider, settings.model)?.reasoningEfforts;
  return { ...settings, enableWebSearch: false, mcpServers: [], thinkingLevel: efforts?.[0] ?? settings.thinkingLevel };
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatPlugin;
  private catalogModels?: ModelOption[];
  private catalogIdentity = "";
  private loadingCatalog = false;
  private catalogError = "";
  private apiKeyEditing = false;
  private apiKeyTimer?: number;
  /** Set while the tab is closed, so pending redraws (timers, model list loads) skip it. */
  private hidden = false;
  /** "Custom..." is picked in the model dropdown: show the model ID field. */
  private editingCustomModel = false;

  constructor(app: App, plugin: ChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Scopes the wrapping rows in styles.css (several buttons on a phone).
    this.containerEl.addClass("ochatting-settings");
  }

  hide(): void {
    super.hide();
    this.hidden = true;
    this.editingCustomModel = false;
  }

  // Obsidian 1.13+ indexes these definitions; older versions retain display().
  getSettingDefinitions(): SettingDefinitionItem[] {
    // Called each time the tab is shown on 1.13+ (and once for indexing).
    this.hidden = false;
    return [
      { name: "Provider", render: setting => this.renderProvider(setting) },
      { name: "API key", visible: () => this.plugin.settings.provider !== "chatgpt-oauth", render: setting => this.renderApiKeySection(setting.settingEl.parentElement!, setting) },
      { name: "ChatGPT account", visible: () => this.plugin.settings.provider === "chatgpt-oauth", render: setting => this.renderChatGPTOAuthSection(setting.settingEl.parentElement!, setting) },
      { name: "Model", aliases: ["Refresh models"], render: setting => {
        this.renderModelSection(setting.settingEl.parentElement!, setting);
        void this.loadCatalog(false);
      } },
      // Its own definition: a row added next to another definition's row doesn't show.
      { name: "Custom model ID", visible: () => this.editingCustomModel, render: setting => this.renderCustomModel(setting) },
      { name: "Thinking level", visible: () => !!this.thinkingOptions(), render: setting => this.renderThinkingLevel(setting) },
      { name: "Web search", render: setting => this.renderWebSearch(setting) },
      { name: "Enter sends message", aliases: ["Keyboard", "New line"], render: setting => this.renderEnterSends(setting) },
      { name: "Follow the AI's edits", aliases: ["Show edits", "Highlight"], render: setting => this.renderFollowEdits(setting) },
      { name: "Vault instructions", aliases: ["AGENTS.md", "Instructions"], render: setting => this.renderInstructions(setting) },
      { name: "Skills", aliases: ["Skill", "SKILL.md", "Skills folder"], render: setting => this.renderSkillsFolder(setting) },
      this.skillList(),
      { name: "Max tool iterations", render: setting => this.renderMaxIterations(setting) },
      { type: "group", heading: "Chats", items: [
        { name: "Compaction point", aliases: ["Context", "Summarize", "Compact"], render: setting => this.renderCompactionPoint(setting) },
        { name: "Saved chats", aliases: ["Chat history", "Storage"], render: setting => this.renderSavedChats(setting) },
      ] },
      { name: MCP_SERVERS, aliases: ["Connectors", "Model Context Protocol"], render: setting => this.renderMcpHeading(setting) },
      this.mcpServerList(),
      { name: "Debug log", aliases: ["Troubleshooting"], render: setting => this.renderDebugLog(setting) },
    ];
  }

  private refreshSettingsTab(): void {
    if (this.hidden) return;
    if (requireApiVersion("1.13.0")) this.update();
    else this.display();
  }

  display(): void {
    this.hidden = false;
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    this.renderProvider(new Setting(containerEl));

    // ─── Auth section: API key OR OAuth Connect ───────────────────────
    if (s.provider === "chatgpt-oauth") {
      this.renderChatGPTOAuthSection(containerEl);
    } else {
      this.renderApiKeySection(containerEl);
    }

    // ─── Model ────────────────────────────────────────────────────────
    this.renderModelSection(containerEl);
    if (this.editingCustomModel) this.renderCustomModel(new Setting(containerEl));
    if (this.thinkingOptions()) this.renderThinkingLevel(new Setting(containerEl));
    void this.loadCatalog(false);

    this.renderWebSearch(new Setting(containerEl));
    this.renderEnterSends(new Setting(containerEl));
    this.renderFollowEdits(new Setting(containerEl));
    this.renderInstructions(new Setting(containerEl));
    this.renderSkills(containerEl);
    this.renderMaxIterations(new Setting(containerEl));
    this.renderChats(containerEl);
    this.renderMcpServers(containerEl);
    this.renderDebugLog(new Setting(containerEl));
  }

  private renderProvider(setting: Setting): void {
    const s = this.plugin.settings;
    // ─── Provider ─────────────────────────────────────────────────────
    setting
      .setName("Provider")
      .setDesc("Which AI provider to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("anthropic", "Anthropic")
          .addOption("openai", "OpenAI")
          .addOption("chatgpt-oauth", "ChatGPT OAuth")
          .setValue(s.provider)
          .onChange(async (value) => {
            // Load the new provider's key BEFORE saving,
            // otherwise the old provider's key gets saved under the new provider name
            clearCatalogModels(s.provider);
            this.catalogModels = undefined;
            this.catalogIdentity = "";
            s.provider = value as Provider;
            s.model = DEFAULT_PROVIDER_MODELS[s.provider];
            // Each provider names its own levels: start from the model's default.
            s.thinkingLevel = "";
            this.editingCustomModel = false;
            this.plugin.reloadApiKeyForProvider();
            await this.plugin.saveSettings();
            window.setTimeout(() => this.refreshSettingsTab(), 10);
          })
      );

  }
  private renderWebSearch(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Web search")
      .setDesc("Allow the model to search the web when it needs current information")
      .addToggle((toggle) =>
        toggle
          .setValue(s.enableWebSearch)
          .onChange(async (value) => {
            s.enableWebSearch = value;
            await this.plugin.saveSettings();
          })
      );

  }
  private renderEnterSends(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Enter sends message")
      .setDesc("On: Enter sends, Shift+Enter starts a new line. Off: Enter starts a new line; send with the send button or Ctrl+Enter (Cmd+Enter on a Mac).")
      .addToggle((toggle) =>
        toggle
          .setValue(s.enterSends)
          .onChange(async (value) => {
            s.enterSends = value;
            await this.plugin.saveSettings();
          })
      );
  }
  private renderFollowEdits(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Follow the AI's edits")
      .setDesc("When the AI changes a note or canvas, it opens next to the chat at the changed spot: changed text is highlighted, changed canvas cards are selected. Also the eye button in the chat header.")
      .addToggle((toggle) =>
        toggle
          .setValue(s.followEdits)
          .onChange(async (value) => {
            s.followEdits = value;
            await this.plugin.saveSettings();
          })
      );
  }
  /** AGENTS.md at the vault root: open it, or create it first. */
  private renderInstructions(setting: Setting): void {
    const exists = !!this.app.vault.getFileByPath(INSTRUCTIONS_FILE);
    setting
      .setName("Vault instructions")
      .setDesc(`Standing instructions for the AI, in ${INSTRUCTIONS_FILE} at the vault root; every chat follows them. A folder can have its own ${INSTRUCTIONS_FILE} for its notes.${exists ? "" : " There is none yet."}`)
      .addButton((button) => button.setButtonText(exists ? "Open" : "Create").onClick(async () => {
        const file = this.app.vault.getFileByPath(INSTRUCTIONS_FILE)
          ?? await this.app.vault.create(INSTRUCTIONS_FILE, INSTRUCTIONS_TEMPLATE);
        await this.app.workspace.getLeaf("tab").openFile(file);
        this.refreshSettingsTab();
      }));
  }

  // ─── Skills ────────────────────────────────────────────────────────────

  /** The skills folder; the skills found there are listed below it. */
  private renderSkillsFolder(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Skills")
      .setDesc("Instructions for particular tasks, a folder each with a SKILL.md, in this vault folder. The AI uses a skill when a task matches its description; type /name in the chat to use one yourself.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SKILLS_FOLDER).setValue(s.skillsFolder).onChange(async (value) => {
          s.skillsFolder = value.trim() || DEFAULT_SKILLS_FOLDER;
          await this.plugin.saveSettings();
        });
        // The list follows once the name is typed.
        text.inputEl.addEventListener("blur", () => this.refreshSettingsTab());
      });
  }

  /** Obsidian 1.13+: the skills found, each opening its SKILL.md; "New skill" starts one from a template. */
  private skillList(): SettingDefinitionItem {
    return {
      type: "list",
      emptyState: `No skills in ${this.plugin.settings.skillsFolder}/ yet.`,
      items: findSkills(this.app, this.plugin.settings.skillsFolder).map((skill) => ({
        name: `/${skill.name}`,
        aliases: ["Skill"],
        render: (setting: Setting) => this.renderSkill(setting, skill),
      })),
      addItem: { name: "New skill", action: () => void this.createSkill() },
    };
  }

  /** Before Obsidian 1.13: the same as rows, with a New skill button below them. */
  private renderSkills(containerEl: HTMLElement): void {
    this.renderSkillsFolder(new Setting(containerEl));
    const skills = findSkills(this.app, this.plugin.settings.skillsFolder);
    for (const skill of skills) this.renderSkill(new Setting(containerEl), skill);
    this.renderNewSkill(new Setting(containerEl), skills.length === 0);
  }

  private renderSkill(setting: Setting, skill: Skill): void {
    setting
      .setName(`/${skill.name}`)
      .setDesc(skill.description || "No description: the AI can't tell when to use it. Add one to its properties.")
      .addExtraButton((button) => button.setIcon("file-text").setTooltip(`Open ${skill.path}`).onClick(() => {
        const file = this.app.vault.getFileByPath(skill.path);
        if (file) void this.app.workspace.getLeaf("tab").openFile(file);
      }));
  }

  private renderNewSkill(setting: Setting, empty: boolean): void {
    setting
      .setDesc(empty ? `No skills in ${this.plugin.settings.skillsFolder}/ yet.` : "")
      .addButton((button) => button.setButtonText("New skill").onClick(() => void this.createSkill()));
  }

  /** A new skill folder with a SKILL.md from the template, opened in a new tab. */
  private async createSkill(): Promise<void> {
    const folder = normalizePath(this.plugin.settings.skillsFolder || DEFAULT_SKILLS_FOLDER);
    let name = "new-skill";
    for (let i = 2; this.app.vault.getAbstractFileByPath(`${folder}/${name}`); i++) name = `new-skill-${i}`;
    for (const path of [folder, `${folder}/${name}`]) {
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
    }
    const file = await this.app.vault.create(`${folder}/${name}/${SKILL_FILE}`, SKILL_TEMPLATE(name));
    await this.app.workspace.getLeaf("tab").openFile(file);
    this.refreshSettingsTab();
  }

  private renderMaxIterations(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Max tool iterations")
      .setDesc("Safety limit for the agent loop (default: 20)")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(s.maxIterations))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0 && n <= 100) {
              s.maxIterations = n;
              await this.plugin.saveSettings();
            }
          })
      );
  }

  // ─── Chats ─────────────────────────────────────────────────────────────

  /** Before Obsidian 1.13: the Chats heading and its rows (a group on 1.13+). */
  private renderChats(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Chats").setHeading();
    this.renderCompactionPoint(new Setting(containerEl));
    this.renderSavedChats(new Setting(containerEl));
  }

  /**
   * The compaction point: a slider over the selected model's window from
   * 50k (or the default point where that is lower) to 100 %, with its
   * start, the default point and its end labelled, and the point in tokens
   * in a field. Without a known window only the field, as a token number.
   */
  private renderCompactionPoint(setting: Setting): void {
    const s = this.plugin.settings;
    const option = catalogModel(s.provider, s.model);
    const window = option?.contextWindow;
    const fallback = defaultCompactThreshold(s.provider, option);
    setting.setName("Compaction point");
    const describe = () => {
      const point = compactThreshold(s.provider, option, s);
      const base = "When a long chat is summarized, so it stays within the model's context. Earlier saves cost and time per answer; the model then keeps fewer details.";
      if (!window) {
        setting.setDesc(`${base} This model's context size is unknown: set a number of tokens, or leave it empty to summarize only when a request is too long.`);
      } else {
        const share = Math.round((point ?? 0) / window * 100);
        setting.setDesc(`${base} Now ${formatTokens(point ?? 0)} of ${formatTokens(window)} tokens (${share} %${s.compactPercent === null ? ", the default" : ""}).`);
      }
    };
    let field: TextComponent | undefined;
    let slider: SliderComponent | undefined;
    if (window && fallback) {
      const low = Math.min(MIN_COMPACT_TOKENS, fallback);
      const min = Math.ceil(low / window * 100);
      const standard = Math.round(fallback / window * 100);
      const box = setting.controlEl.createDiv({ cls: "ochatting-compaction-box" });
      // The default above the slider, its start and end below: they don't collide.
      const above = box.createDiv({ cls: "ochatting-compaction-marks is-above" });
      slider = new SliderComponent(box)
        .setLimits(min, 100, 1)
        .setValue(Math.round((compactThreshold(s.provider, option, s) ?? fallback) / window * 100))
        .onChange(async (value) => {
          // On the mark: the default (it follows the model's own point).
          s.compactPercent = value === standard ? null : value;
          field?.setValue(String(compactThreshold(s.provider, option, s) ?? ""));
          describe();
          await this.plugin.saveSettings();
        });
      const below = box.createDiv({ cls: "ochatting-compaction-marks" });
      const mark = (marks: HTMLElement, at: number, text: string, cls: string) => {
        const el = marks.createSpan({ cls: `ochatting-compaction-mark ${cls}`, text });
        el.setCssProps({ "--ochatting-mark-at": `${(at - min) / (100 - min) * 100}%` });
      };
      mark(above, standard, `Default: ${standard} % · ${formatTokens(fallback)}`, "is-default");
      mark(below, min, formatTokens(low), "is-start");
      mark(below, 100, `100 % · ${formatTokens(window)}`, "is-end");
    }
    setting.addText((text) => {
      field = text;
      text.inputEl.addClass("ochatting-compaction-field");
      text.setPlaceholder(window ? String(fallback ?? "") : "Tokens");
      text.setValue(String((window ? compactThreshold(s.provider, option, s) : s.compactTokens) ?? ""));
      // Saved when the field is left or Enter is pressed, not per keystroke.
      const commit = async () => {
        const tokens = parseTokens(text.getValue());
        if (window && fallback) {
          if (tokens === null) s.compactPercent = null;
          else s.compactPercent = tokens === fallback ? null : Math.min(100, tokens / window * 100);
          const point = compactThreshold(s.provider, option, s);
          text.setValue(String(point ?? ""));
          slider?.setValue(Math.round((point ?? fallback) / window * 100));
        } else {
          s.compactTokens = tokens;
          text.setValue(tokens === null ? "" : String(tokens));
        }
        describe();
        await this.plugin.saveSettings();
      };
      text.inputEl.addEventListener("change", () => void commit());
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          void commit();
        }
      });
    });
    describe();
  }

  /** How many chats are saved and their size; large ones are marked in the chat list. */
  private renderSavedChats(setting: Setting): void {
    const { chats, bytes } = this.plugin.savedChatsSize();
    setting
      .setName("Saved chats")
      .setDesc(`${chats === 1 ? "1 chat" : `${chats} chats`}, ${formatBytes(bytes)}, in the plugin's chats folder. A chat over 5 MB shows its size in the chat list; delete chats you no longer need there.`);
  }

  // ─── MCP servers ───────────────────────────────────────────────────────

  private renderMcpHeading(setting: Setting): void {
    setting
      .setName(MCP_SERVERS)
      .setDesc(this.plugin.settings.provider === "chatgpt-oauth"
        ? "Remote MCP servers work with an Anthropic or OpenAI API key; the ChatGPT account doesn't offer them."
        : "Remote servers (public https) whose tools the AI can use. The provider connects to them and calls their tools without asking, so add only servers you trust.");
  }

  /** Obsidian 1.13+: the servers as a list, one row each; add and delete. */
  private mcpServerList(): SettingDefinitionItem {
    const s = this.plugin.settings;
    return {
      type: "list",
      emptyState: "No servers yet.",
      items: (s.mcpServers ?? []).map((server) => ({
        name: server.name || "New server",
        aliases: ["MCP"],
        render: (setting: Setting) => this.renderMcpServer(setting, server),
      })),
      onDelete: (index) => {
        const server = s.mcpServers[index];
        if (server) void this.removeMcpServer(server.id);
      },
      addItem: { name: "Add server", action: () => void this.addMcpServer() },
    };
  }

  /** Before Obsidian 1.13: the same as rows, each with a remove button, and Add server below them. */
  private renderMcpServers(containerEl: HTMLElement): void {
    this.renderMcpHeading(new Setting(containerEl));
    for (const server of this.plugin.settings.mcpServers ?? []) {
      this.renderMcpServer(new Setting(containerEl), server, true);
    }
    this.renderAddMcpServer(new Setting(containerEl));
  }

  /** One server's row: what is missing (or on/off), name, address, token, on/off; Remove where no list deletes it. */
  private renderMcpServer(setting: Setting, server: McpServer, removable = false): void {
    const s = this.plugin.settings;
    const status = () => {
      const problems = [
        ...(validServerName(server.name) ? [] : ["a name of letters, digits, - or _"]),
        ...(validServerUrl(server.url) ? [] : ["an https address"]),
      ];
      const duplicate = !!server.name && (s.mcpServers ?? []).some((other) => other !== server && other.name === server.name);
      setting.setName(server.name || "New server");
      setting.setDesc(problems.length ? `Needs ${problems.join(" and ")}.` : duplicate ? "Another server has this name." : server.enabled ? "On" : "Off");
    };
    const save = async () => {
      status();
      await this.plugin.saveSettings();
    };
    setting
      .setClass("ochatting-mcp-server")
      .addText((text) => text.setPlaceholder("Name").setValue(server.name).onChange(async (value) => {
        server.name = value.trim();
        await save();
      }))
      .addText((text) => text.setPlaceholder("https://…").setValue(server.url).onChange(async (value) => {
        server.url = value.trim();
        await save();
      }))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Token (optional)").setValue(server.token ?? "").onChange(async (value) => {
          server.token = value.trim() || undefined;
          await save();
        });
      })
      .addToggle((toggle) => toggle.setValue(server.enabled).setTooltip("Use this server").onChange(async (value) => {
        server.enabled = value;
        await save();
      }));
    if (removable) {
      setting.addExtraButton((button) => button.setIcon("trash").setTooltip("Remove").onClick(() => void this.removeMcpServer(server.id)));
    }
    status();
  }

  private renderAddMcpServer(setting: Setting): void {
    setting
      .setDesc(this.plugin.settings.mcpServers?.length ? "" : "No servers yet.")
      .addButton((button) => button.setButtonText("Add server").onClick(() => void this.addMcpServer()));
  }

  private async addMcpServer(): Promise<void> {
    const s = this.plugin.settings;
    s.mcpServers = [...s.mcpServers ?? [], { id: `mcp-${Date.now().toString(36)}`, name: "", url: "", enabled: true }];
    await this.plugin.saveSettings();
    this.refreshSettingsTab();
  }

  private async removeMcpServer(id: string): Promise<void> {
    await this.plugin.removeMcpServer(id);
    this.refreshSettingsTab();
  }

  private renderDebugLog(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Debug log")
      .setDesc("For troubleshooting: writes requests and errors to debug.log in the plugin folder, including your messages (never keys). Copy it to send it on.")
      .addToggle((toggle) =>
        toggle
          .setValue(s.debugLog)
          .onChange(async (value) => {
            s.debugLog = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) => button.setButtonText("Copy").onClick(() => void this.plugin.copyDebugLog()))
      .addButton((button) => button.setButtonText("Clear").onClick(async () => {
        await clearDebugLog(this.app);
        new Notice("Debug log cleared.");
      }));
  }

  // ─── API key + test (anthropic / openai) ──────────────────────────────────

  private renderApiKeySection(containerEl: HTMLElement, row?: Setting): void {
    const s = this.plugin.settings;

    const apiKeySetting = (row ?? new Setting(containerEl))
      .setName("API key")
      .setDesc(s.apiKey ? "Key saved" : "Enter your API key to get started")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(s.apiKey)
          .onChange(async (value) => {
            this.apiKeyEditing = true;
            window.clearTimeout(this.apiKeyTimer);
            const hadKey = s.apiKey;
            s.apiKey = value.trim();
            const editedKey = s.apiKey;
            await this.plugin.saveSettings();
            if (s.apiKey !== editedKey) return;
            if (hadKey !== s.apiKey) {
              clearCatalogModels(s.provider);
              this.catalogModels = undefined;
              this.catalogIdentity = "";
            }
            this.apiKeyTimer = window.setTimeout(() => {
              this.apiKeyEditing = false;
              this.refreshSettingsTab();
            }, 800);
          });
      });

    if (s.apiKey) {
      apiKeySetting.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          try {
            const { sendMessage } = await import("./api/client");
            const response = await sendMessage(
              connectionTestSettings(s),
              [{ role: "user", content: "Say hello in one word." }],
              [],
              "You are a test. Respond with one word."
            );
            const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            new Notice(`Connected! Response: "${text}"`);
            apiKeySetting.setDesc("Connection successful");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`Connection failed: ${msg}`);
            apiKeySetting.setDesc(`Failed: ${msg}`);
          } finally {
            button.setButtonText("Test");
            button.setDisabled(false);
          }
        })
      );
    }
  }

  // ─── ChatGPT OAuth ────────────────────────────────────────────────────────

  private renderChatGPTOAuthSection(containerEl: HTMLElement, row?: Setting): void {
    const credential = this.plugin.chatgptOAuth.getCredential();

    const explainer = containerEl.createDiv({
      cls: "setting-item-description ochatting-oauth-explainer",
    });
    if (row) row.settingEl.before(explainer);
    explainer.createSpan({
      text: "Sign in with your ChatGPT account instead of using an OpenAI API key. Requests are routed through the ChatGPT/Codex backend (not ",
    });
    explainer.createEl("code", { text: "api.openai.com" });
    explainer.createSpan({
      text: ") and require an active ChatGPT plan with Codex access. Refresh the model list to see the catalog for your account. Listed models may still depend on account permissions.",
    });

    if (credential) {
      const account = credential.accountId
        ? maskAccountId(credential.accountId)
        : "(no account id)";
      const expires = new Date(credential.expiresAt).toLocaleString();
      (row ?? new Setting(containerEl))
        .setName("ChatGPT account")
        .setDesc(`Connected — account ${account}. Token expires ${expires}.`)
        .addButton((button) => {
          button
            .setButtonText("Disconnect")
            .onClick(async () => {
              this.plugin.chatgptOAuth.clearCredential();
              clearCatalogModels("chatgpt-oauth");
              this.catalogModels = undefined;
              this.catalogIdentity = "";
              if (this.plugin.settings.modelCatalog) {
                this.plugin.settings.modelCatalog.entries = this.plugin.settings.modelCatalog.entries.filter(e => e.provider !== "chatgpt-oauth");
                await this.plugin.saveSettings();
              }
              new Notice("ChatGPT OAuth disconnected.");
              this.refreshSettingsTab();
            });
          if (requireApiVersion("1.13.0")) button.setDestructive();
          else button.setWarning();
        })
        .addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);
            try {
              const { sendMessage } = await import("./api/client");
              const response = await sendMessage(
                connectionTestSettings(this.plugin.settings),
                [{ role: "user", content: "Say hello in one word." }],
                [],
                "You are a test. Respond with one word."
              );
              const text = response.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("");
              new Notice(`Connected! Response: "${text || "(no text)"}"`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Connection test failed: ${msg}`);
            } finally {
              button.setButtonText("Test");
              button.setDisabled(false);
            }
          })
        );
    } else {
      (row ?? new Setting(containerEl))
        .setName("ChatGPT account")
        .setDesc("Not connected. Sign in with ChatGPT to use this provider.")
        .addButton((button) =>
          button
            .setButtonText("Connect ChatGPT")
            .setCta()
            .onClick(async () => {
              try {
                const auth = await this.plugin.chatgptOAuth.beginDeviceAuthorization();
                const handle = this.plugin.chatgptOAuth.pollDeviceAuthorization(auth);
                const modal = new ChatGPTDeviceLoginModal(this.app, auth, handle, () => {
                  this.refreshSettingsTab();
                });
                modal.open();
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                new Notice(`Failed to start ChatGPT login: ${msg}`);
              }
            })
        );
    }
  }

  // ─── Model picker ─────────────────────────────────────────────────────────

  private renderModelSection(containerEl: HTMLElement, row?: Setting): void {
    const s = this.plugin.settings;
    const cached = this.catalogModels;
    const models = cached || FALLBACK_MODELS[s.provider] || FALLBACK_MODELS.anthropic;

    const modelSetting = (row ?? new Setting(containerEl))
      .setName("Model")
      .setDesc(this.catalogError || (cached ? `${cached.length} models. Cached for 24 hours; refresh to check now.` : "Using defaults. Models load automatically when connected."))
      .addDropdown((dropdown) => {
        for (const m of models) {
          dropdown.addOption(m.value, m.label);
        }
        dropdown.addOption(CUSTOM_MODEL_OPTION, "Custom...");

        // If current model isn't in the list, add it
        if (s.model && !models.some((m) => m.value === s.model)) {
          dropdown.addOption(s.model, `${s.model} (current)`);
        }

        dropdown.setValue(this.editingCustomModel ? CUSTOM_MODEL_OPTION : s.model || models[0]?.value || "");
        dropdown.onChange(async (value) => {
          if (value === CUSTOM_MODEL_OPTION) {
            // UI state only: the model changes once an ID is typed.
            this.editingCustomModel = true;
            window.setTimeout(() => this.refreshSettingsTab(), 10);
            return;
          }
          const wasEditing = this.editingCustomModel;
          const levels = this.thinkingOptions();
          this.editingCustomModel = false;
          s.model = value;
          await this.plugin.saveSettings();
          // The thinking levels on offer depend on the model.
          if (wasEditing || this.thinkingOptions() !== levels) window.setTimeout(() => this.refreshSettingsTab(), 10);
        });
      });

    const canFetchModels = s.provider === "chatgpt-oauth" ? !!this.plugin.chatgptOAuth.getCredential() : !!s.apiKey;
    if (canFetchModels) {
      modelSetting.addButton(btn => btn.setIcon("refresh-cw").setTooltip("Refresh models now")
        .setDisabled(this.loadingCatalog).onClick(async () => {
          await this.loadCatalog(true);
        }));
    }
  }

  /** Custom model text field (while "Custom..." is picked); an empty ID is never saved. */
  private renderCustomModel(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .setName("Custom model ID")
      .setDesc("Enter the full model identifier")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_PROVIDER_MODELS[s.provider]).setValue(s.model);
        // Saved when the field is left or Enter is pressed, not per keystroke:
        // deleting an ID key by key would save each shorter ID as the model.
        const commit = () => {
          const id = text.getValue().trim();
          if (!id || id === s.model) return;
          const levels = this.thinkingOptions();
          s.model = id;
          void this.plugin.saveSettings();
          if (this.thinkingOptions() !== levels) window.setTimeout(() => this.refreshSettingsTab(), 10);
        };
        text.inputEl.addEventListener("change", commit);
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            commit();
          }
        });
      });
  }

  // ─── Thinking level ───────────────────────────────────────────────────────

  /** The selected model's catalog entry when it offers thinking levels. */
  private thinkingOptions(): ModelOption | undefined {
    const s = this.plugin.settings;
    const option = this.catalogModels?.find(m => m.value === s.model);
    return option?.reasoningEfforts?.length ? option : undefined;
  }

  /** "Default" plus the levels the model catalog lists for the selected model. */
  private renderThinkingLevel(setting: Setting): void {
    const s = this.plugin.settings;
    const option = this.thinkingOptions();
    if (!option?.reasoningEfforts) return;
    const efforts = option.reasoningEfforts;
    const fallback = catalogDefaultLevel(option);
    setting
      .setName("Thinking level")
      .setDesc("How much the model thinks before it answers. The levels come from the provider's model list.")
      .addDropdown((dropdown) => {
        dropdown.addOption("", fallback ? `Default (${fallback})` : "Default");
        for (const effort of efforts) dropdown.addOption(effort, effort);
        // Keep a saved level this model doesn't offer; requests use the default.
        if (s.thinkingLevel && !resolveThinkingLevel(option, s.thinkingLevel)) {
          dropdown.addOption(s.thinkingLevel, `${s.thinkingLevel} (not available)`);
        }
        dropdown.setValue(s.thinkingLevel);
        dropdown.onChange(async (value) => {
          s.thinkingLevel = value;
          await this.plugin.saveSettings();
          this.refreshSettingsTab();
        });
      });
  }
  private credentialIdentity(): string {
    const s = this.plugin.settings;
    if (s.provider !== "chatgpt-oauth") return s.apiKey;
    const credential = this.plugin.chatgptOAuth.getCredential();
    return credential ? credential.accountId || credential.accessToken : "";
  }

  private async loadCatalog(force: boolean): Promise<void> {
    if (this.loadingCatalog || this.apiKeyEditing) return;
    const s = this.plugin.settings;
    const provider = s.provider;
    const secretIdentity = this.credentialIdentity();
    if (!secretIdentity) return;
    this.loadingCatalog = true;
    const current = () => s.provider === provider && this.credentialIdentity() === secretIdentity;
    let changed = false;
    try {
      const identity = await catalogIdentity(provider, secretIdentity);
      if (!current()) return;
      const state: CatalogState = s.modelCatalog ??= { entries: [] };
      const cached = cachedCatalog(state, provider, identity);
      if (this.catalogIdentity !== identity) {
        this.catalogIdentity = identity;
        this.catalogModels = cached?.models;
        this.catalogError = "";
        changed = true;
      }
      if (changed && cached) this.refreshSettingsTab();
      if (!force && cached && Date.now() - cached.fetchedAt >= 0 && Date.now() - cached.fetchedAt < CATALOG_TTL) return;
      const models = await refreshCatalog(state, provider, identity, s.apiKey, this.plugin.chatgptOAuth, force);
      if (!current()) return;
      if (models.length && this.catalogModels !== models) {
        this.catalogModels = models;
        changed = true;
        await this.plugin.saveSettings();
      }
      this.catalogError = "";
      if (force) new Notice(`Loaded ${models.length} models`);
    } catch (error) {
      if (current()) {
        this.catalogError = "Could not refresh models. Keeping the last list; use refresh to retry.";
        changed = true;
        if (force) new Notice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.loadingCatalog = false;
      if (current() && (changed || force)) this.refreshSettingsTab();
      else if (!current()) this.refreshSettingsTab();
    }
  }

}

// ─── Device-flow login modal ────────────────────────────────────────────────

export class ChatGPTDeviceLoginModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private readonly authorization: ChatGPTDeviceAuthorization,
    private readonly handle: PollHandle,
    private readonly onComplete: () => void,
  ) {
    super(app);
  }

  /** Suppress backdrop events only; Escape, Cancel and successful login still close normally. */
  private ignoreBackgroundClicks(): void {
    const background = this.containerEl.querySelector(".modal-bg");
    const ignore = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of ["pointerdown", "mousedown", "click", "touchstart"]) {
      background?.addEventListener(type, ignore, { capture: true, passive: false });
    }
  }

  onOpen(): void {
    this.ignoreBackgroundClicks();
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName("Connect ChatGPT").setHeading();

    contentEl.createEl("p", {
      text: "1. Open this page in any browser:",
    });
    const linkRow = contentEl.createDiv({ cls: "ochatting-device-link-row" });
    const link = linkRow.createEl("a", {
      text: this.authorization.verificationUri,
      href: this.authorization.verificationUri,
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    contentEl.createEl("p", { text: "2. Enter this code on the page:" });
    const codeRow = contentEl.createDiv({ cls: "ochatting-device-code-row" });

    codeRow.createEl("code", {
      text: this.authorization.userCode,
      cls: "ochatting-device-code",
    });

    const copyBtn = codeRow.createEl("button", { text: "Copy code" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(this.authorization.userCode)
        .then(() => new Notice("Code copied."))
        .catch(() => new Notice("Failed to copy code."));
    });

    const status = contentEl.createEl("p", {
      text: "Waiting for authorization. You can return here after signing in.",
      cls: "ochatting-device-status",
    });

    const buttons = contentEl.createDiv({ cls: "ochatting-device-buttons" });

    const openBtn = buttons.createEl("button", { text: "Open login page" });
    openBtn.classList.add("mod-cta");
    openBtn.addEventListener("click", () => {
      window.open(this.authorization.verificationUri, "_blank");
    });

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.cancelled = true;
      this.handle.cancel();
      this.close();
    });

    // Wait for the poll to finish.
    this.handle.promise
      .then(() => {
        if (this.cancelled) return;
        new Notice("ChatGPT connected.");
        this.onComplete();
        this.close();
      })
      .catch((e: unknown) => {
        if (this.cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        status.setText(`Login failed: ${msg}`);
        status.removeClass("ochatting-device-status");
        status.addClass("ochatting-device-status-error");
      });
  }

  onClose(): void {
    if (!this.cancelled) {
      // If the user closed via Esc or the close button, treat it as cancel.
      this.handle.cancel();
    }
    this.contentEl.empty();
  }
}

function maskAccountId(accountId: string): string {
  if (accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}
