import { Router, Response } from 'express';
import { z } from 'zod';
import { addRestrictedSecurity, approveComplianceChangeRequest, checkRestrictedTicker, getComplianceSummary, rejectComplianceChangeRequest, removeRestrictedSecurity, resolveComplianceAlert } from '../services/complianceRepository';
import type { ComplianceActor } from '../services/complianceRepository';
import { AuthRequest, requireAuth, requireRole, requireTeamContext } from '../middleware/authMiddleware';
import { buildDataQuality, buildProvenance, buildTelemetry } from '../shared/contracts/responseContracts';

const router = Router();
const requireComplianceRead = [requireAuth, requireTeamContext];
const requireComplianceWrite = [requireAuth, requireTeamContext, requireRole('ADMIN', 'COMPLIANCE_OFFICER')];
const restrictedSchema = z.object({
    ticker: z.string().trim().min(1).max(12).regex(/^[A-Z0-9.-]+$/i),
    name: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(240),
    restrictedUntil: z.number().optional(),
});

const checkSchema = z.object({
    ticker: z.string().trim().min(1).max(12).regex(/^[A-Z0-9.-]+$/i),
});
const approvalSchema = z.object({
    note: z.string().trim().max(240).optional(),
});

function sendGovernanceUnavailable(res: Response) {
    return res.status(503).json({
        success: false,
        error: 'COMPLIANCE_GOVERNANCE_UNAVAILABLE',
        reason: 'migration_required',
        notice: 'Compliance governance ledger is unavailable. Apply database migrations before compliance writes.',
    });
}

function actor(req: AuthRequest): ComplianceActor {
    return {
        userId: req.user?.id ?? 'local-user',
        userName: req.user?.email ?? req.user?.id ?? 'local-user',
        role: req.teamContext?.role ?? req.user?.teamRole ?? req.user?.role ?? 'ANALYST',
        teamId: req.teamContext?.teamId ?? req.user?.teamId ?? null,
    };
}

router.get('/summary', requireComplianceRead, async (_req: AuthRequest, res: Response) => {
    try {
        const summary = await getComplianceSummary(actor(_req));
        res.json({
            ...summary,
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: summary.restricted.length + summary.alerts.length + summary.audit.length }),
            telemetry: buildTelemetry({ requestId: _req.requestId ?? null }),
        });
    } catch (error) {
        console.error('[Compliance] Summary unavailable:', error);
        res.status(503).json({
            success: false,
            error: 'COMPLIANCE_DATA_UNAVAILABLE',
            reason: 'compliance_unavailable',
            notice: 'Compliance dataset is temporarily unavailable.',
        });
    }
});

