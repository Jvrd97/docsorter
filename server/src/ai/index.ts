import { env } from "../env.js";
import { askCli } from "./cli.js";
import { askApi } from "./api.js";

export interface AiRequest {
  system?: string;
  prompt: string;
  /** Путь к уже расшифрованному временному файлу — CLI читает его сам. */
  filePath?: string;
  /** Тот же файл в памяти — нужен режиму api. */
  fileBuffer?: Buffer;
  mime?: string;
  maxTokens?: number;
}

export class AiUnavailable extends Error {}

export async function ask(req: AiRequest): Promise<string> {
  if (env.AI_PROVIDER === "off") throw new AiUnavailable("AI_PROVIDER=off");
  return env.AI_PROVIDER === "api" ? askApi(req) : askCli(req);
}

/** Вытаскивает первый сбалансированный JSON-объект из ответа модели. */
export function extractJson<T>(raw: string): T | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function askJson<T>(req: AiRequest): Promise<T | null> {
  return extractJson<T>(await ask(req));
}

export const aiEnabled = env.AI_PROVIDER !== "off";
