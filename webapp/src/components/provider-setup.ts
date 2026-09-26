import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "../icon.js";
import { mdiClose, mdiCheckCircle, mdiAlertCircleOutline, mdiKeyVariant, mdiRobotHappyOutline } from "@mdi/js";
import { lang, type Lang } from "../i18n.js";
import type { ProviderAuthEvent } from "../types.js";

interface Provider { id: string; name: string; models: Array<{ id: string; name: string }>; baseUrl?: string; modelId?: string; authConfigured?: boolean }
const CUSTOM_PROVIDER = "custom-openai-compatible";
const COPILOT_PROVIDER = "github-copilot";

// Self-contained localization (en base + da/no/sv/de). The setup screen must work
// on first run before anything else — keep its strings here, not threaded through.
type Dict = Record<string, string>;
const L: Record<Lang, Dict> = {
  en: {
    welcome: "Welcome to Pi Agent", welcome_sub: "Choose an AI provider and model, then paste its API key. Pi checks it works before saving — you're ready to chat the moment it succeeds.",
    title: "AI provider & model", provider: "Provider", model: "Model", api_key: "API key", api_key_optional: "API key (optional)",
    choose_provider: "Choose a provider…", choose_model: "Choose a model…",
    key_ph: "Paste the provider's API key", key_hint: "Stored securely for this provider. Leave blank to keep its existing key.",
    endpoint: "Endpoint / base URL", endpoint_ph: "https://your-server.example/v1", model_id: "Model ID", model_id_ph: "e.g. my-model",
    copilot_hint: "Pi uses GitHub's native device sign-in. Your API key is never requested.", copilot_connect: "Connect GitHub Copilot",
    auth_open: "Open sign-in page", auth_code: "Enter this code", auth_wait: "GitHub sign-in in progress…", auth_info: "Continue the sign-in in your browser.",
    save: "Save & test", testing: "Testing the connection…", loading: "Loading providers…",
    ok: "Connection works — saved.", need_fields: "Pick a provider and model first.",
    ws_title: "Web search (optional)", ws_provider: "Search provider", ws_key: "API key",
    ws_key_ph: "Paste the search provider's API key", ws_hint: "When it validates, the agent gets a web_search tool and is told to check facts online instead of guessing.",
    ws_save: "Save & test", ws_disable: "Disable", ws_on: "Active", ws_off: "Off",
  },
  da: {
    welcome: "Velkommen til Pi Agent", welcome_sub: "Vælg en AI-udbyder og model. Pi tester forbindelsen før lagring — nogle udbydere bruger browser-login i stedet for en API-nøgle.",
    title: "AI-udbyder & model", provider: "Udbyder", model: "Model", api_key: "API-nøgle", api_key_optional: "API-nøgle (valgfri)",
    choose_provider: "Vælg en udbyder…", choose_model: "Vælg en model…",
    endpoint: "Endpoint / basis-URL", endpoint_ph: "https://your-server.example/v1", model_id: "Model-ID", model_id_ph: "f.eks. min-model",
    copilot_hint: "Pi bruger GitHubs officielle enhedslogin. Du bliver ikke bedt om en API-nøgle.", copilot_connect: "Forbind GitHub Copilot",
    auth_open: "Åbn login-side", auth_code: "Indtast denne kode", auth_wait: "GitHub-login er i gang…", auth_info: "Fortsæt login i din browser.",
    key_ph: "Indsæt udbyderens API-nøgle", key_hint: "Gemmes sikkert i add-on'en. Lad stå tom for at beholde den nuværende nøgle.",
    save: "Gem & test", testing: "Tester forbindelsen…", loading: "Henter udbydere…",
    ok: "Forbindelsen virker — gemt.", need_fields: "Vælg udbyder og model først.",
    ws_title: "Websøgning (valgfri)", ws_provider: "Søge-udbyder", ws_key: "API-nøgle",
    ws_key_ph: "Indsæt søge-udbyderens API-nøgle", ws_hint: "Når den validerer, får agenten et web_search-værktøj og bliver bedt om at tjekke fakta online i stedet for at gætte.",
    ws_save: "Gem & test", ws_disable: "Slå fra", ws_on: "Aktiv", ws_off: "Fra",
  },
  no: {
    welcome: "Velkommen til Pi Agent", welcome_sub: "Velg en AI-leverandør og modell. Pi tester tilkoblingen før lagring — noen leverandører bruker nettleserpålogging i stedet for API-nøkkel.",
    title: "AI-leverandør & modell", provider: "Leverandør", model: "Modell", api_key: "API-nøkkel", api_key_optional: "API-nøkkel (valgfri)",
    choose_provider: "Velg en leverandør…", choose_model: "Velg en modell…",
    endpoint: "Endepunkt / base-URL", endpoint_ph: "https://your-server.example/v1", model_id: "Modell-ID", model_id_ph: "f.eks. min-modell",
    copilot_hint: "Pi bruker GitHubs innebygde enhetspålogging. Du blir ikke bedt om en API-nøkkel.", copilot_connect: "Koble til GitHub Copilot",
    auth_open: "Åpne påloggingssiden", auth_code: "Skriv inn denne koden", auth_wait: "GitHub-pålogging pågår…", auth_info: "Fortsett påloggingen i nettleseren.",
    key_ph: "Lim inn leverandørens API-nøkkel", key_hint: "Lagres trygt i tillegget. La stå tom for å beholde nåværende nøkkel.",
    save: "Lagre & test", testing: "Tester tilkoblingen…", loading: "Henter leverandører…",
    ok: "Tilkoblingen virker — lagret.", need_fields: "Velg leverandør og modell først.",
  },
  sv: {
    welcome: "Välkommen till Pi Agent", welcome_sub: "Välj en AI-leverantör och modell. Pi testar anslutningen innan den sparas — vissa leverantörer använder webbläsarinloggning i stället för API-nyckel.",
    title: "AI-leverantör & modell", provider: "Leverantör", model: "Modell", api_key: "API-nyckel", api_key_optional: "API-nyckel (valfri)",
    choose_provider: "Välj en leverantör…", choose_model: "Välj en modell…",
    endpoint: "Slutpunkt / bas-URL", endpoint_ph: "https://your-server.example/v1", model_id: "Modell-ID", model_id_ph: "t.ex. min-modell",
    copilot_hint: "Pi använder GitHubs inbyggda enhetsinloggning. Du behöver inte ange någon API-nyckel.", copilot_connect: "Anslut GitHub Copilot",
    auth_open: "Öppna inloggningssidan", auth_code: "Ange den här koden", auth_wait: "GitHub-inloggning pågår…", auth_info: "Fortsätt inloggningen i webbläsaren.",
    key_ph: "Klistra in leverantörens API-nyckel", key_hint: "Lagras säkert i tillägget. Lämna tomt för att behålla nuvarande nyckel.",
    save: "Spara & testa", testing: "Testar anslutningen…", loading: "Hämtar leverantörer…",
    ok: "Anslutningen fungerar — sparad.", need_fields: "Välj leverantör och modell först.",
  },
  de: {
    welcome: "Willkommen bei Pi Agent", welcome_sub: "Wähle einen KI-Anbieter und ein Modell. Pi testet die Verbindung vor dem Speichern — manche Anbieter verwenden die Browser-Anmeldung statt eines API-Schlüssels.",
    title: "KI-Anbieter & Modell", provider: "Anbieter", model: "Modell", api_key: "API-Schlüssel", api_key_optional: "API-Schlüssel (optional)",
    choose_provider: "Anbieter wählen…", choose_model: "Modell wählen…",
    endpoint: "Endpunkt / Basis-URL", endpoint_ph: "https://your-server.example/v1", model_id: "Modell-ID", model_id_ph: "z. B. mein-modell",
    copilot_hint: "Pi verwendet GitHubs native Geräteanmeldung. Ein API-Schlüssel wird nicht abgefragt.", copilot_connect: "GitHub Copilot verbinden",
    auth_open: "Anmeldeseite öffnen", auth_code: "Diesen Code eingeben", auth_wait: "GitHub-Anmeldung läuft…", auth_info: "Setze die Anmeldung im Browser fort.",
    key_ph: "API-Schlüssel des Anbieters einfügen", key_hint: "Sicher im Add-on gespeichert. Leer lassen, um den bestehenden Schlüssel zu behalten.",
    save: "Speichern & testen", testing: "Verbindung wird getestet…", loading: "Anbieter werden geladen…",
    ok: "Verbindung funktioniert — gespeichert.", need_fields: "Zuerst Anbieter und Modell wählen.",
  },
};
const tl = (k: string): string => L[lang]?.[k] ?? L.en[k] ?? k;

