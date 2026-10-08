import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AuditEntry,
    ComplianceAlert,
    ComplianceChangeRequestSummary,
    ComplianceDiagnosticReason,
    ComplianceDiagnostics,
    ComplianceServiceStatus,
    ComplianceSummaryResponse,
    RestrictedSecurity,
} from '../../types';
import { appendAuditEvent } from '../shared/audit/auditLog';
import { ensureInstitutionalTeam } from '../shared/auth/teamContext';
import { prisma as db } from '../shared/db/db';

const serviceDir = path.dirname(fileURLToPath(import.meta.url));

function getDatasetPath(): string {
    return process.env.COMPLIANCE_DATASET_PATH
        ? path.resolve(process.env.COMPLIANCE_DATASET_PATH)
        : path.resolve(serviceDir, '../data/compliance-snapshot.json');
}

function getMutableDatasetPath(): string {
    return process.env.COMPLIANCE_MUTABLE_DATASET_PATH
        ? path.resolve(process.env.COMPLIANCE_MUTABLE_DATASET_PATH)
        : path.resolve(serviceDir, '../data/compliance-local.json');
}

interface ComplianceDatasetFile {
    version: number;
    updatedAt: string;
    alerts: ComplianceAlert[];
    restricted: RestrictedSecurity[];
    audit: AuditEntry[];
}

interface ComplianceDatasetCache {
    mtimeMs: number;
    summary: ComplianceSummaryResponse;
    diagnostics: ComplianceDiagnostics;
}

interface ComplianceDatasetRecord {
    summary: ComplianceSummaryResponse;
    diagnostics: ComplianceDiagnostics;
}

export interface ComplianceActor {
    userId: string;
    userName: string;
    role: string;
    teamId?: string | null;
}

export interface ComplianceMutationResult {
    summary: ComplianceSummaryResponse;
    changeRequest?: ComplianceChangeRequestSummary;
}

const COMPLIANCE_GOVERNANCE_UNAVAILABLE = 'COMPLIANCE_GOVERNANCE_UNAVAILABLE';
const COMPLIANCE_DOMAIN_ERRORS = new Set([
    'INVALID_TICKER',
    'RESTRICTED_SECURITY_NOT_FOUND',
    'COMPLIANCE_ALERT_NOT_FOUND',
    'COMPLIANCE_CHANGE_REQUEST_NOT_FOUND',
    'COMPLIANCE_CHANGE_REQUEST_NOT_PENDING',
    'COMPLIANCE_SELF_APPROVAL_FORBIDDEN',
]);

let cache: ComplianceDatasetCache | null = null;

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function getReadableDatasetPath(): Promise<string> {
    const mutablePath = getMutableDatasetPath();
    return await fileExists(mutablePath) ? mutablePath : getDatasetPath();
}

function isComplianceDatasetFile(value: unknown): value is ComplianceDatasetFile {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof (value as ComplianceDatasetFile).version === 'number' &&
        typeof (value as ComplianceDatasetFile).updatedAt === 'string' &&
        Array.isArray((value as ComplianceDatasetFile).alerts) &&
        Array.isArray((value as ComplianceDatasetFile).restricted) &&
        Array.isArray((value as ComplianceDatasetFile).audit)
    );
}

function computeHash(payload: Pick<ComplianceDatasetFile, 'alerts' | 'restricted' | 'audit'>): string {
    return createHash('sha256')
        .update(JSON.stringify({ alerts: payload.alerts, restricted: payload.restricted, audit: payload.audit }))
        .digest('hex')
        .slice(0, 16);
}

function buildDiagnostics(
    status: ComplianceServiceStatus,
    reason: ComplianceDiagnosticReason | null,
    loadedAt: string | null
): ComplianceDiagnostics {
    return {
        source: status === 'unavailable' ? null : 'local-file',
        reason,
        loadedAt,
    };
}

