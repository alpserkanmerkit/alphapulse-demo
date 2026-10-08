import { Router, Response } from 'express';
import { AuthRequest, requireAuth, requireTeamContext } from '../middleware/authMiddleware';
import { access } from 'node:fs/promises';
import { getExportQueue, isSafeExportArtifactPath } from '../shared/queue/exportQueue';
import { appendAuditEvent } from '../shared/audit/auditLog';
import { recordExportJob } from '../shared/observability/runtimeMetrics';

const router = Router();

interface ExportJobResult {
    fileName?: string;
    path?: string;
    bytes?: number;
    completedAt?: string;
}

function currentActorRole(req: AuthRequest) {
    return req.teamContext?.role ?? req.user!.teamRole ?? req.user!.role;
}

async function getAuthorizedExportJob(req: AuthRequest, res: Response) {
    const queue = getExportQueue();
    if (!queue) {
        res.status(503).json({ success: false, error: 'PDF export is disabled.', reason: 'pdf_export_disabled' });
        return null;
    }

    const job = await queue.getJob(String(req.params.jobId));
    if (!job) {
        res.status(404).json({ success: false, error: 'Job not found' });
        return null;
    }

    const isOwner = job.data?.userId === req.user!.id;
    const isAdminForJobTeam = currentActorRole(req) === 'ADMIN'
        && Boolean(req.teamContext?.teamId)
        && job.data?.teamId === req.teamContext?.teamId;
    if (!isOwner && !isAdminForJobTeam) {
        res.status(403).json({ success: false, error: 'Forbidden: Export job owner or admin required' });
        return null;
    }

    return job;
}

function publicExportArtifact(jobId: string | number | undefined, result: ExportJobResult | null | undefined) {
    if (!result?.fileName || !result.path || !isSafeExportArtifactPath(result.path)) {
        return null;
    }

    return {
        fileName: result.fileName,
        bytes: result.bytes ?? null,
        completedAt: result.completedAt ?? null,
        retained: true,
        downloadUrl: `/api/export/download/${jobId}`,
    };
}

router.post('/generate-pdf', requireAuth, requireTeamContext, async (req: AuthRequest, res: Response) => {
    const queue = getExportQueue();
    if (!queue) {
        recordExportJob('blocked');
        await appendAuditEvent({
            category: 'export',
            action: 'PDF Export Requested',
            actorId: req.user!.id,
            actorRole: req.user!.role,
            actorName: req.user!.email,
            teamId: req.teamContext?.teamId ?? null,
            subject: null,
            outcome: 'blocked',
            details: { reason: 'pdf_export_disabled', requestId: req.requestId ?? null },
        });
        return res.status(503).json({
            success: false,
            error: 'PDF export is disabled. Configure REDIS_URL and PDF_EXPORT_ENABLED=true before enabling export jobs.',
            reason: 'pdf_export_disabled',
        });
    }

    try {
        const job = await queue.add('generate-pdf', {
            userId: req.user!.id,
            actorRole: currentActorRole(req),
            actorName: req.user!.email,
            teamId: req.teamContext?.teamId ?? null,
            reportData: req.body.reportData,
        });
        recordExportJob('requested');
        await appendAuditEvent({
            category: 'export',
            action: 'PDF Export Requested',
            actorId: req.user!.id,
            actorRole: currentActorRole(req),
            actorName: req.user!.email,
            teamId: req.teamContext?.teamId ?? null,
            subject: String(job.id ?? ''),
            outcome: 'success',
            details: { requestId: req.requestId ?? null },
        });
        res.json({ success: true, jobId: job.id, message: 'PDF export job started asynchronously.' });
    } catch (error) {
        console.error('[Export] Queue error:', error);
        res.status(500).json({ success: false, error: 'Failed to start export job' });
    }
});

router.get('/status/:jobId', requireAuth, requireTeamContext, async (req: AuthRequest, res: Response) => {
    try {
        const job = await getAuthorizedExportJob(req, res);
        if (!job) return;

        const state = await job.getState();
        const artifact = state === 'completed'
            ? publicExportArtifact(job.id, job.returnvalue as ExportJobResult | null)
            : null;
        res.json({
            success: true,
            jobId: job.id,
            state,
            artifact,
            result: artifact,
            failedReason: job.failedReason,
        });
    } catch (error) {
        console.error('[Export] Status error:', error);
        res.status(500).json({ success: false, error: 'Failed to get job status' });
    }
});

router.get('/download/:jobId', requireAuth, requireTeamContext, async (req: AuthRequest, res: Response) => {
    try {
        const job = await getAuthorizedExportJob(req, res);
        if (!job) return;

        const state = await job.getState();
        if (state !== 'completed') {
            return res.status(409).json({ success: false, error: 'PDF export is not complete yet' });
        }

        const result = job.returnvalue as ExportJobResult | null;
        const artifact = publicExportArtifact(job.id, result);
        if (!artifact || !result?.path) {
            return res.status(404).json({ success: false, error: 'Export artifact is not retained or is outside the configured export directory' });
        }

        await access(result.path);
        res.download(result.path, artifact.fileName);
    } catch (error) {
        console.error('[Export] Download error:', error);
        res.status(500).json({ success: false, error: 'Failed to download export artifact' });
    }
});

export default router;