router.post('/alerts/:id/resolve', requireComplianceWrite, async (req: AuthRequest, res: Response) => {
    try {
        const summary = await resolveComplianceAlert(String(req.params.id), actor(req));
        res.json({
            success: true,
            summary,
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: summary.restricted.length + summary.alerts.length + summary.audit.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'COMPLIANCE_ALERT_NOT_FOUND') {
            return res.status(404).json({ success: false, error: 'Compliance alert not found' });
        }
        console.error('[Compliance] Resolve alert failed:', error);
        res.status(500).json({ success: false, error: 'Failed to resolve compliance alert' });
    }
});

router.post('/restricted', requireComplianceWrite, async (req: AuthRequest, res: Response) => {
    const parsed = restrictedSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Invalid restricted security parameters' });
    }

    try {
        const result = await addRestrictedSecurity(parsed.data, actor(req));
        res.status(202).json({
            success: true,
            status: 'pending_approval',
            summary: result.summary,
            changeRequest: result.changeRequest,
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: result.summary.restricted.length + result.summary.alerts.length + result.summary.audit.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'COMPLIANCE_GOVERNANCE_UNAVAILABLE') {
            return sendGovernanceUnavailable(res);
        }
        console.error('[Compliance] Add restricted failed:', error);
        res.status(500).json({ success: false, error: 'Failed to add restricted security' });
    }
});

router.delete('/restricted/:ticker', requireComplianceWrite, async (req: AuthRequest, res: Response) => {
    try {
        const result = await removeRestrictedSecurity(String(req.params.ticker), actor(req));
        res.status(202).json({
            success: true,
            status: 'pending_approval',
            summary: result.summary,
            changeRequest: result.changeRequest,
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: result.summary.restricted.length + result.summary.alerts.length + result.summary.audit.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'RESTRICTED_SECURITY_NOT_FOUND') {
            return res.status(404).json({ success: false, error: 'Restricted security not found' });
        }
        if (error instanceof Error && error.message === 'COMPLIANCE_GOVERNANCE_UNAVAILABLE') {
            return sendGovernanceUnavailable(res);
        }
        console.error('[Compliance] Remove restricted failed:', error);
        res.status(500).json({ success: false, error: 'Failed to remove restricted security' });
    }
});

router.post('/approvals/:id/approve', requireComplianceWrite, async (req: AuthRequest, res: Response) => {
    try {
        const result = await approveComplianceChangeRequest(String(req.params.id), actor(req));
        res.json({
            success: true,
            status: 'approved',
            summary: result.summary,
            changeRequest: result.changeRequest,
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: result.summary.restricted.length + result.summary.alerts.length + result.summary.audit.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'COMPLIANCE_SELF_APPROVAL_FORBIDDEN') {
            return res.status(403).json({ success: false, error: 'Self approval is not allowed for compliance changes' });
        }
        if (error instanceof Error && error.message === 'COMPLIANCE_CHANGE_REQUEST_NOT_FOUND') {
            return res.status(404).json({ success: false, error: 'Compliance change request not found' });
        }
        if (error instanceof Error && error.message === 'COMPLIANCE_CHANGE_REQUEST_NOT_PENDING') {
            return res.status(409).json({ success: false, error: 'Compliance change request is not pending' });
        }
        if (error instanceof Error && error.message === 'COMPLIANCE_GOVERNANCE_UNAVAILABLE') {
            return sendGovernanceUnavailable(res);
        }
        console.error('[Compliance] Approve change request failed:', error);
        res.status(500).json({ success: false, error: 'Failed to approve compliance change request' });
    }
});

router.post('/approvals/:id/reject', requireComplianceWrite, async (req: AuthRequest, res: Response) => {
    const parsed = approvalSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Invalid approval parameters' });
    }

    try {
        const result = await rejectComplianceChangeRequest(String(req.params.id), actor(req), parsed.data.note);
        res.json({
            success: true,
            status: 'rejected',
            summary: result.summary,
            changeRequest: result.changeRequest,
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: result.summary.restricted.length + result.summary.alerts.length + result.summary.audit.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'COMPLIANCE_SELF_APPROVAL_FORBIDDEN') {
            return res.status(403).json({ success: false, error: 'Self approval is not allowed for compliance changes' });
        }
        if (error instanceof Error && error.message === 'COMPLIANCE_CHANGE_REQUEST_NOT_FOUND') {
            return res.status(404).json({ success: false, error: 'Compliance change request not found' });
        }
        if (error instanceof Error && error.message === 'COMPLIANCE_CHANGE_REQUEST_NOT_PENDING') {
            return res.status(409).json({ success: false, error: 'Compliance change request is not pending' });
        }
        if (error instanceof Error && error.message === 'COMPLIANCE_GOVERNANCE_UNAVAILABLE') {
            return sendGovernanceUnavailable(res);
        }
        console.error('[Compliance] Reject change request failed:', error);
        res.status(500).json({ success: false, error: 'Failed to reject compliance change request' });
    }
});

router.post('/check', requireAuth, requireTeamContext, async (req: AuthRequest, res: Response) => {
    const parsed = checkSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Invalid ticker' });
    }

    try {
        const result = await checkRestrictedTicker(parsed.data.ticker, actor(req));
        res.json({
            success: true,
            result,
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: 1 }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        console.error('[Compliance] Ticker check failed:', error);
        res.status(500).json({ success: false, error: 'Failed to check ticker' });
    }
});

export default router;