function toDatasetRecord(payload: ComplianceDatasetFile): ComplianceDatasetRecord {
    const loadedAt = new Date().toISOString();

    return {
        summary: {
            version: payload.version,
            hash: computeHash(payload),
            updatedAt: payload.updatedAt,
            alerts: payload.alerts,
            restricted: payload.restricted,
            audit: payload.audit,
            pendingApprovals: [],
        },
        diagnostics: buildDiagnostics('ready', null, loadedAt),
    };
}

function classifyDatasetError(error: unknown): ComplianceDiagnosticReason {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return 'dataset_missing';
    }

    if (message.includes('no such table')) {
        return 'dataset_missing';
    }

    if (error instanceof SyntaxError || error instanceof TypeError) {
        return 'invalid_dataset';
    }

    if (error instanceof Error) {
        return 'read_error';
    }

    return 'unknown';
}

function isComplianceDomainError(error: unknown): boolean {
    return error instanceof Error && COMPLIANCE_DOMAIN_ERRORS.has(error.message);
}

function isGovernanceStoreUnavailable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes('no such table') ||
        message.includes('no such column') ||
        message.includes('P2021') ||
        message.includes('P2022') ||
        message.includes('SQLITE_ERROR')
    );
}

async function requireGovernanceStore<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (isComplianceDomainError(error)) throw error;
        if (isGovernanceStoreUnavailable(error)) {
            throw new Error(COMPLIANCE_GOVERNANCE_UNAVAILABLE);
        }
        throw error;
    }
}

async function loadComplianceDatasetRecord(): Promise<ComplianceDatasetRecord> {
    const datasetPath = await getReadableDatasetPath();
    const stats = await fs.stat(datasetPath);

    if (cache && cache.mtimeMs === stats.mtimeMs) {
        return { summary: cache.summary, diagnostics: cache.diagnostics };
    }

    const raw = await fs.readFile(datasetPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!isComplianceDatasetFile(parsed)) {
        throw new TypeError('Compliance dataset shape is invalid.');
    }

    const record = toDatasetRecord(parsed);
    cache = {
        mtimeMs: stats.mtimeMs,
        summary: record.summary,
        diagnostics: record.diagnostics,
    };

    return record;
}

async function readDatasetFile(): Promise<ComplianceDatasetFile> {
    const raw = await fs.readFile(await getReadableDatasetPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isComplianceDatasetFile(parsed)) {
        throw new TypeError('Compliance dataset shape is invalid.');
    }
    return parsed;
}

