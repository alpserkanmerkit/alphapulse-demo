import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma as db } from '../shared/db/db';
import { AuthRequest, requireAuth, requireTeamContext } from '../middleware/authMiddleware';
import { calculatePortfolioRisk } from '../services/riskService';
import { isPriceHistoryRange, PriceHistoryRange } from '../services/priceService';
import { buildDataQuality, buildProvenance, buildTelemetry } from '../shared/contracts/responseContracts';
import { appendAuditEvent } from '../shared/audit/auditLog';

const router = Router();

const portfolioStateInclude = {
    positions: true,
    transactions: { orderBy: { timestamp: 'desc' as const }, take: 20 },
};

type PortfolioDbClient = typeof db | Prisma.TransactionClient;
type PortfolioWithPositions = Prisma.PortfolioStateGetPayload<{ include: { positions: true } }>;
type PortfolioWithTransactions = Prisma.PortfolioStateGetPayload<{ include: typeof portfolioStateInclude }>;

const tradeSchema = z.object({
    ticker: z.string().trim().min(1).max(12).regex(/^[A-Z0-9.-]+$/i).transform((ticker) => ticker.toUpperCase()),
    type: z.enum(['BUY', 'SELL']),
    quantity: z.number().positive(),
    price: z.number().positive(),
});

function marketValue(positions: Array<{ quantity: number; currentPrice: number }>) {
    return positions.reduce((total, position) => total + position.quantity * position.currentPrice, 0);
}

async function ensureAuthenticatedUser(userId: string) {
    return db.user.findUnique({ where: { id: userId }, select: { id: true } });
}

function isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function findPortfolioForTeam<TInclude extends Prisma.PortfolioStateInclude>(
    client: PortfolioDbClient,
    userId: string,
    teamId: string,
    include: TInclude
): Promise<Prisma.PortfolioStateGetPayload<{ include: TInclude }> | null> {
    const portfolio = await client.portfolioState.findFirst({
        where: { userId, teamId },
        include,
    });
    if (portfolio) return portfolio as Prisma.PortfolioStateGetPayload<{ include: TInclude }>;

    const legacyPortfolio = await client.portfolioState.findFirst({
        where: { userId, teamId: null },
        include,
    });
    if (!legacyPortfolio) return null;

    return await client.portfolioState.update({
        where: { id: legacyPortfolio.id },
        data: { teamId },
        include,
    }) as Prisma.PortfolioStateGetPayload<{ include: TInclude }>;
}

async function findAnyUserPortfolio<TInclude extends Prisma.PortfolioStateInclude>(
    client: PortfolioDbClient,
    userId: string,
    teamId: string,
    include: TInclude
): Promise<Prisma.PortfolioStateGetPayload<{ include: TInclude }> | null> {
    const portfolio = await client.portfolioState.findFirst({
        where: { userId },
        include,
    });
    if (!portfolio) return null;

    if (portfolio.teamId === teamId) {
        return portfolio as Prisma.PortfolioStateGetPayload<{ include: TInclude }>;
    }

    return await client.portfolioState.update({
        where: { id: portfolio.id },
        data: { teamId },
        include,
    }) as Prisma.PortfolioStateGetPayload<{ include: TInclude }>;
}

async function ensurePortfolioForTeam<TInclude extends Prisma.PortfolioStateInclude>(
    client: PortfolioDbClient,
    userId: string,
    teamId: string,
    include: TInclude
): Promise<Prisma.PortfolioStateGetPayload<{ include: TInclude }>> {
    const existingPortfolio = await findPortfolioForTeam(client, userId, teamId, include);
    if (existingPortfolio) return existingPortfolio;

    try {
        return await client.portfolioState.create({
            data: {
                userId,
                teamId,
                totalBalance: 100000,
                cashBalance: 100000,
                currentVaR: 0,
            },
            include,
        }) as Prisma.PortfolioStateGetPayload<{ include: TInclude }>;
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;

        const recoveredPortfolio = await findAnyUserPortfolio(client, userId, teamId, include);
        if (recoveredPortfolio) return recoveredPortfolio;

        throw error;
    }
}

