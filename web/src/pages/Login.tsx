import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api.ts";

interface Props {
  mode: "login" | "unlock";
  login?: string;
  onDone: () => void;
}

export function Login({ mode, login: knownLogin, onDone }: Props) {
  const [login, setLogin] = useState(knownLogin ?? "");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "unlock") await api.unlock(password);
      else await api.login(login, password, totp || undefined);
      setPassword("");
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.payload.needTotp) {
        setNeedTotp(true);
        setError("Введи код из приложения-аутентификатора");
      } else {
        setError(err instanceof Error ? err.message : "не вышло войти");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="auth-box" onSubmit={submit}>
        <h1>{mode === "unlock" ? "Открыть архив" : "Документы"}</h1>
        <p className="hint">
          {mode === "unlock"
            ? "Сервер перезапускался — ключ шифрования нужно ввести заново."
            : "Личный архив. Вход только по паролю."}
        </p>

        {mode === "login" && (
          <label className="field">
            <span>Логин</span>
            <input
              className="input"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
          </label>
        )}

        <label className="field">
          <span>Пароль</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {(needTotp || mode === "login") && (
          <label className="field">
            <span>Код из аутентификатора {needTotp ? "" : "(если включён)"}</span>
            <input
              className="input"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
            />
          </label>
        )}

        {error && <div className="notice error">{error}</div>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : mode === "unlock" ? "Открыть" : "Войти"}
        </button>
      </form>
    </div>
  );
}
