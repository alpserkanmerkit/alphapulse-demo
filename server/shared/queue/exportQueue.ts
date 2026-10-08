import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import path from 'node:path';

let exportQueue: Queue | null = null;

export interface ExportQueueDiagnostics {
    configured: boolean;
    redisConfigured: boolean;
    pdfExportEnabled: boolean;
    rendererImplemented: boolean;
    mode: 'disabled' | 'queue_configured_renderer_ready';
}

export function isExportQueueConfigured(): boolean {
    return Boolean(process.env.REDIS_URL && process.env.PDF_EXPORT_ENABLED === 'true');
}

export function getExportOutputDir(): string {
    return path.resolve(process.env.EXPORT_OUTPUT_DIR || path.join(process.cwd(), 'output', 'exports'));
}

export function isSafeExportArtifactPath(candidatePath: string): boolean {
    const outputDir = getExportOutputDir();
    const resolvedCandidate = path.resolve(candidatePath);
    return resolvedCandidate === outputDir || resolvedCandidate.startsWith(`${outputDir}${path.sep}`);
}

export function getExportQueueDiagnostics(): ExportQueueDiagnostics {
    const configured = isExportQueueConfigured();
    return {
        configured,
        redisConfigured: Boolean(process.env.REDIS_URL),
        pdfExportEnabled: process.env.PDF_EXPORT_ENABLED === 'true',
        rendererImplemented: true,
        mode: configured ? 'queue_configured_renderer_ready' : 'disabled',
    };
}

export function getExportQueue(): Queue | null {
    if (!isExportQueueConfigured()) {
        return null;
    }

    if (!exportQueue) {
        const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
            maxRetriesPerRequest: null,
        });
        connection.on('error', (error) => {
            console.warn('[ExportQueue] Redis unavailable:', error.message);
        });
        exportQueue = new Queue('pdf-export', { connection });
    }

    return exportQueue;
}