async function writeMutableDatasetFile(payload: ComplianceDatasetFile): Promise<ComplianceSummaryResponse> {
    const mutablePath = getMutableDatasetPath();
    await fs.mkdir(path.dirname(mutablePath), { recursive: true });
    await fs.writeFile(mutablePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    cache = null;
    return getFileComplianceSummary();
}

function buildAuditEntry(action: string, details: string, actor: ComplianceActor): AuditEntry {
    return {
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId: actor.userId,
        userName: actor.userName,
        action,
        category: 'SYSTEM',
        timestamp: Date.now(),
        details,
    };
}

async function getFileComplianceSummary(): Promise<ComplianceSummaryResponse> {
    const { summary } = await loadComplianceDatasetRecord();
    return summary;
}

function toDateFromMs(value: number | undefined): Date | null {
    return value ? new Date(value) : null;
}

function ms(value: Date | null | undefined): number | undefined {
    return value ? value.getTime() : undefined;
}

async function seedComplianceDbIfEmpty(teamId: string): Promise<void> {
    const [restrictedCount, alertCount] = await Promise.all([
        db.complianceRestrictedSecurity.count({ where: { teamId } }),
        db.complianceAlertRecord.count({ where: { teamId } }),
    ]);
    if (restrictedCount > 0 || alertCount > 0) return;

    const dataset = await readDatasetFile();
    await db.$transaction(async (tx) => {
        for (const security of dataset.restricted) {
            await tx.complianceRestrictedSecurity.upsert({
                where: { teamId_ticker: { teamId, ticker: security.ticker.toUpperCase() } },
                create: {
                    teamId,
                    ticker: security.ticker.toUpperCase(),
                    name: security.name,
                    reason: security.reason,
                    restrictedSince: new Date(security.restrictedSince),
                    restrictedUntil: toDateFromMs(security.restrictedUntil),
                    addedByName: security.addedBy,
                    active: true,
                },
                update: {
                    name: security.name,
                    reason: security.reason,
                    restrictedUntil: toDateFromMs(security.restrictedUntil),
                    active: true,
                },
            });
        }

        for (const alert of dataset.alerts) {
            const alertId = `${teamId}:${alert.id}`;
            await tx.complianceAlertRecord.upsert({
                where: { id: alertId },
                create: {
                    id: alertId,
                    teamId,
                    type: alert.type,
                    severity: alert.severity,
                    message: alert.message,
                    timestamp: new Date(alert.timestamp),
                    resolved: alert.resolved,
                },
                update: {
                    teamId,
                    type: alert.type,
                    severity: alert.severity,
                    message: alert.message,
                    timestamp: new Date(alert.timestamp),
                    resolved: alert.resolved,
                },
            });
        }

        for (const entry of dataset.audit) {
            const auditId = `${teamId}:${entry.id}`;
            await tx.auditEvent.upsert({
                where: { id: auditId },
                create: {
                    id: auditId,
                    timestamp: new Date(entry.timestamp),
                    category: 'compliance',
                    action: entry.action,
                    actorId: null,
                    actorRole: null,
                    actorName: entry.userName,
                    teamId,
                    subject: null,
                    outcome: 'success',
                    details: JSON.stringify({ details: entry.details, legacyCategory: entry.category }),
                },
                update: {
                    timestamp: new Date(entry.timestamp),
                    category: 'compliance',
                    action: entry.action,
                    actorId: null,
                    actorRole: null,
                    actorName: entry.userName,
                    teamId,
                    subject: null,
                    outcome: 'success',
                    details: JSON.stringify({ details: entry.details, legacyCategory: entry.category }),
                },
            });
        }
    });
}

function auditDetails(details: string | null): string {
    if (!details) return '';
    try {
        const parsed = JSON.parse(details) as { details?: string };
        return parsed.details ?? details;
    } catch {
        return details;
    }
}

function toChangeRequestSummary(change: {
    id: string;
    action: string;
    status: string;
    ticker: string;
    name: string | null;
    reason: string | null;
    restrictedUntil: Date | null;
    requestedById: string;
    requestedByName: string;
    requestedByRole: string;
    reviewedById: string | null;
    reviewedByName: string | null;
    reviewNote: string | null;
    createdAt: Date;
    reviewedAt: Date | null;
}): ComplianceChangeRequestSummary {
    return {
        id: change.id,
        action: change.action as ComplianceChangeRequestSummary['action'],
        status: change.status as ComplianceChangeRequestSummary['status'],
        ticker: change.ticker,
        name: change.name ?? undefined,
        reason: change.reason ?? undefined,
        restrictedUntil: ms(change.restrictedUntil),
        requestedById: change.requestedById,
        requestedByName: change.requestedByName,
        requestedByRole: change.requestedByRole,
        reviewedById: change.reviewedById,
        reviewedByName: change.reviewedByName,
        reviewNote: change.reviewNote,
        createdAt: change.createdAt.getTime(),
        reviewedAt: ms(change.reviewedAt) ?? null,
    };
}

async function buildDbSummary(teamId: string): Promise<ComplianceSummaryResponse> {
    await seedComplianceDbIfEmpty(teamId);
    const [restrictedRows, alertRows, auditRows, pendingRows] = await Promise.all([
        db.complianceRestrictedSecurity.findMany({ where: { teamId, active: true }, orderBy: { restrictedSince: 'desc' } }),
        db.complianceAlertRecord.findMany({ where: { teamId }, orderBy: { timestamp: 'desc' } }),
        db.auditEvent.findMany({ where: { teamId, category: 'compliance' }, orderBy: { timestamp: 'desc' }, take: 100 }),
        db.complianceChangeRequest.findMany({ where: { teamId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } }),
    ]);

    const restricted: RestrictedSecurity[] = restrictedRows.map((row) => ({
        ticker: row.ticker,
        name: row.name,
        reason: row.reason,
        restrictedSince: row.restrictedSince.getTime(),
        restrictedUntil: ms(row.restrictedUntil),
        addedBy: row.addedByName,
    }));
    const alerts: ComplianceAlert[] = alertRows.map((row) => ({
        id: row.id,
        type: row.type as ComplianceAlert['type'],
        severity: row.severity as ComplianceAlert['severity'],
        message: row.message,
        timestamp: row.timestamp.getTime(),
        resolved: row.resolved,
    }));
    const audit: AuditEntry[] = auditRows.map((row) => ({
        id: row.id,
        userId: row.actorId ?? 'system',
        userName: row.actorName ?? 'system',
        action: row.action,
        category: 'SYSTEM',
        timestamp: row.timestamp.getTime(),
        details: auditDetails(row.details),
    }));
    const updatedAt = new Date(Math.max(
        Date.now(),
        ...restrictedRows.map((row) => row.updatedAt.getTime()),
        ...alertRows.map((row) => row.updatedAt.getTime()),
        ...pendingRows.map((row) => row.createdAt.getTime())
    )).toISOString();

    return {
        version: 2,
        hash: computeHash({ alerts, restricted, audit }),
        updatedAt,
        alerts,
        restricted,
        audit,
        pendingApprovals: pendingRows.map(toChangeRequestSummary),
    };
}

async function recordComplianceAudit(action: string, subject: string, details: string, actor: ComplianceActor, outcome: 'success' | 'failure' | 'blocked' = 'success'): Promise<void> {
    await appendAuditEvent({
        category: 'compliance',
        action,
        actorId: actor.userId,
        actorRole: actor.role,
        actorName: actor.userName,
        teamId: actor.teamId ?? null,
        subject,
        outcome,
        details: { details },
    });
}

async function getComplianceTeamId(actor?: ComplianceActor): Promise<string> {
    if (actor?.teamId) return actor.teamId;
    const team = await ensureInstitutionalTeam();
    return team.id;
}

async function getDbComplianceSummary(actor?: ComplianceActor): Promise<ComplianceSummaryResponse> {
    const teamId = await getComplianceTeamId(actor);
    return buildDbSummary(teamId);
}

export async function getComplianceSummary(actor?: ComplianceActor): Promise<ComplianceSummaryResponse> {
    try {
        return await getDbComplianceSummary(actor);
    } catch (error) {
        console.warn('[Compliance] DB summary unavailable; falling back to local dataset:', error instanceof Error ? error.message : error);
        return getFileComplianceSummary();
    }
}

export async function resolveComplianceAlert(alertId: string, actor: ComplianceActor): Promise<ComplianceSummaryResponse> {
    try {
        const teamId = await getComplianceTeamId(actor);
        const alert = await db.complianceAlertRecord.findFirst({ where: { id: alertId, teamId } });
        if (!alert) throw new Error('COMPLIANCE_ALERT_NOT_FOUND');
        await db.$transaction(async (tx) => {
            await tx.complianceAlertRecord.update({
                where: { id: alertId },
                data: { resolved: true },
            });
            await tx.auditEvent.create({
                data: {
                    category: 'compliance',
                    action: 'Resolved Compliance Alert',
                    actorId: actor.userId,
                    actorRole: actor.role,
                    actorName: actor.userName,
                    teamId,
                    subject: alertId,
                    outcome: 'success',
                    details: JSON.stringify({ details: `Alert ${alertId} marked resolved: ${alert.message}` }),
                },
            });
        });
        return buildDbSummary(teamId);
    } catch (error) {
        if (error instanceof Error && error.message === 'COMPLIANCE_ALERT_NOT_FOUND') throw error;
        return resolveComplianceAlertFile(alertId, actor);
    }
}

async function resolveComplianceAlertFile(alertId: string, actor: ComplianceActor): Promise<ComplianceSummaryResponse> {
    const dataset = await readDatasetFile();
    const alert = dataset.alerts.find((item) => item.id === alertId);
    if (!alert) {
        throw new Error('COMPLIANCE_ALERT_NOT_FOUND');
    }

    alert.resolved = true;
    dataset.version += 1;
    dataset.updatedAt = new Date().toISOString();
    dataset.audit = [
        buildAuditEntry('Resolved Compliance Alert', `Alert ${alertId} marked resolved: ${alert.message}`, actor),
        ...dataset.audit,
    ];
    const summary = await writeMutableDatasetFile(dataset);
    await recordComplianceAudit('Resolved Compliance Alert', alertId, `Alert ${alertId} marked resolved: ${alert.message}`, actor);
    return summary;
}

export async function addRestrictedSecurity(
    security: Omit<RestrictedSecurity, 'restrictedSince' | 'addedBy'>,
    actor: ComplianceActor
): Promise<ComplianceMutationResult> {
    return requireGovernanceStore(async () => {
        const teamId = await getComplianceTeamId(actor);
        const ticker = security.ticker.trim().toUpperCase();
        if (!ticker) throw new Error('INVALID_TICKER');

        const changeRequest = await db.complianceChangeRequest.create({
            data: {
                teamId,
                action: 'ADD_RESTRICTED',
                ticker,
                name: security.name,
                reason: security.reason,
                restrictedUntil: toDateFromMs(security.restrictedUntil),
                requestedById: actor.userId,
                requestedByName: actor.userName,
                requestedByRole: actor.role,
            },
        });
        await recordComplianceAudit('Requested Restricted Security Add', ticker, `${ticker} add requested: ${security.reason}`, { ...actor, teamId });

        return {
            summary: await buildDbSummary(teamId),
            changeRequest: toChangeRequestSummary(changeRequest),
        };
    });
}

export async function removeRestrictedSecurity(tickerInput: string, actor: ComplianceActor): Promise<ComplianceMutationResult> {
    return requireGovernanceStore(async () => {
        const teamId = await getComplianceTeamId(actor);
        const ticker = tickerInput.trim().toUpperCase();
        const existing = await db.complianceRestrictedSecurity.findUnique({
            where: { teamId_ticker: { teamId, ticker } },
        });
        if (!existing || !existing.active) throw new Error('RESTRICTED_SECURITY_NOT_FOUND');

        const changeRequest = await db.complianceChangeRequest.create({
            data: {
                teamId,
                action: 'REMOVE_RESTRICTED',
                ticker,
                name: existing.name,
                reason: existing.reason,
                requestedById: actor.userId,
                requestedByName: actor.userName,
                requestedByRole: actor.role,
            },
        });
        await recordComplianceAudit('Requested Restricted Security Remove', ticker, `${ticker} removal requested.`, { ...actor, teamId });

        return {
            summary: await buildDbSummary(teamId),
            changeRequest: toChangeRequestSummary(changeRequest),
        };
    });
}

export async function approveComplianceChangeRequest(changeRequestId: string, actor: ComplianceActor): Promise<ComplianceMutationResult> {
    return requireGovernanceStore(async () => {
        const teamId = await getComplianceTeamId(actor);
        const reviewedAt = new Date();
        const result = await db.$transaction(async (tx) => {
            const change = await tx.complianceChangeRequest.findFirst({ where: { id: changeRequestId, teamId } });
            if (!change) throw new Error('COMPLIANCE_CHANGE_REQUEST_NOT_FOUND');
            if (change.status !== 'PENDING') throw new Error('COMPLIANCE_CHANGE_REQUEST_NOT_PENDING');
            if (change.requestedById === actor.userId) throw new Error('COMPLIANCE_SELF_APPROVAL_FORBIDDEN');

            if (change.action === 'ADD_RESTRICTED') {
                await tx.complianceRestrictedSecurity.upsert({
                    where: { teamId_ticker: { teamId, ticker: change.ticker } },
                    create: {
                        teamId,
                        ticker: change.ticker,
                        name: change.name ?? change.ticker,
                        reason: change.reason ?? 'Approved restricted-list request',
                        restrictedUntil: change.restrictedUntil,
                        addedById: change.requestedById,
                        addedByName: change.requestedByName,
                        active: true,
                    },
                    update: {
                        name: change.name ?? change.ticker,
                        reason: change.reason ?? 'Approved restricted-list request',
                        restrictedUntil: change.restrictedUntil,
                        addedById: change.requestedById,
                        addedByName: change.requestedByName,
                        active: true,
                    },
                });
            } else {
                await tx.complianceRestrictedSecurity.update({
                    where: { teamId_ticker: { teamId, ticker: change.ticker } },
                    data: { active: false },
                });
            }

            const updated = await tx.complianceChangeRequest.update({
                where: { id: change.id },
                data: {
                    status: 'APPROVED',
                    reviewedById: actor.userId,
                    reviewedByName: actor.userName,
                    reviewedAt,
                },
            });
            await tx.auditEvent.create({
                data: {
                    category: 'compliance',
                    action: 'Approved Compliance Change Request',
                    actorId: actor.userId,
                    actorRole: actor.role,
                    actorName: actor.userName,
                    teamId,
                    subject: change.ticker,
                    outcome: 'success',
                    details: JSON.stringify({ details: `${change.action} approved for ${change.ticker}`, changeRequestId: change.id }),
                },
            });
            return updated;
        });

        return {
            summary: await buildDbSummary(teamId),
            changeRequest: toChangeRequestSummary(result),
        };
    });
}

export async function rejectComplianceChangeRequest(changeRequestId: string, actor: ComplianceActor, reviewNote?: string): Promise<ComplianceMutationResult> {
    return requireGovernanceStore(async () => {
        const teamId = await getComplianceTeamId(actor);
        const reviewedAt = new Date();
        const result = await db.$transaction(async (tx) => {
            const change = await tx.complianceChangeRequest.findFirst({ where: { id: changeRequestId, teamId } });
            if (!change) throw new Error('COMPLIANCE_CHANGE_REQUEST_NOT_FOUND');
            if (change.status !== 'PENDING') throw new Error('COMPLIANCE_CHANGE_REQUEST_NOT_PENDING');
            if (change.requestedById === actor.userId) throw new Error('COMPLIANCE_SELF_APPROVAL_FORBIDDEN');

            const updated = await tx.complianceChangeRequest.update({
                where: { id: change.id },
                data: {
                    status: 'REJECTED',
                    reviewedById: actor.userId,
                    reviewedByName: actor.userName,
                    reviewNote: reviewNote ?? null,
                    reviewedAt,
                },
            });
            await tx.auditEvent.create({
                data: {
                    category: 'compliance',
                    action: 'Rejected Compliance Change Request',
                    actorId: actor.userId,
                    actorRole: actor.role,
                    actorName: actor.userName,
                    teamId,
                    subject: change.ticker,
                    outcome: 'blocked',
                    details: JSON.stringify({ details: `${change.action} rejected for ${change.ticker}`, changeRequestId: change.id, reviewNote }),
                },
            });
            return updated;
        });

        return {
            summary: await buildDbSummary(teamId),
            changeRequest: toChangeRequestSummary(result),
        };
    });
}

export async function checkRestrictedTicker(tickerInput: string, actor?: ComplianceActor) {
    const ticker = tickerInput.trim().toUpperCase();
    const summary = await getComplianceSummary(actor);
    const match = summary.restricted.find((item) => item.ticker.toUpperCase() === ticker) ?? null;
    return {
        ticker,
        restricted: Boolean(match),
        security: match,
    };
}

export async function getRestrictedTickersSet(actor?: ComplianceActor): Promise<Set<string>> {
    const summary = await getComplianceSummary(actor);
    return new Set(summary.restricted.map((item) => item.ticker.toUpperCase()));
}

export async function getComplianceHealth(): Promise<ComplianceDiagnostics & { status: ComplianceServiceStatus }> {
    try {
        await getComplianceSummary();
        return {
            status: 'ready',
            ...buildDiagnostics('ready', null, new Date().toISOString()),
        };
    } catch (error) {
        const reason = classifyDatasetError(error);
        return {
            status: 'unavailable',
            ...buildDiagnostics('unavailable', reason, null),
        };
    }
}
