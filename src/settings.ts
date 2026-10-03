import { App, Modal, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type ChatPlugin from "./main";
import type { Provider } from "./types";
import { CHATGPT_OAUTH_DEFAULT_MODEL } from "./types";
import type { ChatGPTDeviceAuthorization, PollHandle } from "./auth/chatgptOAuth";

interface ModelOption {
  value: string;
  label: string;
}

const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-5.3-codex", label: "Codex 5.3" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
  // CLI catalog entries are not guaranteed to be available to every account.
  // Keep the default confirmed by user reports; other IDs remain customizable.
  "chatgpt-oauth": [
    { value: "gpt-5.5", label: "GPT-5.5 (recommended)" },
  ],
};

// Cache fetched models per provider so they survive tab re-opens
const modelCache = new Map<string, ModelOption[]>();

/** Resolve a model ID to its display name */
export function getModelDisplayName(provider: string, modelId: string): string {
  const cached = modelCache.get(provider);
  const models = cached || FALLBACK_MODELS[provider] || [];
  const match = models.find((m) => m.value === modelId);
  return match?.label || modelId;
}

// ─── Settings Tab ───────────────────────────────────────────────────────────

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatPlugin;

  constructor(app: App, plugin: ChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // ─── Provider ─────────────────────────────────────────────────────
    new Setting(containerEl)
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
            s.provider = value as Provider;
            s.model = "";
            this.plugin.reloadApiKeyForProvider();
            // Set a sensible default model for chatgpt-oauth (no API to fetch from)
            if (s.provider === "chatgpt-oauth" && !s.model) {
              s.model = CHATGPT_OAUTH_DEFAULT_MODEL;
            }
            await this.plugin.saveSettings();
            window.setTimeout(() => this.display(), 10);
          })
      );

    // ─── Auth section: API key OR OAuth Connect ───────────────────────
    if (s.provider === "chatgpt-oauth") {
      this.renderChatGPTOAuthSection(containerEl);
    } else {
      this.renderApiKeySection(containerEl);
    }

    // ─── Model ────────────────────────────────────────────────────────
    this.renderModelSection(containerEl);

    // ─── Web search ───────────────────────────────────────────────────
    new Setting(containerEl)
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

    // ─── Max iterations ───────────────────────────────────────────────
    new Setting(containerEl)
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

  // ─── API key + test (anthropic / openai) ──────────────────────────────────

  private renderApiKeySection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    const apiKeySetting = new Setting(containerEl)
      .setName("API key")
      .setDesc(s.apiKey ? "Key saved" : "Enter your API key to get started")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(s.apiKey)
          .onChange(async (value) => {
            const hadKey = !!s.apiKey;
            s.apiKey = value.trim();
            await this.plugin.saveSettings();
            if (!hadKey && s.apiKey) {
              window.setTimeout(() => this.display(), 10);
            }
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
              s,
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

  private renderChatGPTOAuthSection(containerEl: HTMLElement): void {
    const credential = this.plugin.chatgptOAuth.getCredential();

    const explainer = containerEl.createEl("div", {
      cls: "setting-item-description ochatting-oauth-explainer",
    });
    explainer.createSpan({
      text: "Sign in with your ChatGPT account instead of using an OpenAI API key. Requests are routed through the ChatGPT/Codex backend (not ",
    });
    explainer.createEl("code", { text: "api.openai.com" });
    explainer.createSpan({
      text: ") and require an active ChatGPT plan with Codex access. The available models mirror the Codex CLI catalog.",
    });

    if (credential) {
      const account = credential.accountId
        ? maskAccountId(credential.accountId)
        : "(no account id)";
      const expires = new Date(credential.expiresAt).toLocaleString();
      new Setting(containerEl)
        .setName("ChatGPT account")
        .setDesc(`Connected — account ${account}. Token expires ${expires}.`)
        .addButton((button) =>
          button
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              this.plugin.chatgptOAuth.clearCredential();
              new Notice("ChatGPT OAuth disconnected.");
              this.display();
            })
        )
        .addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);
            try {
              const { sendMessage } = await import("./api/client");
              const response = await sendMessage(
                this.plugin.settings,
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
      new Setting(containerEl)
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
                  this.display();
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

  private renderModelSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const cached = modelCache.get(s.provider);
    const models = cached || FALLBACK_MODELS[s.provider] || FALLBACK_MODELS.anthropic;

    const modelSetting = new Setting(containerEl)
      .setName("Model")
      .setDesc(s.provider === "chatgpt-oauth"
        ? "GPT-5.5 is the recommended default. Custom model availability depends on your ChatGPT account."
        : cached ? `${cached.length} models from API` : "Using defaults. Click refresh to load from API.")
      .addDropdown((dropdown) => {
        for (const m of models) {
          dropdown.addOption(m.value, m.label);
        }
        dropdown.addOption("__custom__", "Custom...");

        // If current model isn't in the list, add it
        if (s.model && !models.some((m) => m.value === s.model)) {
          dropdown.addOption(s.model, `${s.model} (current)`);
        }

        dropdown.setValue(s.model || models[0]?.value || "");
        dropdown.onChange(async (value) => {
          if (value === "__custom__") {
            s.model = "";
            await this.plugin.saveSettings();
            window.setTimeout(() => this.display(), 10);
          } else {
            s.model = value;
            await this.plugin.saveSettings();
          }
        });
      });

    // Refresh button — only for providers that ship a meaningful model
    // catalog endpoint behind their auth.
    //
    // The general ChatGPT catalog does not establish Codex availability for
    // this account. Non-default Codex model IDs can be entered via Custom.
    const canFetchModels =
      (s.provider === "anthropic" && !!s.apiKey) ||
      (s.provider === "openai" && !!s.apiKey);
    if (canFetchModels) {
      modelSetting.addButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Fetch models from API")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const fetched = await fetchModelsFromAPI(s.provider, s.apiKey);
              modelCache.set(s.provider, fetched);
              new Notice(`Loaded ${fetched.length} models`);
              if (!s.model && fetched.length > 0) {
                s.model = fetched[0].value;
                await this.plugin.saveSettings();
              }
              this.display();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Failed to fetch models: ${msg}`);
            }
          })
      );
    }

    // Custom model text field (shown when Custom... selected or model is empty)
    if (!s.model) {
      new Setting(containerEl)
        .setName("Custom model ID")
        .setDesc("Enter the full model identifier")
        .addText((text) =>
          text
            .setPlaceholder(
              s.provider === "anthropic"
                ? "claude-sonnet-4-20250514"
                : s.provider === "chatgpt-oauth"
                  ? CHATGPT_OAUTH_DEFAULT_MODEL
                  : "gpt-4o",
            )
            .setValue(s.model)
            .onChange(async (value) => {
              s.model = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }
  }
}

// ─── Device-flow login modal ────────────────────────────────────────────────

class ChatGPTDeviceLoginModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private readonly authorization: ChatGPTDeviceAuthorization,
    private readonly handle: PollHandle,
    private readonly onComplete: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName("Connect ChatGPT").setHeading();

    contentEl.createEl("p", {
      text: "1. Open this page in any browser:",
    });
    const linkRow = contentEl.createEl("div", { cls: "ochatting-device-link-row" });
    const link = linkRow.createEl("a", {
      text: this.authorization.verificationUri,
      href: this.authorization.verificationUri,
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    contentEl.createEl("p", { text: "2. Enter this code on the page:" });
    const codeRow = contentEl.createEl("div", { cls: "ochatting-device-code-row" });

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

    const buttons = contentEl.createEl("div", { cls: "ochatting-device-buttons" });

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
      // If the user closed via Esc / outside click, treat it as cancel.
      this.handle.cancel();
    }
    this.contentEl.empty();
  }
}

function maskAccountId(accountId: string): string {
  if (accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

// ─── Model Fetching (only triggered by explicit refresh button click) ───────

async function fetchModelsFromAPI(
  provider: Provider,
  apiKey: string
): Promise<ModelOption[]> {
  if (provider === "anthropic") {
    return fetchAnthropicModels(apiKey);
  }
  if (provider === "openai") {
    return fetchOpenAIModels(apiKey);
  }
  // chatgpt-oauth never reaches here — the refresh button is hidden for it.
  // We return the bundled list for type-safety, in case a future caller
  // bypasses the UI gate.
  return FALLBACK_MODELS["chatgpt-oauth"];
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.anthropic.com/v1/models?limit=100",
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const models = getModelRecords(response.json as unknown)
    .filter((m) => m.type === "model")
    .filter((m): m is ModelRecord & { id: string } => typeof m.id === "string")
    .map((m) => ({
      value: m.id,
      label: typeof m.display_name === "string" ? m.display_name : m.id,
    }))
    .sort((a: ModelOption, b: ModelOption) => {
      const da = a.value.match(/(\d{8})/)?.[1] || "";
      const db = b.value.match(/(\d{8})/)?.[1] || "";
      return db.localeCompare(da) || a.label.localeCompare(b.label);
    });

  return models.length > 0 ? models : FALLBACK_MODELS.anthropic;
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-", "codex-", "gpt5"];
  const excludePatterns = ["realtime", "audio", "transcri", "search"];

  const models = getModelRecords(response.json as unknown)
    .filter((m): m is ModelRecord & { id: string } => typeof m.id === "string")
    .filter((m) => {
      const id = m.id.toLowerCase();
      return chatPrefixes.some((p) => id.startsWith(p)) &&
        !excludePatterns.some((p) => id.includes(p));
    })
    .sort((a, b) =>
      numberValue(b.created) - numberValue(a.created)
    )
    .map((m) => ({ value: m.id, label: m.id }));

  return models.length > 0 ? models : FALLBACK_MODELS.openai;
}

interface ModelRecord {
  id?: unknown;
  type?: unknown;
  display_name?: unknown;
  created?: unknown;
}

function getModelRecords(value: unknown): ModelRecord[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.filter(isRecord);
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
