import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { ConfigError } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

export interface AnamnesisConfig {
  exclude_projects: string[];
  exclude_sessions: string[];
  transcripts_root: string;
  search_mode: 'hybrid' | 'vector';
  max_embedding_chars: number;
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
    strategy: 'full' | 'first_message';
    preserve_words?: string[];
  };
  concurrency: {
    embedding: number;
    topics: number;
  };
  tasks?: {
    provider: 'nudge' | 'filesystem' | 'github' | 'todoist' | 'linear';
    nudge?: { host: string; port: number; database: string; user: string; password?: string };
    filesystem?: { path: string; name?: string };
    github?: { repos: Record<string, string>; blocked_label?: string };
    todoist?: { api_token: string; projects: Record<string, string>; blocked_label?: string };
    linear?: { api_key: string; teams: Record<string, string>; blocked_label?: string };
  };
  server?: {
    port: number;
    host: string;
    ingest_interval_minutes: number;
    pid_file: string;
  };
  reporting?: {
    projects: Array<{
      name: string;
      anamnesis_project: string;
      daily_log_dir?: string;
      task_project?: string;
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
  max_embedding_chars: 8000,
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
    strategy: 'full' as const,
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
  if (process.env.ANAMNESIS_SERVER_PORT && config.server) {
    config.server.port = parseInt(process.env.ANAMNESIS_SERVER_PORT, 10);
  }
  if (process.env.ANAMNESIS_SERVER_HOST && config.server) {
    config.server.host = process.env.ANAMNESIS_SERVER_HOST;
  }
}

/** Validate config values. Throws ConfigError on invalid config. */
function validateConfig(config: AnamnesisConfig): void {
  const { database, ollama, topic_model, concurrency, max_embedding_chars } = config;

  if (database.port < 1 || database.port > 65535) {
    throw new ConfigError(`Invalid database.port: ${database.port} (must be 1-65535)`);
  }

  for (const [name, section] of [['ollama', ollama], ['topic_model', topic_model]] as const) {
    const url = section.url;
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
      throw new ConfigError(`Invalid ${name}.url: "${url}" (must start with http:// or https://)`);
    }
  }

  if (concurrency.embedding < 1) {
    throw new ConfigError(`Invalid concurrency.embedding: ${concurrency.embedding} (must be >= 1)`);
  }
  if (concurrency.topics < 1) {
    throw new ConfigError(`Invalid concurrency.topics: ${concurrency.topics} (must be >= 1)`);
  }

  if (max_embedding_chars < 100) {
    throw new ConfigError(`Invalid max_embedding_chars: ${max_embedding_chars} (must be >= 100)`);
  }

  if (config.search_mode !== 'hybrid' && config.search_mode !== 'vector') {
    throw new ConfigError(`Invalid search_mode: "${config.search_mode}" (must be "hybrid" or "vector")`);
  }

  if (config.server) {
    if (config.server.port < 1 || config.server.port > 65535) {
      throw new ConfigError(`Invalid server.port: ${config.server.port} (must be 1-65535)`);
    }
    if (config.server.ingest_interval_minutes < 1) {
      throw new ConfigError(`Invalid server.ingest_interval_minutes: ${config.server.ingest_interval_minutes} (must be >= 1)`);
    }
  }
}

export function getConfig(): AnamnesisConfig {
  if (_config) return _config;

  const configPath = resolve(PROJECT_ROOT, 'anamnesis.config.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    _config = {
      ...DEFAULT_CONFIG,
      ...raw,
      database: { ...DEFAULT_CONFIG.database, ...raw.database },
      ollama: { ...DEFAULT_CONFIG.ollama, ...raw.ollama },
      topic_model: { ...DEFAULT_CONFIG.topic_model, ...raw.topic_model },
      concurrency: { ...DEFAULT_CONFIG.concurrency, ...raw.concurrency },
      ...(raw.reporting ? { reporting: raw.reporting } : {}),
      ...(raw.tasks ? { tasks: raw.tasks } : {}),
      ...(raw.server ? {
        server: {
          port: 3851,
          host: '127.0.0.1',
          ingest_interval_minutes: 15,
          pid_file: '~/.claude/anamnesis.pid',
          ...raw.server,
        },
      } : {}),
    };
  } else {
    _config = DEFAULT_CONFIG;
  }

  // Env vars override config file (highest priority)
  applyEnvOverrides(_config!);

  // Resolve ~ in transcripts_root
  if (_config!.transcripts_root) {
    _config!.transcripts_root = resolveTilde(_config!.transcripts_root);
  }

  // Resolve ~ in server.pid_file
  if (_config!.server?.pid_file) {
    _config!.server.pid_file = resolveTilde(_config!.server.pid_file);
  }

  if (!_config!.transcripts_root) {
    throw new Error(
      'transcripts_root is not configured. Create anamnesis.config.json from anamnesis.config.example.json ' +
      'and set transcripts_root to your Claude Code transcripts directory (e.g., ~/.claude/projects), ' +
      'or set the ANAMNESIS_TRANSCRIPTS_ROOT environment variable.'
    );
  }

  // Validate after all overrides applied
  validateConfig(_config!);

  return _config!;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
