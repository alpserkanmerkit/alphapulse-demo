import cron from 'node-cron';
import { prisma } from '../shared/db/db';

const isDryRun = process.argv.includes('--dry-run');

export const gcTier1 = async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    if (isDryRun) {
        const count = await prisma.newsArchive.count({
            where: { score: { lt: 30 }, timestamp: { lt: threeDaysAgo } },
        });
        console.log(`[GC Dry-Run] Tier 1 would delete ${count} low-score news items older than 3 days.`);
        return;
    }

    const result = await prisma.newsArchive.deleteMany({
        where: { score: { lt: 30 }, timestamp: { lt: threeDaysAgo } },
    });
    console.log(`[GC] Tier 1 completed. Deleted ${result.count} low-score news items.`);
};

export const gcTier2 = async () => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    if (isDryRun) {
        const newsCount = await prisma.newsArchive.count({ where: { timestamp: { lt: thirtyDaysAgo } } });
        const debateCount = await prisma.debateHistory.count({ where: { createdAt: { lt: thirtyDaysAgo } } });
        console.log(`[GC Dry-Run] Tier 2 would delete ${newsCount} news items and ${debateCount} debates older than 30 days.`);
        return;
    }

    const debateResult = await prisma.debateHistory.deleteMany({ where: { createdAt: { lt: thirtyDaysAgo } } });
    const newsResult = await prisma.newsArchive.deleteMany({ where: { timestamp: { lt: thirtyDaysAgo } } });
    console.log(`[GC] Tier 2 completed. Deleted ${newsResult.count} news items and ${debateResult.count} debates.`);
};

export const startGarbageCollection = () => {
    if (process.env.ENABLE_DB_GC !== 'true' && !isDryRun) {
        console.log('[GC] Disabled. Set ENABLE_DB_GC=true to enable scheduled cleanup.');
        return;
    }

    if (isDryRun) {
        void gcTier1();
        void gcTier2();
    }

    cron.schedule('0 0 * * *', () => void gcTier1(), { timezone: 'UTC' });
    cron.schedule('0 2 * * 0', () => void gcTier2(), { timezone: 'UTC' });
    console.log('[GC] Garbage collection jobs scheduled.');
};
