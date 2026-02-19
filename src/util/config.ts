import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

export interface AnamnesisConfig {
  exclude_projects: string[];
  exclude_sessions: string[];
  transcripts_root: string;
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
  };
  ollama: {
    url: string;
    model: string;
  };
}

const DEFAULT_CONFIG: AnamnesisConfig = {
  exclude_projects: [],
  exclude_sessions: [],
  transcripts_root: 'C:/Users/clay/.claude/projects',
  database: {
    host: 'localhost',
    port: 5432,
    database: 'anamnesis',
    user: 'clay',
  },
  ollama: {
    url: 'http://localhost:11434',
    model: 'bge-m3',
  },
};

let _config: AnamnesisConfig | null = null;

export function getConfig(): AnamnesisConfig {
  if (_config) return _config;

  const configPath = resolve(PROJECT_ROOT, 'anamnesis.config.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    _config = { ...DEFAULT_CONFIG, ...raw, database: { ...DEFAULT_CONFIG.database, ...raw.database }, ollama: { ...DEFAULT_CONFIG.ollama, ...raw.ollama } };
  } else {
    _config = DEFAULT_CONFIG;
  }
  return _config!;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
