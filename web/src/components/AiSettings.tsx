import { useEffect, useState } from "react";
import { api, type AiTestResult, type Settings } from "../lib/api.ts";
import { errorText } from "../App.tsx";

type SecretKey = "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | "VOYAGE_API_KEY";

const PROVIDERS = [
  { id: "cli", label: "Claude CLI — по токену подписки" },
  { id: "api", label: "Anthropic API — по ключу" },
  { id: "off", label: "Выключить — только офлайн-OCR" },
];

export function AiSettings() {
  const [data, setData] = useState<Settings | null>(null);
  const [provider, setProvider] = useState("cli");
  const [model, setModel] = useState("claude-haiku-4-5");
  const [embeddings, setEmbeddings] = useState("none");
  const [secrets, setSecrets] = useState<Record<SecretKey, string>>({
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    VOYAGE_API_KEY: "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<AiTestResult | null>(null);

  async function load() {
    try {
      const response = await api.settings();
      setData(response);
      setProvider(response.values.AI_PROVIDER);
      setModel(response.values.AI_MODEL);
      setEmbeddings(response.values.EMBEDDINGS_PROVIDER);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      // Пустое поле секрета = «не трогать». Стирают отдельной кнопкой.
      const values: Record<string, string | null> = {
        AI_PROVIDER: provider,
        AI_MODEL: model,
        EMBEDDINGS_PROVIDER: embeddings,
      };
      for (const [key, value] of Object.entries(secrets)) {
        if (value.trim()) values[key] = value.trim();
      }
      const response = await api.saveSettings(values);
      setSecrets({ CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "", VOYAGE_API_KEY: "" });
      setMessage(`Сохранено, работает сразу: ${response.changed.length} пар.`);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearSecret(key: SecretKey) {
    if (!confirm("Стереть этот ключ с сервера?")) return;
    setBusy(true);
    try {
      await api.saveSettings({ [key]: null });
      await load();
      setMessage("Ключ стёрт. Если он есть в .env, вернётся значение оттуда.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setTest(null);
    setError(null);
    try {
      setTest(await api.testAi());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="card">
        {error ? <div className="notice error">{error}</div> : <span className="spinner" />}
      </div>
    );
  }

  return (
    <div className="card">
      <p className="meta" style={{ marginBottom: 14 }}>
        Ключи хранятся в базе зашифрованными тем же ключом, что и документы: прочитать
        их можно только при открытом архиве. Перезапускать контейнер не нужно.
      </p>

      <label className="field">
        <span>Кто разбирает документы</span>
        <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      {provider !== "off" && (
        <label className="field">
          <span>Модель</span>
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            {data.models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
            {!data.models.some((m) => m.id === model) && <option value={model}>{model}</option>}
          </select>
        </label>
      )}

      {provider === "cli" && (
        <SecretField
          label="Токен Claude Code"
          hint="Получить: claude setup-token"
          current={data.secrets.CLAUDE_CODE_OAUTH_TOKEN}
          fromEnv={data.envDefaults.hasEnvClaudeToken}
          value={secrets.CLAUDE_CODE_OAUTH_TOKEN}
          onChange={(v) => setSecrets({ ...secrets, CLAUDE_CODE_OAUTH_TOKEN: v })}
          onClear={() => void clearSecret("CLAUDE_CODE_OAUTH_TOKEN")}
          busy={busy}
        />
      )}

      {provider === "api" && (
        <SecretField
          label="Ключ Anthropic API"
          hint="console.anthropic.com → API keys"
          current={data.secrets.ANTHROPIC_API_KEY}
          fromEnv={data.envDefaults.hasEnvAnthropicKey}
          value={secrets.ANTHROPIC_API_KEY}
          onChange={(v) => setSecrets({ ...secrets, ANTHROPIC_API_KEY: v })}
          onClear={() => void clearSecret("ANTHROPIC_API_KEY")}
          busy={busy}
        />
      )}

      <label className="field">
        <span>Векторный поиск</span>
        <select className="input" value={embeddings} onChange={(e) => setEmbeddings(e.target.value)}>
          <option value="none">Выключен — полнотекстовый поиск</option>
          <option value="voyage">Voyage AI — нужен отдельный ключ</option>
        </select>
      </label>

      {embeddings === "voyage" && (
        <SecretField
          label="Ключ Voyage AI"
          hint="Новые документы получат вектор сразу, старые — после «Переразобрать»"
          current={data.secrets.VOYAGE_API_KEY}
          fromEnv={false}
          value={secrets.VOYAGE_API_KEY}
          onChange={(v) => setSecrets({ ...secrets, VOYAGE_API_KEY: v })}
          onClear={() => void clearSecret("VOYAGE_API_KEY")}
          busy={busy}
        />
      )}

      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice answer">{message}</div>}
      {test && (
        <div className={`notice ${test.ok ? "answer" : "error"}`}>
          {test.ok
            ? `Работает: ${test.provider} · ${test.model} · ${test.ms} мс · ответ «${test.answer}»`
            : `Не отвечает: ${test.error}`}
        </div>
      )}

      <div className="btn-row">
        <button className="btn primary" onClick={() => void save()} disabled={busy}>
          Сохранить
        </button>
        <button className="btn" onClick={() => void runTest()} disabled={busy}>
          {busy ? <span className="spinner" /> : "Проверить"}
        </button>
      </div>
    </div>
  );
}

function SecretField({
  label, hint, current, fromEnv, value, onChange, onClear, busy,
}: {
  label: string;
  hint: string;
  current: string | null;
  fromEnv: boolean;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  busy: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={current ? `задан: ${current} — оставь пустым, чтобы не менять` : "не задан"}
      />
      <div className="between" style={{ marginTop: 6 }}>
        <span className="meta">
          {hint}
          {current && fromEnv ? " · сейчас из .env" : ""}
        </span>
        {current && (
          <button className="btn small ghost" type="button" onClick={onClear} disabled={busy}>
            стереть
          </button>
        )}
      </div>
    </label>
  );
}
