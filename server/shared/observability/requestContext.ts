import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { recordHttpRequest } from './runtimeMetrics';

declare module 'express-serve-static-core' {
    interface Request {
        requestId?: string;
        startedAt?: number;
    }
}

export interface ObservedRequest extends Request {
    requestId?: string;
    startedAt?: number;
}

export function requestContextMiddleware(req: ObservedRequest, res: Response, next: NextFunction) {
    const incomingRequestId = req.header('x-request-id');
    req.requestId = incomingRequestId && incomingRequestId.trim() ? incomingRequestId.trim() : randomUUID();
    req.startedAt = Date.now();
    res.setHeader('x-request-id', req.requestId);
    next();
}

export function requestTelemetry(req: ObservedRequest, failureStage: string | null = null) {
    return {
        requestId: req.requestId ?? null,
        durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
        failureStage,
    };
}

export function logRequest(req: ObservedRequest, res: Response) {
    const durationMs = req.startedAt ? Date.now() - req.startedAt : 0;
    const user = (req as ObservedRequest & { user?: { id?: string; role?: string } }).user;
    recordHttpRequest(res.statusCode);
    console.log(JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        event: 'http_request',
        requestId: req.requestId ?? null,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        userId: user?.id ?? null,
        role: user?.role ?? null,
        timestamp: new Date().toISOString(),
    }));
}
