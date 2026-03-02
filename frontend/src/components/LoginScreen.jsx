import React, { useState } from 'react';

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '20px'
  },
  card: {
    background: '#10102a',
    border: '1px solid #3a3a6a',
    borderRadius: '8px',
    padding: '40px',
    width: '100%',
    maxWidth: '400px'
  },
  title: {
    fontSize: '28px',
    color: '#f7931a',
    textAlign: 'center',
    marginBottom: '8px'
  },
  subtitle: {
    color: '#888',
    textAlign: 'center',
    marginBottom: '32px',
    fontSize: '13px'
  },
  field: {
    marginBottom: '16px'
  },
  label: {
    display: 'block',
    marginBottom: '6px',
    fontSize: '12px',
    color: '#aaa',
    textTransform: 'uppercase',
    letterSpacing: '0.05em'
  },
  btnPrimary: {
    background: '#f7931a',
    color: '#000',
    fontWeight: 'bold',
    width: '100%',
    padding: '12px',
    marginTop: '8px',
    fontSize: '15px'
  },
  btnSecondary: {
    background: 'transparent',
    color: '#f7931a',
    border: '1px solid #f7931a',
    width: '100%',
    padding: '10px',
    marginTop: '8px',
    fontSize: '14px'
  },
  error: {
    background: '#2a1010',
    border: '1px solid #f44',
    borderRadius: '4px',
    color: '#f88',
    padding: '10px 14px',
    marginBottom: '16px',
    fontSize: '13px'
  },
  divider: {
    borderTop: '1px solid #3a3a6a',
    margin: '24px 0',
    textAlign: 'center',
    position: 'relative'
  },
  dividerText: {
    background: '#10102a',
    color: '#666',
    fontSize: '12px',
    padding: '0 10px',
    position: 'relative',
    top: '-10px'
  },
  toggle: {
    textAlign: 'center',
    marginTop: '20px',
    fontSize: '13px',
    color: '#888'
  }
};

export default function LoginScreen({ onLogin }) {
  const [mode, setMode]         = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [lnAddress, setLnAddress] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let res;
      if (mode === 'login') {
        res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
      } else {
        if (!lnAddress.includes('@')) {
          setError('Please enter a valid Lightning address (user@domain.com)');
          setLoading(false);
          return;
        }
        res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, lnAddress })
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Authentication failed');
        return;
      }

      onLogin(data.token, data.user.id);
    } catch (err) {
      setError('Network error — is the server running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>⚡ Lightning Arena</h1>
        <p style={styles.subtitle}>
          {mode === 'login' ? 'Sign in to play' : 'Create your account'}
        </p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div style={styles.field}>
            <label style={styles.label}>Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="satoshi"
              required
              autoFocus
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          {mode === 'register' && (
            <div style={styles.field}>
              <label style={styles.label}>Lightning Address</label>
              <input
                type="text"
                value={lnAddress}
                onChange={e => setLnAddress(e.target.value)}
                placeholder="you@getalby.com"
                required
              />
            </div>
          )}

          <button type="submit" style={styles.btnPrimary} disabled={loading}>
            {loading ? 'Please wait…' : (mode === 'login' ? 'Sign In' : 'Create Account')}
          </button>
        </form>

        <div style={styles.toggle}>
          {mode === 'login' ? (
            <>
              No account?{' '}
              <a href="#" onClick={e => { e.preventDefault(); setMode('register'); setError(''); }}>
                Register
              </a>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <a href="#" onClick={e => { e.preventDefault(); setMode('login'); setError(''); }}>
                Sign In
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
