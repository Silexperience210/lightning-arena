import React, { useState, useEffect, useCallback } from 'react';
import WalletConnector from './WalletConnector';

const styles = {
  container: {
    maxWidth: '800px',
    margin: '0 auto',
    padding: '20px'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid #3a3a6a',
    paddingBottom: '16px',
    marginBottom: '24px'
  },
  title: {
    color: '#f7931a',
    fontSize: '22px'
  },
  balance: {
    background: '#10102a',
    border: '1px solid #3a3a6a',
    borderRadius: '6px',
    padding: '8px 16px',
    fontSize: '13px',
    color: '#ccc'
  },
  balanceAmount: {
    color: '#f7931a',
    fontWeight: 'bold',
    fontSize: '16px'
  },
  btnLogout: {
    background: '#2a1010',
    color: '#f88',
    border: '1px solid #f44',
    borderRadius: '4px',
    padding: '8px 14px',
    fontSize: '12px'
  },
  section: {
    background: '#10102a',
    border: '1px solid #3a3a6a',
    borderRadius: '8px',
    padding: '20px',
    marginBottom: '20px'
  },
  sectionTitle: {
    color: '#aaa',
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '14px'
  },
  row: {
    display: 'flex',
    gap: '10px',
    alignItems: 'center'
  },
  input: {
    flex: 1
  },
  btnJoin: {
    background: '#1a6af7',
    color: '#fff',
    fontWeight: 'bold',
    padding: '10px 20px',
    whiteSpace: 'nowrap'
  },
  btnCreate: {
    background: '#f7931a',
    color: '#000',
    fontWeight: 'bold',
    padding: '10px 20px',
    width: '100%',
    marginTop: '10px'
  },
  formRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px',
    marginBottom: '10px'
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px'
  },
  label: {
    fontSize: '11px',
    color: '#888',
    textTransform: 'uppercase'
  },
  gameList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  gameItem: {
    background: '#0a0a1a',
    border: '1px solid #3a3a6a',
    borderRadius: '6px',
    padding: '12px 16px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  gameCode: {
    color: '#f7931a',
    fontWeight: 'bold',
    fontSize: '16px',
    letterSpacing: '0.1em'
  },
  gameInfo: {
    fontSize: '12px',
    color: '#888',
    marginTop: '2px'
  },
  btnJoinList: {
    background: '#1a6af7',
    color: '#fff',
    fontSize: '12px',
    padding: '6px 14px'
  },
  error: {
    color: '#f88',
    fontSize: '13px',
    marginTop: '8px'
  },
  success: {
    color: '#8f8',
    fontSize: '13px',
    marginTop: '8px'
  },
  empty: {
    color: '#555',
    fontSize: '13px',
    textAlign: 'center',
    padding: '20px 0'
  },
  accordionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    cursor: 'pointer',
    padding: '4px 0'
  },
  accordionToggle: {
    color: '#f7931a',
    fontSize: '12px'
  }
};

