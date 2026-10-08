import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma as db } from '../shared/db/db';
import { ensureDefaultTeamForUser } from '../shared/auth/teamContext';
import { DEMO_EMAIL, DEMO_NAME, DEMO_PASSWORD } from '../../shared/demoAccount';
import { getDemoPrices } from './demoData';

// Used only when DEMO_MODE=1 (wired in server/index.ts). The demo account and sample portfolio are created once,
// on the first login request; the account signs in through the normal /api/auth/login (password stored as a bcrypt hash).
const DEMO_POSITIONS = [
    { ticker: 'AAPL', quantity: 120, averagePrice: 172.4 },
    { ticker: 'NVDA', quantity: 40, averagePrice: 640 },
    { ticker: 'MSFT', quantity: 60, averagePrice: 380 },
    { ticker: 'BTC', quantity: 0.8, averagePrice: 52000 },
    { ticker: 'GC=F', quantity: 10, averagePrice: 2150 },
];
const DEMO_CASH = 45000;

export async function ensureDemoWorkspace(): Promise<void> {
    const user = await db.user.upsert({
        where: { email: DEMO_EMAIL },
        create: { email: DEMO_EMAIL, password: await bcrypt.hash(DEMO_PASSWORD, 10), name: DEMO_NAME, role: 'ADMIN' },
        update: {},
    });
    const team = await ensureDefaultTeamForUser({ id: user.id, email: user.email, role: user.role });

    const existing = await db.portfolioState.findFirst({ where: { userId: user.id, teamId: team.teamId } });
    if (existing) return;

    const prices = new Map(getDemoPrices().map((tick) => [tick.symbol, tick.price]));
    const positions = DEMO_POSITIONS.map((position) => ({ ...position, currentPrice: prices.get(position.ticker) ?? position.averagePrice }));
    const marketValue = positions.reduce((total, position) => total + position.quantity * position.currentPrice, 0);
    await db.portfolioState.create({
        data: {
            userId: user.id,
            teamId: team.teamId,
            cashBalance: DEMO_CASH,
            totalBalance: DEMO_CASH + marketValue,
            currentVaR: 0,
            positions: { create: positions },
            transactions: {
                create: DEMO_POSITIONS.map((position) => ({
                    ticker: position.ticker,
                    type: 'BUY',
                    quantity: position.quantity,
                    price: position.averagePrice,
                    commission: 0,
                })),
            },
        },
    });
}

// Concurrent first logins (e.g. the React StrictMode double effect) share a single seeding run.
let seeding: Promise<void> | null = null;

export async function demoSeedMiddleware(_req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
        seeding ??= ensureDemoWorkspace().catch((error) => {
            seeding = null;
            throw error;
        });
        await seeding;
    } catch (error) {
        console.error('[Demo] Could not create the demo account:', error);
    }
    next();
}
