import { Router, Response } from 'express';
import { AuthRequest, requireAuth, requireRole, requireTeamContext } from '../middleware/authMiddleware';
import { buildDataQuality, buildProvenance, buildTelemetry } from '../shared/contracts/responseContracts';
import { getRuntimeMetrics } from '../shared/observability/runtimeMetrics';

const router = Router();

router.get('/metrics', requireAuth, requireTeamContext, requireRole('ADMIN'), (req: AuthRequest, res: Response) => {
    const metrics = getRuntimeMetrics();
    res.json({
        success: true,
        metrics,
        provenance: buildProvenance({ provider: 'AlphaPulse Runtime Metrics', mode: 'live', sourceType: 'system' }),
        dataQuality: buildDataQuality({ status: 'ready', observations: metrics.requests.total }),
        telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
    });
});

export default router;