router.get('/state', requireAuth, requireTeamContext, async (req: AuthRequest, res: Response) => {
    try {
        const user = await ensureAuthenticatedUser(req.user!.id);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Unauthorized: User no longer exists' });
        }
        const team = req.teamContext!;

        const portfolio = await ensurePortfolioForTeam(db, req.user!.id, team.teamId, portfolioStateInclude) as PortfolioWithTransactions;

        res.json({
            success: true,
            portfolio,
            provenance: buildProvenance({ provider: 'AlphaPulse Portfolio Store', mode: 'simulation', sourceType: 'portfolio' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: portfolio.positions.length + portfolio.transactions.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        console.error('[Portfolio] Get state error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch portfolio' });
    }
});

router.get('/risk', requireAuth, requireTeamContext, async (req: AuthRequest, res: Response) => {
    try {
        const user = await ensureAuthenticatedUser(req.user!.id);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Unauthorized: User no longer exists' });
        }
        const team = req.teamContext!;

        const rangeQuery = String(req.query.range ?? '24M').toUpperCase();
        if (!isPriceHistoryRange(rangeQuery)) {
            return res.status(400).json({ success: false, error: 'range must be one of 3M, 6M, 12M, 24M' });
        }

        const confidence = Number(req.query.confidence ?? 95);
        const horizonDays = Number(req.query.horizonDays ?? 1);
        if (![90, 95, 99].includes(confidence) || !Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 30) {
            return res.status(400).json({ success: false, error: 'Invalid risk parameters' });
        }

        const portfolio = await findPortfolioForTeam(db, req.user!.id, team.teamId, { positions: true }) as PortfolioWithPositions | null;

        if (!portfolio || portfolio.positions.length === 0) {
            return res.json({
                success: true,
                risk: {
                    range: rangeQuery,
                    confidence,
                    horizonDays,
                    generatedAt: new Date().toISOString(),
                    equity: portfolio?.cashBalance ?? 0,
                    marketValue: 0,
                    metrics: null,
                    concentration: [],
                    factorExposure: {},
                    scenarios: [],
                    correlationMatrix: [],
                    dataQuality: { observations: 0, missingSymbols: [], status: 'empty' },
                },
                provenance: buildProvenance({ provider: 'AlphaPulse Risk Service', mode: 'simulation', sourceType: 'portfolio' }),
                dataQuality: buildDataQuality({ status: 'empty', observations: 0 }),
                telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
            });
        }

        const risk = await calculatePortfolioRisk(portfolio.positions, portfolio.cashBalance, {
            range: rangeQuery as PriceHistoryRange,
            confidence,
            horizonDays,
        });
        res.json({
            success: true,
            risk,
            provenance: buildProvenance({
                provider: 'AlphaPulse Risk Service',
                mode: risk.dataQuality.status === 'ready' ? 'live' : 'fallback',
                sourceType: 'portfolio',
                degradationReason: risk.dataQuality.status === 'ready' ? null : 'limited_market_history',
            }),
            dataQuality: buildDataQuality({
                status: risk.dataQuality.status === 'ready' ? 'ready' : risk.dataQuality.status === 'empty' ? 'empty' : 'degraded',
                observations: risk.dataQuality.observations,
                missingSymbols: risk.dataQuality.missingSymbols,
            }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (error) {
        console.error('[Portfolio] Risk error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate portfolio risk' });
    }
});

router.post('/trade', requireAuth, requireTeamContext, async (req: AuthRequest, res: Response) => {
    const parsed = tradeSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Invalid trade parameters' });
    }

    const { ticker, type, quantity, price } = parsed.data;

    try {
        const user = await ensureAuthenticatedUser(req.user!.id);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Unauthorized: User no longer exists' });
        }
        const team = req.teamContext!;

        const result = await db.$transaction(async (tx) => {
            const portfolio = await ensurePortfolioForTeam(tx, req.user!.id, team.teamId, { positions: true }) as PortfolioWithPositions;

            const totalCost = quantity * price;
            const existingPosition = portfolio.positions.find((position) => position.ticker === ticker);
            const nextPositions = portfolio.positions.map((position) => ({ ...position }));
            let nextCashBalance = portfolio.cashBalance;

            if (type === 'BUY') {
                if (portfolio.cashBalance < totalCost) {
                    return { ok: false as const, status: 400, error: 'Insufficient funds' };
                }

                if (existingPosition) {
                    const newQuantity = existingPosition.quantity + quantity;
                    const newAvgPrice = ((existingPosition.quantity * existingPosition.averagePrice) + totalCost) / newQuantity;
                    await tx.position.update({
                        where: { id: existingPosition.id },
                        data: { quantity: newQuantity, averagePrice: newAvgPrice, currentPrice: price },
                    });

                    const index = nextPositions.findIndex((position) => position.id === existingPosition.id);
                    nextPositions[index] = { ...nextPositions[index], quantity: newQuantity, averagePrice: newAvgPrice, currentPrice: price };
                } else {
                    await tx.position.create({
                        data: { portfolioStateId: portfolio.id, ticker, quantity, averagePrice: price, currentPrice: price },
                    });
                    nextPositions.push({
                        id: 'new',
                        portfolioStateId: portfolio.id,
                        ticker,
                        quantity,
                        averagePrice: price,
                        currentPrice: price,
                        updatedAt: new Date(),
                    });
                }

                nextCashBalance = portfolio.cashBalance - totalCost;
            } else {
                if (!existingPosition || existingPosition.quantity + Number.EPSILON < quantity) {
                    return { ok: false as const, status: 400, error: 'Insufficient position quantity' };
                }

                const remainingQuantity = existingPosition.quantity - quantity;
                const index = nextPositions.findIndex((position) => position.id === existingPosition.id);
                if (remainingQuantity <= Number.EPSILON) {
                    await tx.position.delete({ where: { id: existingPosition.id } });
                    nextPositions.splice(index, 1);
                } else {
                    await tx.position.update({
                        where: { id: existingPosition.id },
                        data: { quantity: remainingQuantity, currentPrice: price },
                    });
                    nextPositions[index] = { ...nextPositions[index], quantity: remainingQuantity, currentPrice: price };
                }

                nextCashBalance = portfolio.cashBalance + totalCost;
            }

            await tx.transaction.create({
                data: { portfolioStateId: portfolio.id, ticker, type, quantity, price },
            });

            await tx.portfolioState.update({
                where: { id: portfolio.id },
                data: {
                    cashBalance: nextCashBalance,
                    totalBalance: nextCashBalance + marketValue(nextPositions),
                },
            });

            const updatedPortfolio = await tx.portfolioState.findUniqueOrThrow({
                where: { id: portfolio.id },
                include: { positions: true, transactions: { orderBy: { timestamp: 'desc' }, take: 20 } },
            });

            return { ok: true as const, portfolio: updatedPortfolio };
        });

        if (!result.ok) {
            return res.status(result.status).json({ success: false, error: result.error });
        }

        res.json({
            success: true,
            message: 'Paper trade recorded successfully',
            executionMode: 'paper',
            portfolio: result.portfolio,
            provenance: buildProvenance({ provider: 'AlphaPulse Paper Portfolio', mode: 'simulation', sourceType: 'portfolio' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: result.portfolio.positions.length + result.portfolio.transactions.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
        await appendAuditEvent({
            category: 'portfolio',
            action: 'Logged Paper Trade',
            actorId: req.user!.id,
            actorRole: req.user!.role,
            actorName: req.user!.email,
            teamId: team.teamId,
            subject: ticker,
            outcome: 'success',
            details: { type, quantity, price, executionMode: 'paper' },
        });
    } catch (error) {
        console.error('[Portfolio] Trade execution error:', error);
        res.status(500).json({ success: false, error: 'Trade failed' });
    }
});

export default router;
