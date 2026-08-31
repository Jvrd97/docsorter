import { spawn } from "node:child_process";
import { env } from "../env.js";
import { runtime } from "../settings/store.js";
import type { AiRequest } from "./index.js";

/**
 * Claude Code CLI по OAuth-токену подписки: платить за API отдельно не нужно.
 * Файл модель читает сама инструментом Read — поэтому в filePath передаётся
 * путь к расшифрованной временной копии, а не байты.
 *
 * spawn, а не execFile: нужно закрыть stdin. Иначе CLI три секунды ждёт данных
 * на входе — на архиве в сотни документов это лишние минуты на пустом месте.
 */
export async function askCli(req: AiRequest): Promise<string> {
  const config = runtime();
  const prompt = req.filePath
    ? `Прочитай файл по пути: ${req.filePath}\n\n${req.prompt}`
    : req.prompt;

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", config.aiModel,
    "--allowedTools", "Read",
  ];
  if (req.system) args.push("--append-system-prompt", req.system);

  const { stdout, stderr, code } = await run(env.CLAUDE_BIN, args, {
    ...process.env,
    ...(config.claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeToken } : {}),
  });

  // Даже при ненулевом коде CLI печатает JSON, и причина лежит в поле result.
  // Разбираем его первым, иначе в ошибку попадает служебный шум вместо смысла.
  const envelope = parseEnvelope(stdout);

  if (envelope?.is_error || code !== 0) {
    const reason = envelope?.result ?? stderr ?? stdout;
    throw new Error(`claude cli: ${tail(reason)}`);
  }
  if (!envelope) throw new Error(`claude cli вернул не JSON: ${tail(stdout || stderr)}`);
  return envelope.result ?? "";
}

function parseEnvelope(stdout: string): { result?: string; is_error?: boolean } | null {
  try {
    return JSON.parse(stdout) as { result?: string; is_error?: boolean };
  } catch {
    return null;
  }
}

function run(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"], // stdin закрыт — CLI не ждёт ввода
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`claude cli не ответил за ${Math.round(env.AI_TIMEOUT_MS / 1000)} с`));
    }, env.AI_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`не найден исполняемый файл «${command}» — CLI не установлен в контейнере`)
          : err,
      );
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Последние осмысленные строки вывода: начало обычно занято предупреждениями. */
function tail(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Warning: no stdin/i.test(line));
  return lines.slice(-4).join(" · ").slice(0, 600) || "пустой вывод";
}