@customElement("pi-provider-setup")
export class PiProviderSetup extends LitElement {
  @property({ type: Boolean }) open = false;
  /** First-run: the panel cannot be dismissed until a working config is saved. */
  @property({ type: Boolean }) mustConfigure = false;
  /** Provider catalog + current selection + save state come from chat-app over WS. */
  @property({ attribute: false }) providers: Provider[] = [];
  @property() initialProvider = "";
  @property() initialModel = "";
  @property({ type: Boolean }) busy = false;
  @property() error = "";
  @property({ attribute: false }) authEvent?: ProviderAuthEvent;

  @state() private provider = "";
  @state() private model = "";
  @state() private apiKey = "";
  @state() private customBaseUrl = "";
  @state() private customModelId = "";
  @state() private requested = false;

  /** Web search config status + save state (from chat-app over WS). */
  @property({ attribute: false }) websearch: { enabled: boolean; provider: string; providers: string[] } = { enabled: false, provider: "perplexity", providers: [] };
  @property({ type: Boolean }) wsBusy = false;
  @property() wsError = "";
  @state() private wsProvider = "";
  @state() private wsKey = "";

  updated(changed: Map<string, unknown>): void {
    if (changed.has("open")) {
      if (this.open) {
        // Ask chat-app to fetch the provider catalog over WS (same pattern as sessions).
        if (!this.requested) { this.dispatchEvent(new CustomEvent("request-providers")); this.requested = true; }
        if (this.initialProvider && !this.provider) this.provider = this.initialProvider;
        if (this.initialModel && !this.model) this.model = this.initialModel;
        if (!this.wsProvider) this.wsProvider = this.websearch.provider || "perplexity";
        this.loadCustomConfig();
      } else {
        this.apiKey = ""; this.wsKey = ""; this.customBaseUrl = ""; this.customModelId = ""; this.requested = false; // reset for next open
      }
    }
    if ((changed.has("initialProvider") || changed.has("initialModel")) && this.open) {
      if (this.initialProvider && !this.provider) this.provider = this.initialProvider;
      if (this.initialModel && !this.model) this.model = this.initialModel;
    }
    if (changed.has("providers") && this.open) this.loadCustomConfig();
  }

