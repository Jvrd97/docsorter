export interface DocumentCard {
  id: string;
  status: "pending" | "processing" | "ready" | "failed";
  title: string | null;
  category: string | null;
  sender: string | null;
  summary: string | null;
  doc_date: string | null;
  due_date: string | null;
  amount: string | null;
  currency: string | null;
  tags: string[];
  action_needed: string | null;
  original_name: string;
  mime: string;
  size_bytes: string;
  page_count: number | null;
  has_thumb: boolean;
  favorite: boolean;
  archived: boolean;
  error: string | null;
  created_at: string;
  processed_at: string | null;
  full_text?: string | null;
  snippet?: string | null;
}

export interface DocLink {
  id: string;
  kind: string;
  reason: string | null;
  confidence: number;
  source: string;
  other_id: string;
  other_title: string | null;
  other_sender: string | null;
  other_category: string | null;
  other_date: string | null;
  other_has_thumb: boolean;
}

export interface Entity {
  id: string;
  kind: string;
  value: string;
}

export interface Settings {
  values: {
    AI_PROVIDER: "cli" | "api" | "off";
    AI_MODEL: string;
    EMBEDDINGS_PROVIDER: "none" | "voyage";
    VOYAGE_MODEL: string;
  };
  /** Хвост секрета или null. Полное значение сервер не отдаёт никогда. */
  secrets: Record<"CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | "VOYAGE_API_KEY", string | null>;
  models: Array<{ id: string; label: string }>;
  envDefaults: {
    AI_PROVIDER: string;
    AI_MODEL: string;
    EMBEDDINGS_PROVIDER: string;
    hasEnvClaudeToken: boolean;
    hasEnvAnthropicKey: boolean;
  };
}

export interface AiTestResult {
  ok: boolean;
  provider?: string;
  model?: string;
  ms?: number;
  answer?: string;
  error?: string;
}

export interface Facets {
  categories: Array<{ value: string; count: number }>;
  senders: Array<{ value: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
  years: Array<{ value: number; count: number }>;
  allCategories: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public payload: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(response.status, String(data.error ?? `ошибка ${response.status}`), data);
  }
  return data as T;
}

export const api = {
  me: () => request<{ login: string; vaultUnlocked: boolean; totpEnabled: boolean }>("/api/auth/me"),

  login: (login: string, password: string, totp?: string) =>
    request<{ login: string; vaultUnlocked: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login, password, ...(totp ? { totp } : {}) }),
    }),

  unlock: (password: string) =>
    request<{ vaultUnlocked: boolean }>("/api/auth/unlock", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    }),

  list: (params: Record<string, string | number | boolean | string[] | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "" ) continue;
      if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
      else search.set(key, String(value));
    }
    return request<{ documents: DocumentCard[]; total: number }>(`/api/documents?${search}`);
  },

  get: (id: string) =>
    request<{ document: DocumentCard; entities: Entity[]; links: DocLink[] }>(`/api/documents/${id}`),

  patch: (id: string, patch: Record<string, unknown>) =>
    request<{ document: DocumentCard }>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  remove: (id: string) => request<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE" }),

  reanalyze: (id: string) =>
    request<{ ok: true }>(`/api/documents/${id}/reanalyze`, { method: "POST" }),

  addLink: (id: string, toId: string, kind = "manual", reason?: string) =>
    request<{ ok: true }>(`/api/documents/${id}/links`, {
      method: "POST",
      body: JSON.stringify({ toId, kind, reason }),
    }),

  removeLink: (linkId: string) => request<{ ok: true }>(`/api/links/${linkId}`, { method: "DELETE" }),

  search: (q: string, mode: "fast" | "smart") =>
    request<{
      mode: string;
      answer: string | null;
  /** Умный поиск не сработал и откатился на поиск по словам — почему. */
  note?: string | null;
      plan: { restated?: string } | null;
      documents: DocumentCard[];
    }>("/api/search", { method: "POST", body: JSON.stringify({ q, mode }) }),

  facets: () => request<Facets>("/api/facets"),

  settings: () => request<Settings>("/api/settings"),

  saveSettings: (values: Record<string, string | null>) =>
    request<{ ok: true; changed: string[] }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ values }),
    }),

  testAi: () => request<AiTestResult>("/api/settings/test", { method: "POST" }),

  stats: () =>
    request<{
      stats: { total: number; ready: number; in_progress: number; failed: number; todo: number; bytes: string };
      due: DocumentCard[];
    }>("/api/stats"),

  upload: (files: File[], onProgress?: (sent: number, total: number) => void) =>
    new Promise<{ created: unknown[]; skipped: unknown[] }>((resolve, reject) => {
      const form = new FormData();
      for (const file of files) form.append("file", file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/documents");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.total);
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText || "{}");
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new ApiError(xhr.status, data.error ?? `ошибка ${xhr.status}`, data));
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "сеть недоступна"));
      xhr.send(form);
    }),
};

export function formatBytes(bytes: number | string): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

export function formatDate(value: string | null): string {
  if (!value) return "без даты";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${day}.${month}.${year}`;
}

export function formatMoney(amount: string | null, currency: string | null): string | null {
  if (amount === null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? "€"}`;
}

/** «1 документ», «2 документа», «5 документов». */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} ${many}`;
  if (mod10 === 1) return `${count} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}
