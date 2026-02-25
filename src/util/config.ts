import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

export interface AnamnesisConfig {
  exclude_projects: string[];
  exclude_sessions: string[];
  transcripts_root: string;
  search_mode: 'hybrid' | 'vector';
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
  };
  ollama: {
    url: string;
    model: string;
  };
  topic_model: {
    url: string;
    model: string;
  };
  concurrency: {
    embedding: number;
    topics: number;
  };
  reporting?: {
    projects: Array<{
      name: string;
      anamnesis_project: string;
      daily_log_dir?: string;
      nudge_project?: string;
    }>;
    reports_dir: string;
  };
}

const DEFAULT_CONFIG: AnamnesisConfig = {
  exclude_projects: [],
  exclude_sessions: [],
  transcripts_root: '',
  search_mode: 'hybrid',
  database: {
    host: 'localhost',
    port: 5432,
    database: 'anamnesis',
    user: 'anamnesis',
  },
  ollama: {
    url: 'http://localhost:11434',
    model: 'bge-m3',
  },
  topic_model: {
    url: 'http://localhost:11434',
    model: 'gemma3:12b',
  },
  concurrency: {
    embedding: 4,
    topics: 2,
  },
};

let _config: AnamnesisConfig | null = null;

/** Resolve ~ or ~/ at the start of a path to the user's home directory. */
function resolveTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/** Apply environment variable overrides (highest priority). */
function applyEnvOverrides(config: AnamnesisConfig): void {
  if (process.env.ANAMNESIS_TRANSCRIPTS_ROOT) {
    config.transcripts_root = process.env.ANAMNESIS_TRANSCRIPTS_ROOT;
  }
  if (process.env.ANAMNESIS_DB_HOST) {
    config.database.host = process.env.ANAMNESIS_DB_HOST;
  }
  if (process.env.ANAMNESIS_DB_PORT) {
    config.database.port = parseInt(process.env.ANAMNESIS_DB_PORT, 10);
  }
  if (process.env.ANAMNESIS_DB_NAME) {
    config.database.database = process.env.ANAMNESIS_DB_NAME;
  }
  if (process.env.ANAMNESIS_DB_USER) {
    config.database.user = process.env.ANAMNESIS_DB_USER;
  }
  if (process.env.ANAMNESIS_DB_PASSWORD) {
    config.database.password = process.env.ANAMNESIS_DB_PASSWORD;
  }
  if (process.env.ANAMNESIS_OLLAMA_URL) {
    config.ollama.url = process.env.ANAMNESIS_OLLAMA_URL;
  }
}

export function getConfig(): AnamnesisConfig {
  if (_config) return _config;

  const configPath = resolve(PROJECT_ROOT, 'anamnesis.config.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    _config = { ...DEFAULT_CONFIG, ...raw, database: { ...DEFAULT_CONFIG.database, ...raw.database }, ollama: { ...DEFAULT_CONFIG.ollama, ...raw.ollama }, topic_model: { ...DEFAULT_CONFIG.topic_model, ...raw.topic_model }, concurrency: { ...DEFAULT_CONFIG.concurrency, ...raw.concurrency }, ...(raw.reporting ? { reporting: raw.reporting } : {}) };
  } else {
    _config = DEFAULT_CONFIG;
  }

  // Env vars override config file (highest priority)
  applyEnvOverrides(_config!);

  // Resolve ~ in transcripts_root
  if (_config!.transcripts_root) {
    _config!.transcripts_root = resolveTilde(_config!.transcripts_root);
  }

  if (!_config!.transcripts_root) {
    throw new Error(
      'transcripts_root is not configured. Create anamnesis.config.json from anamnesis.config.example.json ' +
      'and set transcripts_root to your Claude Code transcripts directory (e.g., ~/.claude/projects), ' +
      'or set the ANAMNESIS_TRANSCRIPTS_ROOT environment variable.'
    );
  }

  return _config!;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