  private models(): Array<{ id: string; name: string }> {
    return this.providers.find((p) => p.id === this.provider)?.models ?? [];
  }
  private loadCustomConfig(): void {
    const saved = this.providers.find((p) => p.id === CUSTOM_PROVIDER);
    if (!this.customBaseUrl && saved?.baseUrl) this.customBaseUrl = saved.baseUrl;
    if (!this.customModelId) this.customModelId = saved?.modelId || (this.initialProvider === CUSTOM_PROVIDER ? this.initialModel : "");
  }

  private save(): void {
    if (this.busy) return;
    if (this.provider === CUSTOM_PROVIDER) {
      this.dispatchEvent(new CustomEvent("save-custom-config", { detail: { baseUrl: this.customBaseUrl, modelId: this.customModelId, apiKey: this.apiKey } }));
    } else if (this.provider && this.model && this.provider !== COPILOT_PROVIDER) {
      this.dispatchEvent(new CustomEvent("save-config", { detail: { provider: this.provider, model: this.model, apiKey: this.apiKey } }));
    }
  }
  private connectCopilot(): void {
    if (!this.model || this.busy) return;
    this.dispatchEvent(new CustomEvent("login-provider", { detail: { provider: COPILOT_PROVIDER, model: this.model } }));
  }

  private saveWs(): void {
    if (!this.wsProvider || this.wsBusy) return;
    this.dispatchEvent(new CustomEvent("save-websearch", { detail: { provider: this.wsProvider, apiKey: this.wsKey } }));
  }
  private disableWs(): void { if (!this.wsBusy) this.dispatchEvent(new CustomEvent("disable-websearch")); }
  private wsLabel(id: string): string {
    return id === "brave" ? "Brave Search" : id === "perplexity_openrouter" ? "Perplexity via OpenRouter" : "Perplexity (API)";
  }

