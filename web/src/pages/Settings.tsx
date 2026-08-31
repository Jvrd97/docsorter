import { useEffect, useState } from "react";
import { api, formatBytes } from "../lib/api.ts";
import { errorText } from "../App.tsx";

export function SettingsPage({ login, onLogout }: { login: string; onLogout: () => void }) {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installHint, setInstallHint] = useState(false);

  useEffect(() => {
    api.stats().then(setStats).catch(() => undefined);
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    setInstallHint(!standalone);
  }, []);

  async function changePassword() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.changePassword(oldPassword, newPassword);
      setMessage("Пароль изменён. Все сессии закрыты, войди заново.");
      setOldPassword("");
      setNewPassword("");
      setTimeout(onLogout, 1500);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="header">
        <h1>Настройки</h1>
      </header>

      <div className="page">
        <div className="card">
          <dl className="kv">
            <dt>Вход как</dt><dd>{login}</dd>
            {stats && (
              <>
                <dt>Документов</dt><dd>{stats.stats.total}</dd>
                <dt>Разобрано</dt><dd>{stats.stats.ready}</dd>
                <dt>В работе</dt><dd>{stats.stats.in_progress}</dd>
                <dt>Ошибок</dt><dd>{stats.stats.failed}</dd>
                <dt>Объём</dt><dd>{formatBytes(stats.stats.bytes)}</dd>
              </>
            )}
          </dl>
        </div>

        {installHint && (
          <div className="notice">
            <b>Поставить как приложение:</b> в Safari нажми «Поделиться» → «На экран
            «Домой»». Тогда откроется без адресной строки и запомнит вход.
          </div>
        )}

        <div className="section-title">Сменить пароль</div>
        <div className="card">
          <p className="meta" style={{ marginBottom: 12 }}>
            Пароль — это ключ от файлов. Смена пароля не перешифровывает архив: меняется
            только обёртка вокруг ключа, поэтому это быстро. Все сессии закроются.
          </p>
          <label className="field">
            <span>Текущий пароль</span>
            <input
              className="input"
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="field">
            <span>Новый пароль (от 16 символов)</span>
            <input
              className="input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {error && <div className="notice error">{error}</div>}
          {message && <div className="notice answer">{message}</div>}
          <button
            className="btn"
            disabled={busy || newPassword.length < 16 || !oldPassword}
            onClick={() => void changePassword()}
          >
            Сменить пароль
          </button>
        </div>

        <div className="section-title">Сессия</div>
        <div className="btn-row">
          <button
            className="btn danger"
            onClick={async () => {
              await api.logout();
              onLogout();
            }}
          >
            Выйти и запереть архив
          </button>
        </div>
      </div>
    </>
  );
}
