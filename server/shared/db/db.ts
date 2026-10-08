import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const adapter = new PrismaLibSql({
    url: process.env.DATABASE_URL || 'file:./prisma/dev.db',
});

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
    });

if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
    globalForPrisma.prisma = prisma;
}

export default prisma;
