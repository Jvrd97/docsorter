import { env } from "../env.js";

/**
 * У Claude нет своего эндпойнта эмбеддингов, поэтому векторный поиск —
 * отдельный поставщик и он выключен по умолчанию. Без него работает
 * полнотекстовый поиск + переранжирование моделью, чего для личного
 * архива в тысячи документов достаточно.
 */
export const embeddingsEnabled = env.EMBEDDINGS_PROVIDER !== "none";

export async function embed(text: string): Promise<number[] | null> {
  if (env.EMBEDDINGS_PROVIDER !== "voyage" || !env.VOYAGE_API_KEY) return null;

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.VOYAGE_MODEL,
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
