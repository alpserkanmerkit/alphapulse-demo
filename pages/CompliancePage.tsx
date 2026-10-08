import React, { useEffect, useState } from 'react';
import { Shield, AlertTriangle, Clock, User, CheckCircle, Plus, Search, Trash2 } from 'lucide-react';
import { ComplianceCheckResult, ComplianceSummaryResponse } from '../types';
import { fetchComplianceSummary } from '../services/runtime';
import { useNewsStore } from '../stores/newsStore';
import { useAuthStore } from '../stores/authStore';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';

const timeAgo = (timestamp: number) => {
    const delta = Math.floor((Date.now() - timestamp) / 1000);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    return `${Math.floor(delta / 3600)}h ago`;
};

const CATEGORY_BADGE: Record<string, string> = {
    NEWS_VIEW: 'ap-badge--accent',
    TRADE_ACTION: 'ap-badge--warn',
    PORTFOLIO_CHANGE: 'ap-badge--purple',
    SYSTEM: 'ap-badge--neutral',
    HEDGE_EXECUTION: 'ap-badge--gold',
};

function getFreshness(updatedAt: string): { label: string; tone: string } {
    const ageMs = Date.now() - Date.parse(updatedAt);

    if (ageMs <= 6 * 60 * 60 * 1000) {
        return { label: 'Fresh', tone: 'ap-badge--bull' };
    }

    if (ageMs <= 24 * 60 * 60 * 1000) {
        return { label: 'Aging', tone: 'ap-badge--warn' };
    }

    return { label: 'Review Needed', tone: 'ap-badge--neutral' };
}

