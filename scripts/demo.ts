// `npm run demo`: server (demo mode) + UI with a single command, on Linux/macOS/Windows.
// Steps: temporary SQLite database -> prisma generate -> migrations -> server + Vite -> wait until ready.
// JWT_SECRET is generated randomly for this process (scripts/demoEnv.ts); it is never written to disk and the repo holds no fixed secret.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDemoEnv } from './demoEnv';

const root = resolve(import.meta.dirname, '..');
const apiPort = Number(process.env.DEMO_API_PORT ?? 3001);
const uiPort = Number(process.env.DEMO_UI_PORT ?? 3000);
const verbose = process.env.DEMO_VERBOSE === '1';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
    console.error(`[demo] Node 22+ required (found: ${process.versions.node}).`);
    process.exit(1);
}

function cli(relativePath: string): string {
    const full = join(root, 'node_modules', relativePath);
    if (!existsSync(full)) {
        console.error(`[demo] ${relativePath} not found. Run "npm install" first.`);
        process.exit(1);
    }
    return full;
}

const workDir = mkdtempSync(join(tmpdir(), 'alphapulse-demo-'));
const env = buildDemoEnv(process.env, {
    apiPort,
    uiPort,
    databaseUrl: pathToFileURL(join(workDir, 'demo.db')).href,
});

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
        if (child.exitCode === null) child.kill('SIGTERM');
    }
    setTimeout(() => {
        for (const child of children) {
            if (child.exitCode === null) child.kill('SIGKILL');
        }
        process.exit(code);
    }, 500);
}

// The temporary database directory is removed on every exit path (Ctrl+C, SIGTERM, child process failure).
process.on('exit', () => rmSync(workDir, { recursive: true, force: true }));

function runStep(label: string, args: string[]): void {
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) {
        console.error(`[demo] ${label} failed:\n${result.stdout}${result.stderr}`);
        rmSync(workDir, { recursive: true, force: true });
        process.exit(1);
    }
    console.log(`[demo] ${label} done`);
}

function start(name: string, args: string[], quiet: (line: string) => boolean): ChildProcess {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (stream: NodeJS.ReadableStream, write: (text: string) => void) => {
        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim() && (verbose || !quiet(line))) write(`[${name}] ${line}`);
            }
        });
    };
    forward(child.stdout!, (text) => console.log(text));
    forward(child.stderr!, (text) => console.error(text));
    child.on('exit', (code, signal) => {
        if (!shuttingDown) {
            console.error(`[demo] ${name} exited unexpectedly (code=${code ?? signal}). Stopping the demo.`);
            shutdown(1);
        }
    });
    children.push(child);
    return child;
}

async function waitFor(url: string, label: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (shuttingDown) return;
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // not up yet
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    console.error(`[demo] ${label} was not ready within ${timeoutMs / 1000} s (${url}).`);
    shutdown(1);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[demo] Preparing the AlphaPulse demo (sample data, no external services)...');
runStep('prisma generate', [cli('prisma/build/index.js'), 'generate']);
runStep('database migrations', [join(root, 'scripts/apply-local-migrations.mjs')]);

start('api', [cli('tsx/dist/cli.mjs'), 'server/index.ts'], (line) => line.includes('"event":"http_request"'));
start('ui', [cli('vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], () => false);

await waitFor(`http://127.0.0.1:${apiPort}/health`, 'API');
await waitFor(`http://127.0.0.1:${uiPort}/`, 'UI');

if (!shuttingDown) {
    console.log('');
    console.log(`[demo] READY  ui: http://127.0.0.1:${uiPort}   api: http://127.0.0.1:${apiPort}/health`);
    console.log('[demo] Press Ctrl+C to stop.');
}
