import { describe, expect, it, vi } from 'vitest';

// Pure-helper tests never render icons; skip the ~100 ms lucide-react barrel import.
vi.mock('lucide-react', () => ({ CheckCircle2: () => null, FileText: () => null, Loader2: () => null, X: () => null, XCircle: () => null }));

import { exportCompletedMessage, formatBytes } from '../../components/ui/ExportProgressToast';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('./helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

describe('export toast helpers', () => {
    it('formats retained artifact metadata without claiming downloads are unavailable', () => {
        const message = exportCompletedMessage({
            fileName: 'alphapulse-report-42.pdf',
            bytes: 2048,
            completedAt: '2026-05-03T12:00:00.000Z',
            retained: true,
            downloadUrl: '/api/export/download/42',
        });

        expect(message).toBe('PDF export completed: alphapulse-report-42.pdf (2.0 KB).');
        expect(exportCompletedMessage(null)).toBe('PDF export completed. Artifact metadata is unavailable.');
    });

    it('formats byte sizes for export artifacts', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(null)).toBe('retained artifact');
    });
});
