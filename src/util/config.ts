import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

export function getConfig(): AnamnesisConfig {
  if (_config) return _config;

  const configPath = resolve(PROJECT_ROOT, 'anamnesis.config.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    _config = { ...DEFAULT_CONFIG, ...raw, database: { ...DEFAULT_CONFIG.database, ...raw.database }, ollama: { ...DEFAULT_CONFIG.ollama, ...raw.ollama }, topic_model: { ...DEFAULT_CONFIG.topic_model, ...raw.topic_model }, concurrency: { ...DEFAULT_CONFIG.concurrency, ...raw.concurrency } };
  } else {
    _config = DEFAULT_CONFIG;
  }

  if (!_config!.transcripts_root) {
    throw new Error(
      'transcripts_root is not configured. Create anamnesis.config.json from anamnesis.config.example.json ' +
      'and set transcripts_root to your Claude Code transcripts directory (e.g., ~/.claude/projects).'
    );
  }

  return _config!;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
