import { describe, expect, it } from 'vitest';
import { buildRuntimeView } from '../../services/runtimeView';
import { RuntimeStatusResponse } from '../../types';

function buildRuntime(overrides: Partial<RuntimeStatusResponse> = {}): RuntimeStatusResponse {
    return {
        status: 'ok',
        version: '2.0.0',
        mode: 'live',
        services: {
            ai: 'live',
            quant: 'reachable',
            compliance: 'ready',
        },
        diagnostics: {
            quant: {
                reason: null,
                checkedAt: '2026-04-18T12:00:00.000Z',
            },
            compliance: {
                source: 'local-file',
                reason: null,
                loadedAt: '2026-04-18T12:00:00.000Z',
            },
        },
        timestamp: '2026-04-18T12:00:00.000Z',
        ...overrides,
    };
}

describe('buildRuntimeView', () => {
    it('renders offline fallback labels when backend is unavailable', () => {
        const view = buildRuntimeView(null, 'fallback', 'fallback');

        expect(view.backendLive).toBe(false);
        expect(view.labels.backend).toBe('Offline');
        expect(view.labels.ai).toBe('Simulation');
        expect(view.labels.feed).toBe('Fallback Feed');
        expect(view.labels.quant).toBe('Price Model Standby');
        expect(view.labels.compliance).toBe('Dataset Offline');
        expect(view.notices).toContain('Live services are temporarily offline.');
    });

    it('renders live labels for reachable services', () => {
        const view = buildRuntimeView(buildRuntime(), 'live', 'live');

        expect(view.labels.backend).toBe('Online');
        expect(view.labels.ai).toBe('Live AI');
        expect(view.labels.feed).toBe('Live Feed');
        expect(view.labels.quant).toBe('Price Model Ready');
        expect(view.labels.compliance).toBe('Dataset Active');
        expect(view.diagnostics).toContain('Quant reachable');
    });

    it('shows degraded compliance and quant diagnostics', () => {
        const view = buildRuntimeView(buildRuntime({
            services: {
                ai: 'simulation',
                quant: 'unreachable',
                compliance: 'degraded',
            },
            diagnostics: {
                quant: {
                    reason: 'connection_refused',
                    checkedAt: '2026-04-18T12:00:00.000Z',
                },
                compliance: {
                    source: 'local-file',
                    reason: null,
                    loadedAt: '2026-04-18T12:00:00.000Z',
                },
            },
        }), 'fallback', 'simulation');

        expect(view.labels.ai).toBe('Simulation');
        expect(view.labels.compliance).toBe('Dataset Limited');
        expect(view.diagnostics).toContain('Quant unavailable (connection refused)');
        expect(view.notices).toContain('Compliance coverage is available with limited data.');
    });

    it('shows unavailable compliance notice when dataset is offline', () => {
        const view = buildRuntimeView(buildRuntime({
            services: {
                ai: 'live',
                quant: 'reachable',
                compliance: 'unavailable',
            },
            diagnostics: {
                quant: {
                    reason: null,
                    checkedAt: '2026-04-18T12:00:00.000Z',
                },
                compliance: {
                    source: null,
                    reason: 'dataset_missing',
                    loadedAt: null,
                },
            },
        }), 'live', 'live');

        expect(view.labels.compliance).toBe('Dataset Offline');
        expect(view.notices).toContain('Compliance coverage is temporarily unavailable.');
        expect(view.diagnostics).toContain('Compliance unavailable');
    });
});