export default function LobbyScreen({ token, userId, onJoinGame, onLogout }) {
  const [balance, setBalance]       = useState(null);
  const [roomCode, setRoomCode]     = useState('');
  const [buyIn, setBuyIn]           = useState(10000);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [games, setGames]           = useState([]);
  const [joinError, setJoinError]   = useState('');
  const [createMsg, setCreateMsg]   = useState('');
  const [showWallet, setShowWallet] = useState(false);
  const [loadingJoin, setLoadingJoin]     = useState(false);
  const [loadingCreate, setLoadingCreate] = useState(false);

  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  const fetchBalance = useCallback(async () => {
    try {
      const res  = await fetch('/api/wallet/balance', { headers });
      if (!res.ok) return;
      const data = await res.json();
      setBalance(data.escrow?.available ?? 0);
      if (data.escrow?.available === 0) setShowWallet(true);
    } catch (_) {}
  }, [token]);

  const fetchGames = useCallback(async () => {
    try {
      const res  = await fetch('/api/games', { headers });
      if (!res.ok) return;
      const data = await res.json();
      setGames(data);
    } catch (_) {}
  }, [token]);

  useEffect(() => {
    fetchBalance();
    fetchGames();
    const balTimer  = setInterval(fetchBalance, 30000);
    const gameTimer = setInterval(fetchGames, 10000);
    return () => { clearInterval(balTimer); clearInterval(gameTimer); };
  }, [fetchBalance, fetchGames]);

  async function handleJoin(e) {
    e && e.preventDefault();
    if (!roomCode.trim()) return;
    setJoinError('');
    setLoadingJoin(true);
    try {
      const res  = await fetch(`/api/games/${roomCode.trim().toUpperCase()}/join`, {
        method: 'POST', headers
      });
      const data = await res.json();
      if (!res.ok) {
        setJoinError(data.error || 'Failed to join');
        return;
      }
      onJoinGame(data.gameId);
    } catch (_) {
      setJoinError('Network error');
    } finally {
      setLoadingJoin(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    setCreateMsg('');
    setLoadingCreate(true);
    try {
      const createRes  = await fetch('/api/games', {
        method: 'POST', headers,
        body: JSON.stringify({ buyInSats: Number(buyIn), maxPlayers: Number(maxPlayers) })
      });
      const createData = await createRes.json();
      if (!createRes.ok) {
        setCreateMsg('Error: ' + (createData.error || 'Failed to create game'));
        return;
      }
      // Auto-join as host
      const joinRes  = await fetch(`/api/games/${createData.roomCode}/join`, {
        method: 'POST', headers
      });
      const joinData = await joinRes.json();
      if (!joinRes.ok) {
        setCreateMsg('Game created! Code: ' + createData.roomCode + ' — join failed: ' + (joinData.error || ''));
        return;
      }
      onJoinGame(joinData.gameId || createData.gameId);
    } catch (_) {
      setCreateMsg('Network error');
    } finally {
      setLoadingCreate(false);
    }
  }

  async function handleJoinFromList(code) {
    setRoomCode(code);
    setJoinError('');
    setLoadingJoin(true);
    try {
      const res  = await fetch(`/api/games/${code}/join`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) { setJoinError(data.error || 'Failed to join'); return; }
      onJoinGame(data.gameId);
    } catch (_) {
      setJoinError('Network error');
    } finally {
      setLoadingJoin(false);
    }
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>⚡ Lightning Arena</h1>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={styles.balance}>
            Balance:{' '}
            <span style={styles.balanceAmount}>
              {balance === null ? '…' : `${balance.toLocaleString()} sats`}
            </span>
          </div>
          <button style={styles.btnLogout} onClick={onLogout}>Logout</button>
        </div>
      </div>

      {/* Wallet connector (if balance is 0) */}
      {balance === 0 && (
        <div style={styles.section}>
          <div
            style={styles.accordionHeader}
            onClick={() => setShowWallet(v => !v)}
          >
            <span style={styles.sectionTitle}>Connect Wallet / Deposit</span>
            <span style={styles.accordionToggle}>{showWallet ? '▲ Hide' : '▼ Show'}</span>
          </div>
          {showWallet && <WalletConnector token={token} onBalanceUpdate={fetchBalance} />}
        </div>
      )}

      {/* Join game */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Join a Game</div>
        <form onSubmit={handleJoin}>
          <div style={styles.row}>
            <div style={styles.input}>
              <input
                type="text"
                value={roomCode}
                onChange={e => setRoomCode(e.target.value.toUpperCase())}
                placeholder="Room code (e.g. ABCD12)"
                maxLength={8}
              />
            </div>
            <button type="submit" style={styles.btnJoin} disabled={loadingJoin}>
              {loadingJoin ? '…' : 'Join'}
            </button>
          </div>
          {joinError && <div style={styles.error}>{joinError}</div>}
        </form>
      </div>

      {/* Create game */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Create a Game</div>
        <form onSubmit={handleCreate}>
          <div style={styles.formRow}>
            <div style={styles.field}>
              <label style={styles.label}>Buy-in (sats)</label>
              <input
                type="number"
                value={buyIn}
                onChange={e => setBuyIn(e.target.value)}
                min={100}
                step={100}
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Max players</label>
              <select value={maxPlayers} onChange={e => setMaxPlayers(e.target.value)}>
                <option value={2}>2</option>
                <option value={4}>4</option>
                <option value={8}>8</option>
              </select>
            </div>
          </div>
          <button type="submit" style={styles.btnCreate} disabled={loadingCreate}>
            {loadingCreate ? 'Creating…' : 'Create & Join'}
          </button>
          {createMsg && (
            <div style={createMsg.startsWith('Error') ? styles.error : styles.success}>
              {createMsg}
            </div>
          )}
        </form>
      </div>

      {/* Open lobby games */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Open Games ({games.length})</div>
        <div style={styles.gameList}>
          {games.length === 0 && (
            <div style={styles.empty}>No open games. Create one!</div>
          )}
          {games.map(g => (
            <div key={g.id} style={styles.gameItem}>
              <div>
                <div style={styles.gameCode}>{g.room_code}</div>
                <div style={styles.gameInfo}>
                  {g.buy_in_sats?.toLocaleString()} sats · {g.game_mode || 'ffa'} · max {g.max_players}
                </div>
              </div>
              <button
                style={styles.btnJoinList}
                onClick={() => handleJoinFromList(g.room_code)}
              >
                Join
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
