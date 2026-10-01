import { existsSync } from 'node:fs';
import path from 'node:path';

// Load .env before any module reads process.env (Node ≥ 20.12 built-in; never overrides real env vars)
const envPath = path.resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (e) {
    console.warn('[env] could not load .env:', (e as Error).message);
  }
}
