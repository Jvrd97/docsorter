import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../env.js";
import type { AiRequest } from "./index.js";

const exec = promisify(execFile);

/**
 * Claude Code CLI по OAuth-токену подписки: платить за API отдельно не нужно.
 * Файл модель читает сама инструментом Read — поэтому в filePath передаётся
 * путь к расшифрованной временной копии, а не байты.
 */
export async function askCli(req: AiRequest): Promise<string> {
  const prompt = req.filePath
    ? `Прочитай файл по пути: ${req.filePath}\n\n${req.prompt}`
    : req.prompt;

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    env.AI_MODEL,
    "--allowedTools",
    "Read",
  ];
  if (req.system) args.push("--append-system-prompt", req.system);

  const { stdout } = await exec(env.CLAUDE_BIN, args, {
    timeout: env.AI_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      ...(env.CLAUDE_CODE_OAUTH_TOKEN
        ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }
        : {}),
    },
  });

  const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
  if (envelope.is_error) throw new Error(`claude cli: ${envelope.result ?? "unknown"}`);
  return envelope.result ?? "";
}
