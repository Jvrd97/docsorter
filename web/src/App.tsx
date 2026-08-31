import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./lib/api.ts";
import { Login } from "./pages/Login.tsx";
import { SearchPage } from "./pages/Search.tsx";
import { UploadPage } from "./pages/Upload.tsx";
import { BrowsePage } from "./pages/Browse.tsx";
import { DocPage } from "./pages/Doc.tsx";
import { SettingsPage } from "./pages/Settings.tsx";

interface Session {
  login: string;
  vaultUnlocked: boolean;
  totpEnabled: boolean;
}

export default function App() {
  const [session, setSession] = useState<Session | null | "loading">("loading");

  const refresh = useCallback(async () => {
    try {
      setSession(await api.me());
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Сессия могла протухнуть на сервере, пока приложение висело в фоне.
  useEffect(() => {
    const onFocus = () => {
      if (session && session !== "loading") void refresh();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [session, refresh]);

  if (session === "loading") {
    return (
      <div className="center-screen">
        <span className="spinner" />
      </div>
    );
  }

  if (!session) return <Login mode="login" onDone={refresh} />;
  if (!session.vaultUnlocked) return <Login mode="unlock" login={session.login} onDone={refresh} />;

  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Navigate to="/search" replace />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/doc/:id" element={<DocPage />} />
        <Route path="/settings" element={<SettingsPage login={session.login} onLogout={refresh} />} />
        <Route path="*" element={<Navigate to="/search" replace />} />
      </Routes>

      <nav className="tabbar">
        <Tab to="/search" icon="🔍" label="Поиск" />
        <Tab to="/upload" icon="＋" label="Добавить" />
        <Tab to="/browse" icon="🗂" label="Архив" />
        <Tab to="/settings" icon="⚙︎" label="Ещё" />
      </nav>
    </div>
  );
}

function Tab({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")}>
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "что-то пошло не так";
}
