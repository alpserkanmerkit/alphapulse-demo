import React, { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import apiClient, { getApiErrorMessage } from '../../utils/apiClient';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../../shared/demoAccount';

// `npm run demo` starts Vite with VITE_DEMO_MODE=1: the UI signs in automatically with the public demo account.
const IS_DEMO_UI = import.meta.env.VITE_DEMO_MODE === '1';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const setAuth = useAuthStore((state) => state.setAuth);
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState(IS_DEMO_UI ? DEMO_EMAIL : '');
    const [password, setPassword] = useState(IS_DEMO_UI ? DEMO_PASSWORD : '');
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (isAuthenticated) return;
        try {
            const stored = window.sessionStorage.getItem('alphapulse-auth');
            const parsed = stored ? JSON.parse(stored) : null;
            const state = parsed?.state;
            if (state?.isAuthenticated && state.token && state.user) {
                setAuth(state.token, state.user);
            }
        } catch {
            // Invalid persisted auth should fall through to the login form.
        }
    }, [isAuthenticated, setAuth]);

    useEffect(() => {
        if (!IS_DEMO_UI || isAuthenticated) return;
        let cancelled = false;
        apiClient.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD })
            .then((response) => {
                if (!cancelled && response.data.success) setAuth(response.data.token, response.data.user);
            })
            .catch(() => {
                // If auto-login fails, the form stays open, prefilled with the demo credentials.
            });
        return () => {
            cancelled = true;
        };
    }, [isAuthenticated, setAuth]);

    if (isAuthenticated) {
        return <>{children}</>;
    }

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            if (!isLogin) {
                // The register response is uniform (account enumeration guard) and carries no token; sign in with the same credentials.
                await apiClient.post('/api/auth/register', { email, password, name });
            }
            const response = await apiClient.post('/api/auth/login', { email, password });
            if (response.data.success) {
                setAuth(response.data.token, response.data.user);
            }
        } catch (submitError) {
            setError(getApiErrorMessage(submitError, 'Authentication failed. Access denied.'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={styles.container}>
            <div style={styles.terminalBox}>
                <div style={styles.header}>
                    <span>ALPHAPULSE_TERMINAL v6.0</span>
                    <span>[ENCRYPTED]</span>
                </div>

                <div style={styles.content}>
                    <p style={styles.prompt}><span style={styles.blink}>_</span> Awaiting credentials...</p>
                    {error && <div style={styles.errorBox}>[ERROR] {error}</div>}

                    <form onSubmit={handleSubmit} style={styles.form}>
                        {!isLogin && (
                            <label style={styles.inputGroup}>
                                <span style={styles.label}>&gt; IDENTIFIER</span>
                                <input style={styles.input} value={name} onChange={(event) => setName(event.target.value)} required={!isLogin} />
                            </label>
                        )}
                        <label style={styles.inputGroup}>
                            <span style={styles.label}>&gt; UPLINK</span>
                            <input style={styles.input} value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
                        </label>
                        <label style={styles.inputGroup}>
                            <span style={styles.label}>&gt; CIPHER</span>
                            <input style={styles.input} value={password} onChange={(event) => setPassword(event.target.value)} type="password" required />
                        </label>

                        <button type="submit" style={{ ...styles.button, ...(isLoading ? styles.buttonDisabled : {}) }} disabled={isLoading}>
                            {isLoading ? '[PROCESSING...]' : isLogin ? '[INITIATE UPLINK]' : '[REGISTER CREDENTIALS]'}
                        </button>
                    </form>

                    <p style={styles.switchText}>
                        {isLogin ? 'No credentials?' : 'Existing operative?'}{' '}
                        <button type="button" style={styles.switchButton} onClick={() => setIsLogin((value) => !value)}>
                            {isLogin ? 'Request clearance' : 'Initiate uplink'}
                        </button>
                    </p>
                </div>
            </div>
            <div style={styles.scanline} />
            <style>{'@keyframes terminalBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }'}</style>
        </div>
    );
};

const styles: Record<string, React.CSSProperties> = {
    container: {
        width: '100vw',
        height: '100vh',
        backgroundColor: '#0a0a0c',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '"JetBrains Mono", "Courier New", monospace',
        color: '#f5a623',
        position: 'relative',
        overflow: 'hidden',
    },
    terminalBox: {
        width: 'min(450px, calc(100vw - 32px))',
        border: '1px solid #f5a623',
        backgroundColor: '#050505',
        padding: 2,
        position: 'relative',
        zIndex: 10,
        boxShadow: '0 0 10px rgba(245, 166, 35, 0.1)',
    },
    header: {
        backgroundColor: '#f5a623',
        color: '#000',
        padding: '5px 10px',
        display: 'flex',
        justifyContent: 'space-between',
        fontWeight: 700,
        fontSize: 12,
        textTransform: 'uppercase',
    },
    content: { padding: 30 },
    prompt: { margin: '0 0 20px', fontSize: 14 },
    blink: { animation: 'terminalBlink 1s step-end infinite' },
    errorBox: {
        border: '1px solid #ff3333',
        color: '#ff3333',
        padding: 10,
        marginBottom: 20,
        fontSize: 12,
        backgroundColor: 'rgba(255, 51, 51, 0.05)',
    },
    form: { display: 'flex', flexDirection: 'column', gap: 20 },
    inputGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
    label: { fontSize: 12, fontWeight: 700 },
    input: {
        backgroundColor: 'transparent',
        border: 'none',
        borderBottom: '1px solid #f5a623',
        color: '#f5a623',
        fontFamily: 'inherit',
        fontSize: 16,
        padding: '5px 0',
        outline: 'none',
    },
    button: {
        backgroundColor: 'transparent',
        border: '1px solid #f5a623',
        color: '#f5a623',
        fontFamily: 'inherit',
        padding: 12,
        marginTop: 10,
        cursor: 'pointer',
        fontWeight: 700,
    },
    buttonDisabled: { opacity: 0.5, cursor: 'not-allowed' },
    switchText: { marginTop: 25, fontSize: 12, textAlign: 'center', opacity: 0.8 },
    switchButton: {
        color: '#f5a623',
        background: 'transparent',
        border: 'none',
        textDecoration: 'underline',
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: 700,
        padding: 0,
    },
    scanline: {
        position: 'absolute',
        inset: 0,
        background: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%)',
        backgroundSize: '100% 4px',
        pointerEvents: 'none',
        zIndex: 20,
        opacity: 0.3,
    },
};
