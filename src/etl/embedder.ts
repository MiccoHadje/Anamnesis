import { getConfig } from '../util/config.js';

interface EmbeddingResponse {
  embedding: number[];
}

/**
 * Generate an embedding using Ollama's bge-m3 model.
 */
export async function embed(text: string): Promise<number[]> {
  const { ollama } = getConfig();
  const resp = await fetch(`${ollama.url}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollama.model, prompt: text }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embedding failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as EmbeddingResponse;
  return data.embedding;
}

/**
 * Generate embeddings for multiple texts with concurrency control.
 */
export async function embedBatch(
  texts: string[],
  concurrency = 4,
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let done = 0;

  // Process in chunks of `concurrency`
  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = texts.slice(i, i + concurrency);
    const promises = batch.map(async (text, j) => {
      const embedding = await embed(text);
      results[i + j] = embedding;
      done++;
      onProgress?.(done, texts.length);
    });
    await Promise.all(promises);
  }

  return results;
}

/**
 * Average multiple embeddings into a single vector.
 */
export function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const avg = new Array<number>(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      avg[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    avg[i] /= embeddings.length;
  }
  return avg;
}
