import { describe, expect, it } from 'vitest';
import { buildRuntimeView } from '../../../services/runtimeView';
import { RuntimeStatusResponse } from '../../../types';

// Mutants closed here: r2 (runtime AI mode wins), r3 (feed fallback notice), r10 (compliance source),
// r16 (AI simulation notice), r17 (analysis fallback label).
function runtime(ai: 'live' | 'simulation' = 'live'): RuntimeStatusResponse {
    return {
        status: 'ok',
        version: '2.0.0',
        mode: 'live',
        services: { ai, quant: 'reachable', compliance: 'ready' },
        diagnostics: {
            quant: { reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            compliance: { source: 'local-file', reason: null, loadedAt: '2026-04-18T12:00:00.000Z' },
        },
        timestamp: '2026-04-18T12:00:00.000Z',
    };
}

describe('survivors: buildRuntimeView', () => {
    it('lets the runtime AI mode win over the last local analysis mode', () => {
        const view = buildRuntimeView(runtime('live'), 'live', 'fallback');

        expect(view.aiMode).toBe('live');
        expect(view.labels.ai).toBe('Live AI');
        expect(view.diagnostics).not.toContain('AI simulation mode');
    });

    it('reports feed fallback and compliance source in notices and diagnostics', () => {
        const view = buildRuntimeView(runtime(), 'fallback', 'live');

        expect(view.notices).toContain('Feed is using local fallback data.');
        expect(view.diagnostics).toContain('Feed fallback active');
        expect(view.diagnostics).toContain('Compliance source local-file');
        expect(buildRuntimeView(runtime(), 'live', 'live').notices).not.toContain('Feed is using local fallback data.');
    });

    it('announces AI simulation mode in notices and diagnostics', () => {
        const view = buildRuntimeView(runtime('simulation'), 'live', 'simulation');

        expect(view.notices).toContain('AI is running in simulation mode.');
        expect(view.diagnostics).toContain('AI simulation mode');
    });

    it('shows the analysis notice, or a default label, when analysis fell back locally', () => {
        const withNotice = buildRuntimeView(runtime(), 'live', 'fallback', 'Compliance paused analysis.');
        const withoutNotice = buildRuntimeView(runtime(), 'live', 'fallback');

        expect(withNotice.notices).toContain('Compliance paused analysis.');
        expect(withNotice.diagnostics).toContain('Compliance paused analysis.');
        expect(withoutNotice.notices).toContain('Analysis is using local fallback output.');
        expect(withoutNotice.diagnostics).toContain('Local analysis fallback');
        expect(buildRuntimeView(runtime(), 'live', 'live', 'Stale notice.').notices).not.toContain('Stale notice.');
    });
});
