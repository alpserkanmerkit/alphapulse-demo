import { afterEach, describe, expect, it, vi } from 'vitest';

// Pure-helper tests never render icons; skip the ~100 ms lucide-react barrel import.
vi.mock('lucide-react', () => ({ CheckCircle2: () => null, FileText: () => null, Loader2: () => null, X: () => null, XCircle: () => null }));

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('../helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

import { formatBytes } from '../../../components/ui/ExportProgressToast';
import { useAuthStore } from '../../../stores/authStore';
import { apiFetch } from '../../../utils/apiClient';

// Mutants closed here: a6 (FormData guard), a8 (explicit Authorization), e5 (MB unit).
describe('survivors: apiFetch header rules', () => {
    afterEach(() => {
        useAuthStore.getState().logout();
        vi.unstubAllGlobals();
    });

    function stubFetch() {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('does not force a JSON Content-Type on FormData bodies (boundary must be browser-chosen)', async () => {
        const fetchMock = stubFetch();

        await apiFetch('/api/upload', { method: 'POST', body: new FormData() });

        const headers = fetchMock.mock.calls[0][1].headers as Headers;
        expect(headers.has('Content-Type')).toBe(false);
    });

    it('keeps a caller-supplied Authorization header instead of the stored token', async () => {
        const fetchMock = stubFetch();
        useAuthStore.getState().setAuth('stored-token', {
            id: 'u1', email: 'a@b.co', name: 'A', role: 'ANALYST',
        });

        await apiFetch('/api/x', { headers: { Authorization: 'Bearer explicit-token' } });

        const headers = fetchMock.mock.calls[0][1].headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer explicit-token');
    });
});

describe('survivors: formatBytes megabyte range', () => {
    it('switches to MB at 1 MiB and keeps one decimal', () => {
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
    });
});
