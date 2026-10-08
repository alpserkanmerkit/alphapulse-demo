import React, { useState } from 'react';
import { NewsItem, Sentiment, TradingScenario } from '../types';
import ScoreBadge from './ScoreBadge';
import { ChevronDown, ChevronUp, Activity, Share2, Globe, FileText, Loader2, TrendingUp, TrendingDown, Shield, AlertOctagon } from 'lucide-react';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';
import { ExportProgressToast } from './ui/ExportProgressToast';

interface NewsCardProps {
  item: NewsItem;
  onAnalyze?: () => void;
  onGenerateDeepDive: (id: string) => void;
}

const NewsCard: React.FC<NewsCardProps> = ({ item, onAnalyze, onGenerateDeepDive }) => {
  const [expanded, setExpanded] = useState(false);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const getSentimentColor = (sentiment?: Sentiment): string => {
    if (sentiment === Sentiment.POSITIVE) return 'var(--ap-bull)';
    if (sentiment === Sentiment.NEGATIVE) return 'var(--ap-bear)';
    return 'var(--ap-text-muted)';
  };

  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const getDirectionStyle = (direction: string): React.CSSProperties => {
    switch (direction) {
      case 'LONG':
        return { color: 'var(--ap-bull)', borderColor: 'rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.08)' };
      case 'SHORT':
        return { color: 'var(--ap-bear)', borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)' };
      case 'HEDGE':
        return { color: '#a78bfa', borderColor: 'rgba(167,139,250,0.3)', background: 'rgba(167,139,250,0.08)' };
      default:
        return { color: 'var(--ap-text-muted)', borderColor: 'var(--ap-border)', background: 'var(--ap-bg-elevated)' };
    }
  };

  const getDirectionIcon = (direction: string) => {
    switch (direction) {
      case 'LONG':
        return <TrendingUp size={16} />;
      case 'SHORT':
        return <TrendingDown size={16} />;
      case 'HEDGE':
        return <Shield size={16} />;
      default:
        return <Activity size={16} />;
    }
  };

  const getRiskColor = (risk: string): string => {
    switch (risk) {
      case 'LOW':
        return 'var(--ap-bull)';
      case 'MEDIUM':
        return 'var(--ap-warn)';
      case 'HIGH':
        return 'var(--ap-bear)';
      default:
        return 'var(--ap-text-muted)';
    }
  };

  const handleExport = async () => {
    setExportError(null);
    try {
      const response = await apiClient.post('/api/export/generate-pdf', {
        reportData: {
          headline: item.headline,
          score: item.score,
          summary: item.summary,
          deepDive: item.deepDive,
        },
      });
      if (response.data.success) {
        setExportJobId(response.data.jobId);
      }
    } catch (error) {
      setExportError(getApiErrorMessage(error, 'Export queue is unavailable.'));
    }
  };

  return (
    <div
      style={{
        borderBottom: '1px solid var(--ap-border)',
        padding: '16px',
        transition: 'background 0.2s',
        background: item.score && item.score > 85 ? 'rgba(239,68,68,0.06)' : 'transparent',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = item.score && item.score > 85 ? 'rgba(239,68,68,0.1)' : 'var(--ap-bg-elevated)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = item.score && item.score > 85 ? 'rgba(239,68,68,0.06)' : 'transparent';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flexShrink: 0, paddingTop: 4 }}>
          {item.isAnalysing ? (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                border: '2px solid var(--ap-border)',
                borderTopColor: 'var(--ap-accent)',
                animation: 'spin 1s linear infinite',
              }}
            />
          ) : item.isAnalyzed && item.score !== undefined ? (
            <ScoreBadge score={item.score} />
          ) : item.analysisError ? (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                border: '2px solid rgba(239,68,68,0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                color: 'var(--ap-bear)',
              }}
            >
              Retry
            </div>
          ) : item.analysisQueued ? (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                border: '2px solid rgba(59,130,246,0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                color: 'var(--ap-accent)',
              }}
            >
              Queued
            </div>
          ) : (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                border: '2px solid var(--ap-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                color: 'var(--ap-text-muted)',
              }}
            >
              Pending
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <span
              style={{
                fontSize: 11,
                fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--ap-accent)',
                padding: '2px 8px',
                borderRadius: 4,
                background: 'rgba(99,102,241,0.1)',
                border: '1px solid rgba(99,102,241,0.25)',
              }}
            >
              {item.category}
            </span>
            <span style={{ fontSize: 11, color: 'var(--ap-text-muted)', fontFamily: 'JetBrains Mono, monospace', display: 'flex', alignItems: 'center', gap: 4 }}>
              {formatTime(item.timestamp)}
              <span style={{ color: 'var(--ap-border)', margin: '0 4px' }}>|</span>
              {item.source}
            </span>
          </div>

          <h3
            onClick={() => setExpanded(!expanded)}
            style={{
              color: 'var(--ap-text-heading)',
              fontWeight: 500,
              lineHeight: 1.4,
              marginBottom: 8,
              cursor: 'pointer',
              transition: 'color 0.15s',
              fontSize: 14,
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.color = 'var(--ap-accent)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = 'var(--ap-text-heading)';
            }}
          >
            {item.headline}
          </h3>

          {item.isAnalyzed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, color: getSentimentColor(item.sentiment) }}>
                <Activity size={14} />
                {item.sentiment}
              </span>
              {item.analysisMode && item.analysisMode !== 'live' && (
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: 'JetBrains Mono, monospace',
                    color: item.analysisMode === 'simulation' ? 'var(--ap-warn)' : 'var(--ap-bear)',
                    border: '1px solid currentColor',
                    borderRadius: 4,
                    padding: '2px 6px',
                    textTransform: 'uppercase',
                  }}
                >
                  {item.analysisMode}
                </span>
              )}
              {item.affectedAssets && item.affectedAssets.length > 0 && (
                <div style={{ display: 'flex', gap: 8 }}>
                  {item.affectedAssets.map((asset) => (
                    <span
                      key={asset}
                      style={{
                        fontSize: 11,
                        fontFamily: 'JetBrains Mono, monospace',
                        background: 'var(--ap-bg-elevated)',
                        color: 'var(--ap-text-secondary)',
                        padding: '2px 6px',
                        borderRadius: 4,
                        border: '1px solid var(--ap-border)',
                      }}
                    >
                      ${asset}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {!item.isAnalyzed && onAnalyze && (
            <button
              onClick={onAnalyze}
              disabled={item.isAnalysing}
              className="ap-btn ap-btn--ghost ap-btn--sm"
              style={{ marginTop: 8 }}
            >
              {item.isAnalysing ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Activity size={13} />}
              {item.isAnalysing ? 'Analyzing' : item.analysisQueued ? 'Queued' : item.analysisError ? 'Retry Analyze' : 'Analyze'}
            </button>
          )}

          {!item.isAnalyzed && (item.analysisNotice || item.analysisError) && (
            <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: item.analysisError ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)', border: item.analysisError ? '1px solid rgba(239,68,68,0.22)' : '1px solid rgba(245,158,11,0.22)', color: item.analysisError ? 'var(--ap-bear)' : 'var(--ap-warn)', fontSize: 12 }}>
              {item.analysisNotice ?? item.analysisError}
            </div>
          )}
        </div>

        <button
          onClick={() => setExpanded(!expanded)}
          style={{ color: 'var(--ap-text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, transition: 'color 0.15s' }}
          onMouseEnter={(event) => {
            (event.currentTarget as HTMLButtonElement).style.color = 'var(--ap-text-heading)';
          }}
          onMouseLeave={(event) => {
            (event.currentTarget as HTMLButtonElement).style.color = 'var(--ap-text-muted)';
          }}
        >
          {expanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
      </div>

      {expanded && item.isAnalyzed && (
        <div style={{ marginTop: 16, marginLeft: 64 }}>
          <div
            style={{
              padding: 16,
              borderRadius: 8,
              background: 'var(--ap-bg-elevated)',
              border: '1px solid var(--ap-border)',
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, color: '#a78bfa', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              <Globe size={12} />
              AlphaPulse Quick Take
            </div>
            <p style={{ color: 'var(--ap-text-secondary)', lineHeight: 1.6, margin: 0 }}>
              {item.summary}
            </p>
          </div>

          <div>
            {!item.deepDive ? (
              <button
                onClick={() => onGenerateDeepDive(item.id)}
                disabled={item.isDeepDiveLoading}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  borderRadius: 8,
                  cursor: item.isDeepDiveLoading ? 'not-allowed' : 'pointer',
                  background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.08))',
                  border: '1px solid rgba(99,102,241,0.3)',
                  padding: 16,
                  transition: 'border-color 0.2s, background 0.2s',
                }}
                onMouseEnter={(event) => {
                  if (!item.isDeepDiveLoading) {
                    (event.currentTarget as HTMLButtonElement).style.borderColor = 'var(--ap-accent)';
                  }
                }}
                onMouseLeave={(event) => {
                  (event.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,102,241,0.3)';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ background: 'rgba(99,102,241,0.1)', padding: 8, borderRadius: 8, color: 'var(--ap-accent)' }}>
                      {item.isDeepDiveLoading ? <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /> : <FileText size={20} />}
                    </div>
                    <div>
                      <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--ap-text-heading)', margin: '0 0 4px' }}>
                        {item.isDeepDiveLoading ? 'Generating Analysis & Scenarios...' : 'Generate Deep Dive & Decision-Support Scenarios'}
                      </h4>
                      <p style={{ fontSize: 11, color: 'var(--ap-text-muted)', margin: 0 }}>
                        {item.isDeepDiveLoading ? 'Calculating correlations...' : 'Get a 270-word report with paper/simulation setups'}
                      </p>
                    </div>
                  </div>
                  {!item.isDeepDiveLoading && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: 'JetBrains Mono, monospace',
                        background: 'rgba(99,102,241,0.15)',
                        color: 'var(--ap-accent)',
                        padding: '4px 8px',
                        borderRadius: 4,
                        border: '1px solid rgba(99,102,241,0.3)',
                      }}
                    >
                      PRO FEATURE
                    </span>
                  )}
                </div>
              </button>
            ) : (
              <div style={{ borderRadius: 8, border: '1px solid var(--ap-border)', overflow: 'hidden' }}>
                <div
                  style={{
                    background: 'var(--ap-bg-elevated)',
                    padding: '8px 16px',
                    borderBottom: '1px solid var(--ap-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ap-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FileText size={12} style={{ color: 'var(--ap-accent)' }} /> Deep Dive Protocol
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--ap-text-muted)', fontFamily: 'JetBrains Mono, monospace', display: 'flex', alignItems: 'center', gap: 8 }}>
                    270 WORDS | AI-GENERATED
                    {item.groundingUsed && (
                      <span style={{ color: 'var(--ap-bull)', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', padding: '2px 6px', borderRadius: 4, fontSize: 10 }}>
                        GROUNDED
                      </span>
                    )}
                    {item.deepDiveMode && item.deepDiveMode !== 'live' && (
                      <span style={{ color: item.deepDiveMode === 'simulation' ? 'var(--ap-warn)' : 'var(--ap-bear)' }}>
                        {item.deepDiveMode.toUpperCase()}
                      </span>
                    )}
                  </span>
                </div>

                <div style={{ padding: 20, fontSize: 13, color: 'var(--ap-text-secondary)', lineHeight: 1.8, borderBottom: '1px solid var(--ap-border)', whiteSpace: 'pre-wrap' }}>
                  {item.deepDiveNotice && (
                    <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: 'var(--ap-warn)' }}>
                      {item.deepDiveNotice}
                    </div>
                  )}
                  {item.deepDive.content.split('**').map((part, index) => {
                    if (index % 2 === 1) {
                      return (
                        <span key={index} style={{ display: 'block', color: 'var(--ap-accent)', fontWeight: 700, marginTop: 16, marginBottom: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                          {part}
                        </span>
                      );
                    }

                    return <span key={index}>{part}</span>;
                  })}

                  {item.groundingUsed && item.groundingSources && item.groundingSources.length > 0 && (
                    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--ap-border)' }}>
                      <h5 style={{ fontSize: 10, fontWeight: 700, color: 'var(--ap-text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        <Globe size={12} style={{ color: 'var(--ap-bull)' }} />
                        Real-Time Verified Sources
                      </h5>
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {item.groundingSources.map((source, index) => (
                          <li key={index} style={{ display: 'flex', flexDirection: 'column' }}>
                            <a href={source.uri} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--ap-accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {source.title || source.uri}
                            </a>
                            <span style={{ fontSize: 10, color: 'var(--ap-text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                              {new URL(source.uri).hostname}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div style={{ padding: 20, background: 'var(--ap-bg)' }}>
                  <div style={{ display: 'flex', gap: 10, marginBottom: 24, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: 12 }}>
                    <AlertOctagon size={16} style={{ color: 'var(--ap-warn)', flexShrink: 0, marginTop: 2 }} />
                    <p style={{ fontSize: 11, color: 'rgba(245,158,11,0.8)', lineHeight: 1.5, margin: 0 }}>
                      <strong style={{ display: 'block', color: 'var(--ap-warn)', marginBottom: 4 }}>DISCLAIMER: NOT INVESTMENT ADVICE</strong>
                      The following scenarios are AI-generated probability models based on historical correlations. They do not account for your personal financial situation. Capital at risk.
                    </p>
                  </div>

                  <h4 style={{ fontSize: 12, fontWeight: 700, color: 'var(--ap-text-secondary)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Activity size={16} style={{ color: '#a78bfa' }} />
                    STRATEGIC POSITIONS
                  </h4>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {item.deepDive.scenarios.map((scenario: TradingScenario, index: number) => (
                      <div
                        key={index}
                        style={{
                          background: 'var(--ap-bg-elevated)',
                          border: '1px solid var(--ap-border)',
                          borderRadius: 8,
                          padding: 12,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 12,
                          alignItems: 'center',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 12px',
                            borderRadius: 6,
                            fontWeight: 700,
                            fontSize: 11,
                            border: '1px solid',
                            flexShrink: 0,
                            ...getDirectionStyle(scenario.direction),
                          }}
                        >
                          {getDirectionIcon(scenario.direction)}
                          {scenario.direction}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                            <span style={{ color: 'var(--ap-text-heading)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: 13 }}>
                              {scenario.asset}
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                border: '1px solid',
                                padding: '1px 5px',
                                borderRadius: 4,
                                color: getRiskColor(scenario.risk),
                                borderColor: getRiskColor(scenario.risk),
                              }}
                            >
                              RISK: {scenario.risk}
                            </span>
                          </div>
                          <p style={{ fontSize: 12, color: 'var(--ap-text-muted)', lineHeight: 1.4, margin: 0 }}>
                            {scenario.rationale}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <p style={{ fontSize: 10, color: 'var(--ap-text-muted)', textAlign: 'center', marginTop: 24 }}>
                    System generated decision-support content. Paper/simulation scenarios are not investment advice.
                  </p>
                </div>

                <div
                  style={{
                    padding: '8px 16px',
                    borderTop: '1px solid var(--ap-border)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    background: 'var(--ap-bg)',
                  }}
                >
                  <button
                    onClick={handleExport}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ap-text-muted)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.15s' }}
                    onMouseEnter={(event) => {
                      (event.currentTarget as HTMLButtonElement).style.color = 'var(--ap-text-heading)';
                    }}
                    onMouseLeave={(event) => {
                      (event.currentTarget as HTMLButtonElement).style.color = 'var(--ap-text-muted)';
                    }}
                  >
                    <Share2 size={12} /> Export PDF
                  </button>
                </div>
                {exportError && (
                  <div style={{ padding: '8px 16px', borderTop: '1px solid var(--ap-border)', color: 'var(--ap-bear)', fontSize: 11 }}>
                    {exportError}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {exportJobId && <ExportProgressToast jobId={exportJobId} onClose={() => setExportJobId(null)} />}
    </div>
  );
};

export default NewsCard;