const CompliancePage: React.FC = () => {
    const [summary, setSummary] = useState<ComplianceSummaryResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [mutationError, setMutationError] = useState<string | null>(null);
    const [mutationNotice, setMutationNotice] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [checkTicker, setCheckTicker] = useState('');
    const [checkResult, setCheckResult] = useState<ComplianceCheckResult | null>(null);
    const [newTicker, setNewTicker] = useState('');
    const [newName, setNewName] = useState('');
    const [newReason, setNewReason] = useState('');
    const runtimeView = useNewsStore((state) => state.runtimeView);
    const currentUser = useAuthStore((state) => state.user);

    useEffect(() => {
        let alive = true;

        (async () => {
            const result = await fetchComplianceSummary();
            if (!alive) return;
            setSummary(result);
            setLoading(false);
        })();

        return () => {
            alive = false;
        };
    }, []);

    const unresolvedAlerts = summary?.alerts.filter((alert) => !alert.resolved) ?? [];
    const pendingApprovals = summary?.pendingApprovals ?? [];
    const freshness = summary ? getFreshness(summary.updatedAt) : null;
    const canMutate = Boolean(summary);
    const canReview = currentUser?.role === 'ADMIN' || currentUser?.role === 'COMPLIANCE_OFFICER';

    const applySummary = (nextSummary: ComplianceSummaryResponse) => {
        setSummary(nextSummary);
        setMutationError(null);
    };

    const resolveAlert = async (alertId: string) => {
        setActionLoading(alertId);
        setMutationError(null);
        try {
            const response = await apiClient.post(`/api/compliance/alerts/${alertId}/resolve`);
            applySummary(response.data.summary);
            setMutationNotice('Compliance alert resolved and audited.');
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not resolve compliance alert.'));
        } finally {
            setActionLoading(null);
        }
    };

    const removeRestricted = async (ticker: string) => {
        setActionLoading(`remove-${ticker}`);
        setMutationError(null);
        try {
            const response = await apiClient.delete(`/api/compliance/restricted/${ticker}`);
            applySummary(response.data.summary);
            setMutationNotice(`${ticker} removal is pending second approval.`);
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not remove restricted security.'));
        } finally {
            setActionLoading(null);
        }
    };

    const addRestricted = async (event: React.FormEvent) => {
        event.preventDefault();
        setActionLoading('add-restricted');
        setMutationError(null);
        try {
            const response = await apiClient.post('/api/compliance/restricted', {
                ticker: newTicker,
                name: newName,
                reason: newReason,
            });
            applySummary(response.data.summary);
            setMutationNotice(`${newTicker.toUpperCase()} restriction is pending second approval.`);
            setNewTicker('');
            setNewName('');
            setNewReason('');
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not add restricted security.'));
        } finally {
            setActionLoading(null);
        }
    };

    const reviewChange = async (changeId: string, decision: 'approve' | 'reject') => {
        setActionLoading(`${decision}-${changeId}`);
        setMutationError(null);
        setMutationNotice(null);
        try {
            const response = await apiClient.post(`/api/compliance/approvals/${changeId}/${decision}`, {});
            applySummary(response.data.summary);
            setMutationNotice(`Compliance change request ${decision === 'approve' ? 'approved' : 'rejected'}.`);
        } catch (error) {
            setMutationError(getApiErrorMessage(error, `Could not ${decision} compliance change request.`));
        } finally {
            setActionLoading(null);
        }
    };

    const runTickerCheck = async (event: React.FormEvent) => {
        event.preventDefault();
        setActionLoading('check-ticker');
        setMutationError(null);
        try {
            const response = await apiClient.post('/api/compliance/check', { ticker: checkTicker });
            setCheckResult(response.data.result);
        } catch (error) {
            setMutationError(getApiErrorMessage(error, 'Could not check ticker.'));
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <header className="ap-page-header">
                <div>
                    <h2 className="ap-page-title">
                        <Shield size={18} style={{ color: 'var(--ap-accent)' }} />
                        Compliance Centre
                    </h2>
                    <p className="ap-page-sub">Audit trail · Restricted list · Active alerts · Operational dataset</p>
                </div>
                <div className="ap-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {freshness && (
                        <span className={`ap-badge ${freshness.tone}`}>
                            {freshness.label}
                        </span>
                    )}
                    {unresolvedAlerts.length > 0 && (
                        <span className="ap-badge ap-badge--bear">
                            <AlertTriangle size={10} /> {unresolvedAlerts.length} UNRESOLVED
                        </span>
                    )}
                </div>
            </header>

            <div className="ap-scroll-area">
                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {!loading && !summary && (
                        <div className="ap-card" style={{ padding: 16, borderColor: 'rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)' }}>
                            <p style={{ margin: 0, fontSize: 12, color: 'var(--ap-bear)' }}>
                                Compliance dataset is temporarily unavailable. AI enforcement stays paused until backend coverage is restored.
                            </p>
                        </div>
                    )}

                    {summary && (
                        <div className="ap-card" style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                            <div>
                                <p style={{ margin: 0, fontSize: 10, color: 'var(--ap-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Dataset Status</p>
                                <p data-testid="compliance-dataset-status" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ap-text-heading)', fontFamily: 'JetBrains Mono' }}>{runtimeView.labels.compliance}</p>
                            </div>
                            <div>
                                <p style={{ margin: 0, fontSize: 10, color: 'var(--ap-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Version</p>
                                <p data-testid="compliance-version" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ap-text-heading)', fontFamily: 'JetBrains Mono' }}>v{summary.version}</p>
                            </div>
                            <div>
                                <p style={{ margin: 0, fontSize: 10, color: 'var(--ap-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Updated</p>
                                <p data-testid="compliance-updated" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ap-text-heading)', fontFamily: 'JetBrains Mono' }}>{new Date(summary.updatedAt).toLocaleString()}</p>
                            </div>
                            <div style={{ minWidth: 220 }}>
                                <p style={{ margin: 0, fontSize: 10, color: 'var(--ap-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Snapshot Hash</p>
                                <p data-testid="compliance-hash" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ap-text-heading)', fontFamily: 'JetBrains Mono', wordBreak: 'break-all' }}>{summary.hash}</p>
                            </div>
                            <div>
                                <p style={{ margin: 0, fontSize: 10, color: 'var(--ap-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Freshness</p>
                                <p data-testid="compliance-freshness" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ap-text-heading)', fontFamily: 'JetBrains Mono' }}>{freshness?.label ?? 'Unknown'}</p>
                            </div>
                        </div>
                    )}

                    <section data-testid="compliance-actions">
                        <p className="ap-section-title">COMPLIANCE ACTIONS</p>
                        <div className="ap-card" style={{ padding: 16 }}>
                            {mutationError && (
                                <div style={{ marginBottom: 12, padding: 10, border: '1px solid rgba(239,68,68,0.35)', color: 'var(--ap-bear)', fontSize: 12 }}>
                                    {mutationError}
                                </div>
                            )}
                            {mutationNotice && (
                                <div style={{ marginBottom: 12, padding: 10, border: '1px solid rgba(34,197,94,0.35)', color: 'var(--ap-bull)', fontSize: 12 }}>
                                    {mutationNotice}
                                </div>
                            )}
                            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 0.8fr) minmax(0, 1.2fr)', gap: 16 }}>
                                <form onSubmit={runTickerCheck} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    <p style={{ margin: 0, fontSize: 11, color: 'var(--ap-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Restricted Ticker Check</p>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <input className="ap-input" value={checkTicker} onChange={(event) => setCheckTicker(event.target.value.toUpperCase())} placeholder="AAPL" disabled={!canMutate} style={{ textTransform: 'uppercase' }} />
                                        <button className="ap-btn ap-btn--accent ap-btn--sm" disabled={!canMutate || !checkTicker.trim() || actionLoading === 'check-ticker'} type="submit">
                                            <Search size={13} /> Check
                                        </button>
                                    </div>
                                    {checkResult && (
                                        <div style={{ padding: 10, border: `1px solid ${checkResult.restricted ? 'rgba(239,68,68,0.35)' : 'rgba(34,197,94,0.35)'}`, color: checkResult.restricted ? 'var(--ap-bear)' : 'var(--ap-bull)', fontSize: 12 }}>
                                            {checkResult.ticker} is {checkResult.restricted ? `restricted: ${checkResult.security?.reason}` : 'clear for review'}.
                                        </div>
                                    )}
                                </form>

                                <form onSubmit={addRestricted} style={{ display: 'grid', gridTemplateColumns: '110px minmax(140px, 1fr) minmax(160px, 1.2fr) auto', gap: 8, alignItems: 'end' }}>
                                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 10, color: 'var(--ap-text-muted)' }}>
                                        TICKER
                                        <input className="ap-input" value={newTicker} onChange={(event) => setNewTicker(event.target.value.toUpperCase())} disabled={!canMutate} required style={{ textTransform: 'uppercase' }} />
                                    </label>
                                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 10, color: 'var(--ap-text-muted)' }}>
                                        NAME
                                        <input className="ap-input" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={!canMutate} required />
                                    </label>
                                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 10, color: 'var(--ap-text-muted)' }}>
                                        REASON
                                        <input className="ap-input" value={newReason} onChange={(event) => setNewReason(event.target.value)} disabled={!canMutate} required />
                                    </label>
                                    <button className="ap-btn ap-btn--accent ap-btn--sm" type="submit" disabled={!canMutate || actionLoading === 'add-restricted'}>
                                        <Plus size={13} /> Add
                                    </button>
                                </form>
                            </div>
                        </div>
                    </section>

                    <section data-testid="compliance-pending-approvals">
                        <p className="ap-section-title">PENDING APPROVALS</p>
                        <div className="ap-card" style={{ padding: 12, marginBottom: 12, background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.25)' }}>
                            <p style={{ margin: 0, fontSize: 12, color: 'var(--ap-text-secondary)' }}>
                                Restricted-list changes require a second compliance/admin reviewer before they affect enforcement.
                            </p>
                        </div>
                        {pendingApprovals.length === 0 ? (
                            <div className="ap-card" style={{ padding: 16, color: 'var(--ap-text-muted)', fontSize: 12 }}>
                                No pending compliance change requests.
                            </div>
                        ) : (
                            <div className="ap-table-wrap">
                                <table className="ap-table">
                                    <thead>
                                        <tr>
                                            <th>ACTION</th>
                                            <th>TICKER</th>
                                            <th>REQUESTED BY</th>
                                            <th>REASON</th>
                                            <th>TIME</th>
                                            <th>REVIEW</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {pendingApprovals.map((change) => {
                                            const isOwnRequest = currentUser?.id === change.requestedById;
                                            return (
                                                <tr key={change.id}>
                                                    <td>
                                                        <span className={`ap-badge ${change.action === 'ADD_RESTRICTED' ? 'ap-badge--warn' : 'ap-badge--neutral'}`}>
                                                            {change.action.replace(/_/g, ' ')}
                                                        </span>
                                                    </td>
                                                    <td className="mono" style={{ color: 'var(--ap-text-heading)', fontWeight: 700 }}>{change.ticker}</td>
                                                    <td style={{ fontSize: 11 }}>{change.requestedByName}</td>
                                                    <td style={{ color: 'var(--ap-text-secondary)' }}>{change.reason ?? 'No reason supplied'}</td>
                                                    <td className="mono" style={{ fontSize: 11, color: 'var(--ap-text-muted)' }}>{timeAgo(change.createdAt)}</td>
                                                    <td>
                                                        <div style={{ display: 'flex', gap: 6 }}>
                                                            <button type="button" className="ap-btn ap-btn--accent ap-btn--sm" disabled={!canReview || isOwnRequest || actionLoading === `approve-${change.id}`} onClick={() => void reviewChange(change.id, 'approve')}>
                                                                Approve
                                                            </button>
                                                            <button type="button" className="ap-btn ap-btn--ghost ap-btn--sm" disabled={!canReview || isOwnRequest || actionLoading === `reject-${change.id}`} onClick={() => void reviewChange(change.id, 'reject')}>
                                                                Reject
                                                            </button>
                                                        </div>
                                                        {isOwnRequest && (
                                                            <p style={{ margin: '6px 0 0', fontSize: 10, color: 'var(--ap-text-muted)' }}>Second reviewer required</p>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <section>
                        <p className="ap-section-title">COMPLIANCE ALERTS</p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {loading && <div className="ap-card" style={{ padding: 16 }}>Loading compliance alerts...</div>}
                            {summary?.alerts.map((alert) => (
                                <div
                                    key={alert.id}
                                    className={`ap-card ${alert.severity === 'CRITICAL' ? 'ap-card--bear' : 'ap-card--warn'}`}
                                    style={{
                                        padding: '12px 16px',
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: 12,
                                        opacity: alert.resolved ? 0.5 : 1,
                                    }}
                                >
                                    <AlertTriangle size={16} style={{ color: alert.severity === 'CRITICAL' ? 'var(--ap-bear)' : 'var(--ap-warn)', flexShrink: 0, marginTop: 2 }} />
                                    <div style={{ flex: 1 }}>
                                        <div style={{ display: 'flex', gap: 8, marginBottom: 4, alignItems: 'center' }}>
                                            <span className={`ap-badge ${alert.severity === 'CRITICAL' ? 'ap-badge--bear' : 'ap-badge--warn'}`}>
                                                {alert.severity}
                                            </span>
                                            <span className="ap-badge ap-badge--neutral">{alert.type.replace(/_/g, ' ')}</span>
                                            <span style={{ fontSize: 10, color: 'var(--ap-text-muted)', marginLeft: 'auto', fontFamily: 'JetBrains Mono' }}>
                                                {timeAgo(alert.timestamp)}
                                            </span>
                                        </div>
                                        <p style={{ fontSize: 12, color: 'var(--ap-text-secondary)', lineHeight: 1.5, margin: 0 }}>{alert.message}</p>
                                    </div>
                                    {alert.resolved ? (
                                        <span style={{ fontSize: 10, color: 'var(--ap-bull)', fontFamily: 'JetBrains Mono', flexShrink: 0 }}>
                                            RESOLVED
                                        </span>
                                    ) : (
                                        <button type="button" className="ap-btn ap-btn--ghost ap-btn--sm" disabled={actionLoading === alert.id} onClick={() => void resolveAlert(alert.id)}>
                                            <CheckCircle size={12} /> Resolve
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>

                    <section>
                        <p className="ap-section-title">RESTRICTED SECURITIES LIST</p>
                        <div className="ap-card" style={{ padding: 12, marginBottom: 12, background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.25)' }}>
                            <p style={{ margin: 0, fontSize: 12, color: 'var(--ap-warn)' }}>
                                Source of truth is the backend compliance ledger. Restricted-list changes are audited and require second approval.
                            </p>
                        </div>
                        <div className="ap-table-wrap">
                            <table className="ap-table">
                                <thead>
                                    <tr>
                                        <th>TICKER</th>
                                        <th>NAME</th>
                                        <th>REASON</th>
                                        <th>RESTRICTED SINCE</th>
                                        <th>EXPIRES</th>
                                        <th>ADDED BY</th>
                                        <th>ACTION</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {summary?.restricted.map((security) => (
                                        <tr key={security.ticker}>
                                            <td className="mono" style={{ color: 'var(--ap-bear)', fontWeight: 700 }}>{security.ticker}</td>
                                            <td style={{ fontWeight: 500 }}>{security.name}</td>
                                            <td style={{ color: 'var(--ap-text-secondary)' }}>{security.reason}</td>
                                            <td className="mono" style={{ fontSize: 11 }}>{new Date(security.restrictedSince).toLocaleDateString()}</td>
                                            <td className="mono" style={{ fontSize: 11, color: 'var(--ap-text-muted)' }}>
                                                {security.restrictedUntil ? new Date(security.restrictedUntil).toLocaleDateString() : 'Open'}
                                            </td>
                                            <td style={{ fontSize: 11 }}>{security.addedBy}</td>
                                            <td>
                                                <button type="button" className="ap-btn ap-btn--ghost ap-btn--sm" disabled={actionLoading === `remove-${security.ticker}`} onClick={() => void removeRestricted(security.ticker)}>
                                                    <Trash2 size={12} /> Remove
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section>
                        <p className="ap-section-title">AUDIT TRAIL</p>
                        <div className="ap-table-wrap">
                            <table className="ap-table">
                                <thead>
                                    <tr>
                                        <th>USER</th>
                                        <th>ACTION</th>
                                        <th>CATEGORY</th>
                                        <th>TIME</th>
                                        <th>DETAILS</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {summary?.audit.map((entry) => (
                                        <tr key={entry.id}>
                                            <td>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <User size={12} style={{ color: 'var(--ap-text-muted)' }} />
                                                    <span style={{ fontWeight: 500 }}>{entry.userName}</span>
                                                </div>
                                            </td>
                                            <td style={{ fontWeight: 500, color: 'var(--ap-text-heading)' }}>{entry.action}</td>
                                            <td>
                                                <span className={`ap-badge ${CATEGORY_BADGE[entry.category] ?? 'ap-badge--neutral'}`}>
                                                    {entry.category.replace(/_/g, ' ')}
                                                </span>
                                            </td>
                                            <td className="mono" style={{ fontSize: 11, color: 'var(--ap-text-muted)' }}>
                                                <Clock size={10} className="inline" style={{ marginRight: 4 }} />
                                                {timeAgo(entry.timestamp)}
                                            </td>
                                            <td style={{ fontSize: 11, color: 'var(--ap-text-secondary)' }}>{entry.details}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </div>
                <div style={{ height: 40 }} />
            </div>
        </div>
    );
};

export default CompliancePage;
