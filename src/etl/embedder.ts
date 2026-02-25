import { execSync } from 'child_process';
import { getConfig } from '../util/config.js';

interface EmbeddingResponse {
  embedding: number[];
}

/**
 * Check that Ollama is reachable and the embedding model is available.
 * On Windows, attempts to start Ollama if it's not running.
 * Call once before starting a batch operation.
 */
export async function ensureOllama(): Promise<void> {
  const { ollama } = getConfig();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(`${ollama.url}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);
      const data = (await resp.json()) as { models: { name: string }[] };
      const names = data.models.map(m => m.name.replace(/:latest$/, ''));
      if (!names.includes(ollama.model)) {
        throw new Error(
          `Model "${ollama.model}" not found in Ollama. Available: ${names.join(', ')}. Run: ollama pull ${ollama.model}`
        );
      }
      return; // success
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && (msg.includes('fetch failed') || msg.includes('ECONNREFUSED'))) {
        // Try to start Ollama on Windows
        if (process.platform === 'win32') {
          console.log('Ollama not running — attempting to start...');
          try {
            execSync('start "" "ollama" serve', { shell: 'cmd.exe', stdio: 'ignore' });
            // Give it a few seconds to start
            await new Promise(r => setTimeout(r, 5000));
            continue; // retry
          } catch {
            // start command failed — fall through to error
          }
        }
      }
      throw new Error(`Ollama not reachable at ${ollama.url}: ${msg}`);
    }
  }
}

/**
 * Generate an embedding using Ollama's bge-m3 model.
 * Retries up to 3 times with exponential backoff on transient errors.
 */
export async function embed(text: string, maxRetries = 3): Promise<number[]> {
  const { ollama } = getConfig();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${ollama.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollama.model, prompt: text }),
        signal: AbortSignal.timeout(30000),
      });

      if (resp.ok) {
        const data = (await resp.json()) as EmbeddingResponse;
        return data.embedding;
      }

      // Non-retryable client errors
      if (resp.status >= 400 && resp.status < 500) {
        throw new Error(`Ollama embedding failed: ${resp.status} ${resp.statusText}`);
      }

      // Server error — retryable
      if (attempt === maxRetries) {
        throw new Error(`Ollama embedding failed after ${maxRetries + 1} attempts: ${resp.status} ${resp.statusText}`);
      }
    } catch (err: unknown) {
      if (attempt === maxRetries) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry non-transient errors
      if (msg.includes('400') || msg.includes('404')) throw err;
    }

    // Exponential backoff: 2s, 4s, 8s
    const delay = 2000 * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
  }

  throw new Error('Unreachable');
}

/**
 * Generate embeddings for multiple texts with concurrency control.
 * Default concurrency of 2 keeps VRAM pressure low for bge-m3 on a single GPU.
 */
export async function embedBatch(
  texts: string[],
  concurrency?: number,
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  concurrency = concurrency ?? getConfig().concurrency.embedding;
  const results: number[][] = new Array(texts.length);
  let done = 0;

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
