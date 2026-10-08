import { ComplianceSummaryResponse, RuntimeStatusResponse } from '../types';
import apiClient, { apiFetch } from '../utils/apiClient';

export async function fetchRuntimeStatus(): Promise<RuntimeStatusResponse | null> {
    try {
        const response = await apiFetch('/health', { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error(`Health ${response.status}`);
        return await response.json();
    } catch {
        return null;
    }
}

export async function fetchComplianceSummary(): Promise<ComplianceSummaryResponse | null> {
    try {
        const response = await apiClient.get('/api/compliance/summary', { signal: AbortSignal.timeout(4000) });
        return response.data;
    } catch {
        return null;
    }
}
