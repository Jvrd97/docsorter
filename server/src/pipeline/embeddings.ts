import { runtime } from "../settings/store.js";

/**
 * У Claude нет своего эндпойнта эмбеддингов, поэтому векторный поиск —
 * отдельный поставщик и он выключен по умолчанию. Без него работает
 * полнотекстовый поиск + переранжирование моделью, чего для личного
 * архива в тысячи документов достаточно.
 */
export function embeddingsEnabled(): boolean {
  return runtime().embeddingsProvider !== "none";
}

export async function embed(text: string): Promise<number[] | null> {
  const config = runtime();
  if (config.embeddingsProvider !== "voyage" || !config.voyageKey) return null;

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.voyageKey}`,
    },
    body: JSON.stringify({
      model: config.voyageModel,
      input: [text.slice(0, 30_000)],
      input_type: "document",
      output_dimension: 1024,
    }),
  });
  if (!response.ok) throw new Error(`voyage ${response.status}: ${await response.text()}`);

  const body = (await response.json()) as { data?: Array<{ embedding: number[] }> };
  return body.data?.[0]?.embedding ?? null;
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
