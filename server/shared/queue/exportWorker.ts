import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendAuditEvent } from '../audit/auditLog';
import { recordExportJob } from '../observability/runtimeMetrics';
import { getExportOutputDir, isExportQueueConfigured, isSafeExportArtifactPath } from './exportQueue';

let started = false;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function renderReportPdf(jobId: string | number | undefined, reportData: unknown) {
    const { chromium } = await import('@playwright/test');
    const outputDir = getExportOutputDir();
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `alphapulse-report-${String(jobId ?? Date.now()).replace(/[^a-zA-Z0-9_-]/g, '')}.pdf`;
    const outputPath = path.join(outputDir, fileName);
    const resolvedOutput = path.resolve(outputPath);
    if (!isSafeExportArtifactPath(resolvedOutput)) {
        throw new Error('Resolved export path escaped the configured output directory.');
    }

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const generatedAt = new Date().toISOString();
        await page.setContent(`
            <!doctype html>
            <html>
              <head>
                <meta charset="utf-8" />
                <title>AlphaPulse Export</title>
                <style>
                  body { font-family: Arial, sans-serif; color: #111827; padding: 32px; }
                  h1 { font-size: 22px; margin: 0 0 8px; }
                  .meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
                  pre { white-space: pre-wrap; word-break: break-word; background: #f3f4f6; padding: 16px; border: 1px solid #d1d5db; }
                </style>
              </head>
              <body>
                <h1>AlphaPulse Decision-Support Export</h1>
                <div class="meta">Generated ${escapeHtml(generatedAt)}. Paper/simulation and provider labels remain decision-support metadata.</div>
                <pre>${escapeHtml(JSON.stringify(reportData ?? {}, null, 2))}</pre>
              </body>
            </html>
        `, { waitUntil: 'load' });
        await page.pdf({ path: resolvedOutput, format: 'A4', printBackground: true });
    } finally {
        await browser.close();
    }

    const stat = await fs.stat(resolvedOutput);
    return { fileName, path: resolvedOutput, bytes: stat.size, completedAt: new Date().toISOString() };
}

export function startExportWorker() {
    if (started || !isExportQueueConfigured()) {
        return null;
    }

    started = true;
    const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
    });

    const worker = new Worker(
        'pdf-export',
        async (job) => {
            console.log(`[ExportWorker] Processing PDF export job ${job.id} for user ${job.data.userId}`);
            try {
                const result = await renderReportPdf(job.id, job.data.reportData);
                recordExportJob('completed');
                await appendAuditEvent({
                    category: 'export',
                    action: 'PDF Export Completed',
                    actorId: job.data.userId ?? null,
                    actorRole: job.data.actorRole ?? null,
                    actorName: job.data.actorName ?? null,
                    teamId: job.data.teamId ?? null,
                    subject: String(job.id ?? ''),
                    outcome: 'success',
                    details: result,
                });
                return result;
            } catch (error) {
                recordExportJob('failed');
                await appendAuditEvent({
                    category: 'export',
                    action: 'PDF Export Failed',
                    actorId: job.data.userId ?? null,
                    actorRole: job.data.actorRole ?? null,
                    actorName: job.data.actorName ?? null,
                    teamId: job.data.teamId ?? null,
                    subject: String(job.id ?? ''),
                    outcome: 'failure',
                    details: { reason: error instanceof Error ? error.message : 'export_failed' },
                });
                throw error;
            }
        },
        { connection }
    );

    worker.on('completed', (job) => console.log(`[ExportWorker] Job ${job.id} completed`));
    worker.on('failed', (job, error) => console.error(`[ExportWorker] Job ${job?.id} failed:`, error));

    return worker;
}
