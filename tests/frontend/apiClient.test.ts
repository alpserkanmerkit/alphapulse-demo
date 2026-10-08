import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/authStore';
import { apiFetch, buildApiUrl } from '../../utils/apiClient';

describe('api client helpers', () => {
    afterEach(() => {
        useAuthStore.getState().logout();
        vi.unstubAllGlobals();
    });

    it('builds backend URLs from one shared base', () => {
        expect(buildApiUrl('/api/news/feed')).toBe('http://localhost:3001/api/news/feed');
        expect(buildApiUrl('http://example.com/health')).toBe('http://example.com/health');
        expect(buildApiUrl('api/health')).toBe('http://localhost:3001/api/health');
    });

    it('adds auth and JSON headers to centralized fetch calls', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        useAuthStore.getState().setAuth('fixture-token', {
            id: 'user-1',
            email: 'user@example.com',
            name: 'Fixture User',
            role: 'ANALYST',
        });

        await apiFetch('/api/ai/analyze', {
            method: 'POST',
            body: JSON.stringify({ headline: 'Fixture' }),
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:3001/api/ai/analyze',
            expect.objectContaining({
                method: 'POST',
                headers: expect.any(Headers),
            })
        );
        const headers = fetchMock.mock.calls[0][1].headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer fixture-token');
        expect(headers.get('Content-Type')).toBe('application/json');
    });
});