  private close(): void { if (this.mustConfigure) return; this.dispatchEvent(new CustomEvent("setup-close")); }

  static styles = css`
    * { box-sizing: border-box; }
    .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 20; display: grid; place-items: end center; }
    @media (min-width: 560px) { .scrim { place-items: center; } }
    .panel { width: 100%; max-width: 480px; max-height: 94dvh; display: flex; flex-direction: column;
      background: var(--pi-surface); color: var(--pi-text); border-radius: 20px 20px 0 0; overflow: hidden; }
    @media (min-width: 560px) { .panel { border-radius: 20px; } }
    .head { display: flex; align-items: center; gap: 10px; padding: 16px 16px 6px; }
    .head .t { font-weight: 700; font-size: 17px; flex: 1; }
    .iconbtn { display: grid; place-items: center; width: 36px; height: 36px; border: none; background: transparent; color: var(--pi-text-2); border-radius: 10px; cursor: pointer; }
    .iconbtn:hover { background: var(--pi-surface-2); color: var(--pi-text); }
    .iconbtn svg { width: 22px; height: 22px; }
    .body { padding: 8px 16px 16px; overflow-y: auto; }
    .welcome { display: flex; gap: 12px; align-items: flex-start; margin: 4px 0 14px; }
    .welcome .ic { color: var(--pi-primary); flex: 0 0 auto; }
    .welcome .ic svg { width: 34px; height: 34px; }
    .welcome h3 { margin: 0 0 4px; font-size: 16px; }
    .welcome p { margin: 0; color: var(--pi-text-2); font-size: 13.5px; line-height: 1.5; }
    label.field { display: block; margin: 12px 0 0; }
    .field .lbl { font-size: 12.5px; font-weight: 600; color: var(--pi-text-2); margin-bottom: 5px; display: block; }
    select, input {
      width: 100%; padding: 12px 13px; border: 1.5px solid var(--pi-divider); border-radius: 12px;
      background: var(--pi-bg); color: var(--pi-text); font: 14.5px var(--pi-font); outline: none;
    }
    select:focus, input:focus { border-color: var(--pi-primary); }
    select:disabled { opacity: 0.5; }
    .key-wrap { position: relative; }
    .key-wrap svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; color: var(--pi-text-2); }
    .key-wrap input { padding-left: 38px; }
    .hint { font-size: 12px; color: var(--pi-text-2); margin-top: 5px; line-height: 1.45; }
    .msg { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; }
    .msg svg { width: 18px; height: 18px; flex: 0 0 auto; margin-top: 1px; }
    .msg.err { background: color-mix(in srgb, var(--pi-danger) 12%, var(--pi-bg)); color: var(--pi-text); }
    .msg.err svg { color: var(--pi-danger); }
    .foot { display: flex; gap: 10px; padding: 12px 16px calc(16px + env(safe-area-inset-bottom)); border-top: 1px solid var(--pi-divider); }
    .foot .spacer { flex: 1; }
    button.btn { border-radius: 22px; padding: 12px 22px; font: 600 14px var(--pi-font); cursor: pointer; border: 1px solid var(--pi-divider); background: var(--pi-surface); color: var(--pi-text); display: inline-flex; align-items: center; gap: 8px; }
    button.btn.primary { background: var(--pi-primary); color: #fff; border-color: var(--pi-primary); }
    button.btn:disabled { opacity: 0.5; cursor: default; }
    md-circular-progress { --md-circular-progress-size: 18px; }
    .spin { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: 50%; animation: sp 0.7s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .auth-card { margin-top: 12px; padding: 12px; border: 1px solid var(--pi-divider); border-radius: 12px; font-size: 13px; line-height: 1.5; }
    .auth-card a { color: var(--pi-primary); overflow-wrap: anywhere; }
    .auth-code { display: block; margin: 6px 0; font: 700 20px var(--pi-mono); letter-spacing: 0.08em; }
    .ws-sep { border-top: 1px solid var(--pi-divider); margin: 20px 0 12px; }
    .ws-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
    .ws-status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--pi-surface-2); color: var(--pi-text-2); }
    .ws-status.on { background: color-mix(in srgb, var(--pi-ok) 18%, transparent); color: var(--pi-ok); }
    .ws-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
    .ws-actions .spacer { flex: 1; }
  `;

