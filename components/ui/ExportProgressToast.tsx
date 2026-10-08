import React, { useEffect, useState } from 'react';
import { CheckCircle2, FileText, Loader2, X, XCircle } from 'lucide-react';
import apiClient from '../../utils/apiClient';

interface ExportProgressToastProps {
    jobId: string;
    onClose: () => void;
}

export interface ExportArtifact {
    fileName: string;
    bytes: number | null;
    completedAt: string | null;
    retained: boolean;
    downloadUrl: string;
}

export function formatBytes(bytes: number | null | undefined): string {
    if (!bytes || bytes <= 0) return 'retained artifact';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function exportCompletedMessage(artifact: ExportArtifact | null): string {
    if (!artifact) return 'PDF export completed. Artifact metadata is unavailable.';
    return `PDF export completed: ${artifact.fileName} (${formatBytes(artifact.bytes)}).`;
}

export const ExportProgressToast: React.FC<ExportProgressToastProps> = ({ jobId, onClose }) => {
    const [state, setState] = useState<'waiting' | 'active' | 'completed' | 'failed' | 'unknown'>('waiting');
    const [message, setMessage] = useState<string | null>(null);
    const [artifact, setArtifact] = useState<ExportArtifact | null>(null);
    const [isDownloading, setIsDownloading] = useState(false);

    useEffect(() => {
        const checkStatus = async () => {
            try {
                const response = await apiClient.get(`/api/export/status/${jobId}`);
                if (response.data.success) {
                    setState(response.data.state);
                    if (response.data.state === 'failed') {
                        setMessage(response.data.failedReason ?? 'PDF export failed.');
                    } else if (response.data.state === 'completed') {
                        const nextArtifact = response.data.artifact ?? response.data.result ?? null;
                        setArtifact(nextArtifact);
                        setMessage(exportCompletedMessage(nextArtifact));
                    }
                }
            } catch {
                setState('failed');
                setMessage('PDF export status is unavailable.');
            }
        };

        void checkStatus();
        const intervalId = window.setInterval(() => void checkStatus(), 2000);
        return () => window.clearInterval(intervalId);
    }, [jobId]);

    const downloadArtifact = async () => {
        if (!artifact?.downloadUrl) return;
        setIsDownloading(true);
        try {
            const response = await apiClient.get(artifact.downloadUrl, { responseType: 'blob' });
            const blobUrl = window.URL.createObjectURL(response.data);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = artifact.fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(blobUrl);
        } catch {
            setMessage('PDF export was retained, but the download request failed.');
        } finally {
            setIsDownloading(false);
        }
    };

    const status = state === 'completed'
        ? { icon: <CheckCircle2 size={18} style={{ color: 'var(--ap-bull)' }} />, text: 'Export Complete', color: 'var(--ap-bull)' }
        : state === 'failed'
            ? { icon: <XCircle size={18} style={{ color: 'var(--ap-bear)' }} />, text: 'Generation Failed', color: 'var(--ap-bear)' }
            : { icon: <Loader2 size={18} style={{ color: 'var(--ap-accent)', animation: 'spin 1s linear infinite' }} />, text: 'Compiling Report...', color: 'var(--ap-accent)' };

    return (
        <div style={{
            position: 'fixed',
            bottom: 20,
            right: 20,
            backgroundColor: 'var(--ap-bg-elevated)',
            border: `1px solid ${status.color}`,
            borderRadius: 6,
            padding: 16,
            boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: 300,
            zIndex: 1000,
        }}>
            {status.icon}
            <div style={{ flex: 1 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--ap-text-heading)', margin: 0 }}>
                    {status.text}
                </p>
                {message && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ap-text-muted)', marginTop: 4 }}>
                        <FileText size={12} /> {message}
                    </span>
                )}
                {state === 'completed' && artifact?.downloadUrl && (
                    <button
                        type="button"
                        onClick={() => void downloadArtifact()}
                        disabled={isDownloading}
                        className="ap-btn ap-btn--ghost ap-btn--sm"
                        style={{ marginTop: 8, padding: '5px 8px', fontSize: 11 }}
                    >
                        <FileText size={12} /> {isDownloading ? 'Downloading...' : 'Download PDF'}
                    </button>
                )}
            </div>
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--ap-text-muted)', cursor: 'pointer', padding: 4 }}>
                <X size={16} />
            </button>
        </div>
    );
};
