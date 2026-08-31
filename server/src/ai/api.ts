import Anthropic from "@anthropic-ai/sdk";
import { runtime } from "../settings/store.js";
import type { AiRequest } from "./index.js";

let client: Anthropic | null = null;
let clientKey: string | undefined;

// Ключ меняется прямо в интерфейсе, поэтому клиента пересоздаём при смене.
function getClient(): Anthropic {
  const apiKey = runtime().anthropicKey;
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

/** Резервный путь: обычный Anthropic API по ключу, если CLI на сервере нет. */
export async function askApi(req: AiRequest): Promise<string> {
  const content: Anthropic.ContentBlockParam[] = [];

  if (req.fileBuffer && req.mime) {
    const data = req.fileBuffer.toString("base64");
    if (req.mime === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      });
    } else if (req.mime.startsWith("image/")) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: req.mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data,
        },
      });
    }
  }
  content.push({ type: "text", text: req.prompt });

  const response = await getClient().messages.create({
    model: runtime().aiModel,
    max_tokens: req.maxTokens ?? 8000,
    ...(req.system ? { system: req.system } : {}),
    messages: [{ role: "user", content }],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