  render() {
    if (!this.open) return nothing;
    const canClose = !this.mustConfigure;
    return html`
      <div class="scrim" @click=${(e: Event) => { if (canClose && e.target === e.currentTarget) this.close(); }}>
        <div class="panel">
          <div class="head">
            <span class="t">${tl("title")}</span>
            ${canClose ? html`<button class="iconbtn" @click=${() => this.close()} aria-label="close">${icon(mdiClose, 22)}</button>` : nothing}
          </div>
          <div class="body">
            ${this.mustConfigure
              ? html`<div class="welcome"><span class="ic">${icon(mdiRobotHappyOutline, 34)}</span>
                  <div><h3>${tl("welcome")}</h3><p>${tl("welcome_sub")}</p></div></div>`
              : nothing}

            <label class="field">
              <span class="lbl">${tl("provider")}</span>
              <select .value=${this.provider} ?disabled=${!this.providers.length}
                @change=${(e: Event) => { this.provider = (e.target as HTMLSelectElement).value; this.model = ""; this.apiKey = ""; this.dispatchEvent(new CustomEvent("clear-auth")); if (this.provider === CUSTOM_PROVIDER) this.loadCustomConfig(); }}>
                <option value="" ?selected=${!this.provider}>${this.providers.length ? tl("choose_provider") : tl("loading")}</option>
                ${this.providers.map((p) => html`<option value=${p.id} ?selected=${this.provider === p.id}>${p.name}</option>`)}
              </select>
            </label>

            ${this.provider === CUSTOM_PROVIDER ? html`
              <label class="field"><span class="lbl">${tl("endpoint")}</span>
                <input type="url" autocomplete="url" placeholder=${tl("endpoint_ph")} .value=${this.customBaseUrl}
                  @input=${(e: Event) => { this.customBaseUrl = (e.target as HTMLInputElement).value; }} />
              </label>
              <label class="field"><span class="lbl">${tl("model_id")}</span>
                <input type="text" autocomplete="off" placeholder=${tl("model_id_ph")} .value=${this.customModelId}
                  @input=${(e: Event) => { this.customModelId = (e.target as HTMLInputElement).value; }} />
              </label>` : html`
              <label class="field">
                <span class="lbl">${tl("model")}</span>
                <select .value=${this.model} ?disabled=${!this.provider}
                  @change=${(e: Event) => { this.model = (e.target as HTMLSelectElement).value; }}>
                  <option value="" ?selected=${!this.model}>${tl("choose_model")}</option>
                  ${this.models().map((m) => html`<option value=${m.id} ?selected=${this.model === m.id}>${m.name}</option>`)}
                </select>
              </label>`}

            ${this.provider && this.provider !== COPILOT_PROVIDER ? html`
              <label class="field">
                <span class="lbl">${this.provider === CUSTOM_PROVIDER ? tl("api_key_optional") : tl("api_key")}</span>
                <div class="key-wrap">
                  ${icon(mdiKeyVariant, 18)}
                  <input type="password" autocomplete="off" spellcheck="false" placeholder=${tl("key_ph")}
                    .value=${this.apiKey} @input=${(e: Event) => { this.apiKey = (e.target as HTMLInputElement).value; }} />
                </div>
                <div class="hint">${tl("key_hint")}</div>
              </label>` : this.provider === COPILOT_PROVIDER ? html`<div class="hint">${tl("copilot_hint")}</div>` : nothing}

            ${this.provider === COPILOT_PROVIDER && this.authEvent ? html`
              <div class="auth-card" aria-live="polite">
                ${this.authEvent.type === "device_code" ? html`
                  <div>${tl("auth_open")}:</div>
                  <a href=${this.authEvent.verificationUri} target="_blank" rel="noopener noreferrer">${this.authEvent.verificationUri}</a>
                  <div>${tl("auth_code")}:</div><code class="auth-code">${this.authEvent.userCode}</code>
                  ${this.authEvent.expiresInSeconds ? html`<div>${Math.ceil(this.authEvent.expiresInSeconds / 60)} min</div>` : nothing}`
                  : this.authEvent.type === "auth_url" ? html`<a href=${this.authEvent.url} target="_blank" rel="noopener noreferrer">${tl("auth_open")}</a>`
                    : this.authEvent.type === "progress" ? tl("auth_wait") : tl("auth_info")}
              </div>` : nothing}

            ${this.error
              ? html`<div class="msg err">${icon(mdiAlertCircleOutline, 18)}<span>${this.error}</span></div>`
              : this.busy
                ? html`<div class="msg">${icon(mdiCheckCircle, 18)}<span>${tl("testing")}</span></div>`
                : nothing}

            ${!this.mustConfigure ? html`
              <div class="ws-sep"></div>
              <div class="ws-head">${tl("ws_title")}
                <span class="ws-status ${this.websearch.enabled ? "on" : ""}">${this.websearch.enabled ? tl("ws_on") : tl("ws_off")}</span></div>
              <label class="field">
                <span class="lbl">${tl("ws_provider")}</span>
                <select .value=${this.wsProvider} @change=${(e: Event) => { this.wsProvider = (e.target as HTMLSelectElement).value; this.wsKey = ""; }}>
                  ${(this.websearch.providers.length ? this.websearch.providers : ["perplexity", "perplexity_openrouter", "brave"]).map((pp) => html`<option value=${pp} ?selected=${this.wsProvider === pp}>${this.wsLabel(pp)}</option>`)}
                </select>
              </label>
              <label class="field">
                <span class="lbl">${tl("ws_key")}</span>
                <div class="key-wrap">${icon(mdiKeyVariant, 18)}
                  <input type="password" autocomplete="off" spellcheck="false" placeholder=${tl("ws_key_ph")}
                    .value=${this.wsKey} @input=${(e: Event) => { this.wsKey = (e.target as HTMLInputElement).value; }} /></div>
                <div class="hint">${tl("ws_hint")}</div>
              </label>
              ${this.wsError ? html`<div class="msg err">${icon(mdiAlertCircleOutline, 18)}<span>${this.wsError}</span></div>` : nothing}
              <div class="ws-actions">
                ${this.websearch.enabled ? html`<button class="btn" ?disabled=${this.wsBusy} @click=${() => this.disableWs()}>${tl("ws_disable")}</button>` : nothing}
                <span class="spacer"></span>
                <button class="btn primary" ?disabled=${this.wsBusy || !this.wsProvider} @click=${() => this.saveWs()}>
                  ${this.wsBusy ? html`<span class="spin"></span>` : nothing}${this.wsBusy ? tl("testing") : tl("ws_save")}
                </button>
              </div>` : nothing}
          </div>
          <div class="foot">
            <span class="spacer"></span>
            <button class="btn primary" ?disabled=${this.busy || !this.provider || (this.provider === CUSTOM_PROVIDER ? !this.customBaseUrl.trim() || !this.customModelId.trim() : !this.model)}
              @click=${() => this.provider === COPILOT_PROVIDER ? this.connectCopilot() : this.save()}>
              ${this.busy ? html`<span class="spin"></span>` : nothing}
              ${this.busy ? tl("testing") : this.provider === COPILOT_PROVIDER && !this.providers.find((p) => p.id === COPILOT_PROVIDER)?.authConfigured ? tl("copilot_connect") : tl("save")}
            </button>
          </div>
        </div>
      </div>`;
  }
}
