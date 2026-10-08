import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const candidates = process.platform === 'win32'
  ? [path.join('quant-engine', 'venv', 'Scripts', 'python.exe'), 'python']
  : [path.join('quant-engine', 'venv', 'bin', 'python'), 'python3', 'python'];

const python = candidates.find((candidate) => candidate === 'python' || candidate === 'python3' || existsSync(candidate));
const result = spawnSync(
  python ?? 'python',
  ['-m', 'unittest', 'discover', 'quant-engine/tests'],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
