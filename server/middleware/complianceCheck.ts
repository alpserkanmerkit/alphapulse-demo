import { Request, Response, NextFunction } from 'express';
import { getRestrictedTickersSet } from '../services/complianceRepository';
import { buildDataQuality, buildProvenance, buildTelemetry } from '../shared/contracts/responseContracts';
import { findRestrictedMatches } from '../shared/providers/providerPolicy';
import { recordComplianceBlock } from '../shared/observability/runtimeMetrics';
import type { AuthRequest } from './authMiddleware';

type ComplianceInput = { headline: string; tickers: string[] };

/** Malformed screening fields (wrong type) are a client error (400), never a dataset failure (503). */
class ComplianceInputError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function readTickerList(body: Record<string, unknown>, field: string): string[] {
    const value = body[field];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new ComplianceInputError(`${field} must be an array of strings.`);
    }
    return value as string[];
}

function readText(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new ComplianceInputError(`${field} must be a string.`);
    }
    return value;
}

// Chat history: the web client sends `content`, the advisory service reads `text`; screen both
// (plus `parts[].text` style payloads) for every message so no history entry slips past.
function collectMessageTexts(messages: unknown): string[] {
    if (!Array.isArray(messages)) return [];
    const texts: string[] = [];
    const take = (value: unknown) => {
        if (typeof value === 'string') {
            texts.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(take);
        } else if (isRecord(value)) {
            take(value.text);
        }
    };
    for (const message of messages) {
        if (typeof message === 'string') texts.push(message);
        else if (isRecord(message)) {
            take(message.content);
            take(message.text);
            take(message.parts);
        }
    }
    return texts;
}

/**
 * Everything on the request body that can name a security: free text (headline, chat messages) and
 * explicit ticker fields (tickers, affectedAssets, and the single ticker/symbol used by
 * agent-analysis and quant). Single tickers are also screened as text so name aliases match.
 */
function extractComplianceInput(rawBody: unknown): ComplianceInput {
    const body = isRecord(rawBody) ? rawBody : {};
    const singleTickers = [readText(body, 'ticker'), readText(body, 'symbol')].filter(Boolean);
    const tickers = [...readTickerList(body, 'tickers'), ...readTickerList(body, 'affectedAssets'), ...singleTickers];
    const headline = [readText(body, 'headline'), ...collectMessageTexts(body.messages), ...singleTickers].join('\n');
    return { headline, tickers };
}

export const complianceMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    let input: ComplianceInput;
    try {
        input = extractComplianceInput(req.body);
    } catch (error) {
        if (error instanceof ComplianceInputError) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_COMPLIANCE_INPUT',
                message: error.message,
                telemetry: buildTelemetry({ requestId: req.requestId ?? null, failureStage: 'compliance' }),
            });
        }
        throw error;
    }

    try {
        const authReq = req as AuthRequest;
        const restrictedTickers = await getRestrictedTickersSet(authReq.teamContext ? {
            userId: authReq.user?.id ?? 'local-user',
            userName: authReq.user?.email ?? 'local-user',
            role: authReq.teamContext.role,
            teamId: authReq.teamContext.teamId,
        } : undefined);
        const restrictedArray = Array.from(restrictedTickers);
        const matches = findRestrictedMatches(input, restrictedTickers);

        if (matches.length > 0) {
            recordComplianceBlock();
            console.warn('[COMPLIANCE] Blocked AI request due to restricted security.');
            return res.status(403).json({
                success: false,
                error: 'COMPLIANCE_BLOCK',
                message: 'One or more identified assets are on the Restricted Trading List. Server-side enforcement activated. AI analysis denied.',
                matches,
                provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'live', sourceType: 'compliance' }),
                dataQuality: buildDataQuality({ status: 'ready', observations: restrictedArray.length }),
                telemetry: buildTelemetry({ requestId: req.requestId ?? null, failureStage: 'compliance' }),
            });
        }

        next();
    } catch (error) {
        console.error('[COMPLIANCE] Dataset unavailable, request blocked.', error);
        return res.status(503).json({
            success: false,
            error: 'COMPLIANCE_DATA_UNAVAILABLE',
            reason: 'compliance_unavailable',
            failureStage: 'compliance',
            durationMs: 0,
            notice: 'Compliance coverage is temporarily unavailable. AI analysis is paused until the dataset is restored.',
            message: 'Compliance coverage is temporarily unavailable. AI analysis is paused until the dataset is restored.',
            provenance: buildProvenance({ provider: 'Compliance Dataset', mode: 'fallback', sourceType: 'compliance', degradationReason: 'compliance_unavailable' }),
            dataQuality: buildDataQuality({ status: 'unavailable', errors: { compliance: 'dataset_unavailable' } }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, failureStage: 'compliance' }),
        });
    }
};
