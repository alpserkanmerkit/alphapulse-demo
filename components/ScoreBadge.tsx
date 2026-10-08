import React from 'react';

interface ScoreBadgeProps {
  score: number;
}

const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score }) => {
  const getStyle = (): React.CSSProperties => {
    if (score >= 80) return {
      color: 'var(--ap-bear)',
      borderColor: 'var(--ap-bear)',
      boxShadow: '0 0 10px rgba(239,68,68,0.4)',
    };
    if (score >= 50) return {
      color: 'var(--ap-warn)',
      borderColor: 'var(--ap-warn)',
    };
    if (score > 0) return {
      color: 'var(--ap-bull)',
      borderColor: 'var(--ap-bull)',
    };
    return {
      color: 'var(--ap-text-muted)',
      borderColor: 'var(--ap-border)',
    };
  };

  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 48,
      height: 48,
      borderRadius: '50%',
      border: '2px solid',
      fontFamily: 'JetBrains Mono, monospace',
      fontWeight: 700,
      fontSize: 16,
      background: 'var(--ap-bg)',
      flexShrink: 0,
      ...getStyle(),
    }}>
      {score}
      {score >= 80 && (
        <span style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 12,
          height: 12,
        }}>
          <span style={{
            position: 'absolute',
            display: 'inline-flex',
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            background: 'var(--ap-bear)',
            opacity: 0.75,
            animation: 'ping 1.5s cubic-bezier(0,0,0.2,1) infinite',
          }} />
          <span style={{
            position: 'relative',
            display: 'inline-flex',
            borderRadius: '50%',
            width: 12,
            height: 12,
            background: 'var(--ap-bear)',
          }} />
        </span>
      )}
    </div>
  );
};

export default ScoreBadge;