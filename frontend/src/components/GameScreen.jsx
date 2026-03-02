import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import './GameHUD.css';

function randomDamage() {
  return Math.floor(Math.random() * 91) + 10; // 10–100
}

export default function GameScreen({ token, userId, gameId, onLeave }) {
  const [participants, setParticipants] = useState([]);
  const [targetId, setTargetId]         = useState('');
  const [log, setLog]                   = useState([]);
  const [gameResult, setGameResult]     = useState(null); // {won, payout, fee}
  const [hitFlash, setHitFlash]         = useState(false);
  const [connected, setConnected]       = useState(false);
  const socketRef = useRef(null);
  const logRef    = useRef(null);

  function addLog(entry) {
    setLog(prev => [entry, ...prev].slice(0, 100));
  }

  const setupSocket = useCallback(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('auth', token);
    });

    socket.on('auth:success', () => {
      socket.emit('game:join', gameId);
      addLog({ type: 'joined', text: 'Connected to game room.' });
    });

    socket.on('auth:error', () => {
      addLog({ type: 'error', text: 'Authentication failed.' });
    });

    socket.on('game:state_restored', ({ participants: parts }) => {
      if (parts) setParticipants(parts);
      addLog({ type: 'joined', text: 'Game state restored after reconnection.' });
    });

    socket.on('game:started', ({ playerCount }) => {
      addLog({ type: 'joined', text: `Game started! ${playerCount} players.` });
    });

    socket.on('game:hit', ({ hitterId, victimId, weapon, damage }) => {
      if (victimId === userId) {
        setHitFlash(true);
        setTimeout(() => setHitFlash(false), 500);
      }
      addLog({
        type: 'damage',
        text: `${hitterId === userId ? 'You' : hitterId.slice(0,8)} hit ${victimId === userId ? 'you' : victimId.slice(0,8)} for ${damage} with ${weapon}`
      });
    });

    socket.on('player:joined', ({ username }) => {
      addLog({ type: 'joined', text: `${username} joined the game.` });
    });

    socket.on('player:disconnected', ({ userId: uid }) => {
      setParticipants(prev =>
        prev.map(p => p.user_id === uid ? { ...p, status: 'disconnected' } : p)
      );
      addLog({ type: 'error', text: `Player ${uid.slice(0,8)} disconnected.` });
    });

    socket.on('player:reconnected', ({ userId: uid }) => {
      setParticipants(prev =>
        prev.map(p => p.user_id === uid ? { ...p, status: 'active' } : p)
      );
      addLog({ type: 'joined', text: `Player ${uid.slice(0,8)} reconnected.` });
    });

    socket.on('player:eliminated', ({ userId: uid }) => {
      setParticipants(prev =>
        prev.map(p => p.user_id === uid ? { ...p, status: 'eliminated' } : p)
      );
      addLog({ type: 'error', text: `${uid === userId ? 'You were' : uid.slice(0,8) + ' was'} eliminated.` });
    });

    socket.on('payment:completed', ({ transferId, amount }) => {
      addLog({ type: 'payment', text: `Payment completed: ${amount} sats (tx: ${transferId?.slice(0,8)})` });
    });

    socket.on('game:ended', ({ winnerId, winnerPayout, serverFee }) => {
      const won = winnerId === userId;
      setGameResult({ won, payout: winnerPayout, fee: serverFee });
      addLog({
        type: won ? 'joined' : 'error',
        text: won
          ? `You won! Payout: ${winnerPayout} sats`
          : `Game over. Winner: ${winnerId.slice(0,8)} (${winnerPayout} sats)`
      });
    });

    socket.on('error', ({ message }) => {
      addLog({ type: 'error', text: `Error: ${message}` });
    });

    socket.on('disconnect', () => {
      setConnected(false);
      addLog({ type: 'error', text: 'Disconnected from server.' });
    });
  }, [token, gameId, userId]);

  useEffect(() => {
    // Fetch initial game state
    fetch(`/api/games/${gameId}/state`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.participants) setParticipants(data.participants);
      })
      .catch(() => {});

    setupSocket();

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [gameId, token, setupSocket]);

  function handleHit() {
    if (!targetId || !socketRef.current) return;
    const damage = randomDamage();
    socketRef.current.emit('game:hit', {
      gameId,
      hitterId: userId,
      victimId: targetId,
      weapon: 'sword',
      damage
    });
  }

  function handleLeave() {
    if (socketRef.current) socketRef.current.disconnect();
    onLeave();
  }

  const activePlayers = participants.filter(p => p.user_id !== userId && p.status === 'active');

  return (
    <div className="game-screen">
      <div className="game-header">
        <div>
          <div className="game-title">⚡ Game Room</div>
          <div className="game-status">
            {connected ? '● Connected' : '○ Connecting…'} · Game {gameId.slice(0, 8)}
          </div>
        </div>
        <button className="btn-leave" onClick={handleLeave}>Leave Game</button>
      </div>

      <div className="hud-layout">
        {/* Players panel */}
        <div className={`panel${hitFlash ? ' hit-received' : ''}`}>
          <div className="panel-title">Players ({participants.length})</div>
          {participants.length === 0 && (
            <div style={{ color: '#555', fontSize: '13px' }}>Waiting for players…</div>
          )}
          {participants.map(p => (
            <div key={p.user_id} className="player-item">
              <div>
                <div className={`player-name${p.user_id === userId ? ' me' : ''}`}>
                  {p.player_name || p.user_id.slice(0, 10)}
                  {p.user_id === userId && ' (you)'}
                </div>
                <div className="player-balance">
                  {p.initial_balance?.toLocaleString()} sats
                </div>
              </div>
              <span className={`player-status ${p.status}`}>{p.status}</span>
            </div>
          ))}
        </div>

        {/* Hit controls */}
        <div className="panel">
          <div className="panel-title">Attack</div>
          <div className="target-select">
            <select
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
            >
              <option value="">— Select target —</option>
              {activePlayers.map(p => (
                <option key={p.user_id} value={p.user_id}>
                  {p.player_name || p.user_id.slice(0, 10)}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn-hit"
            onClick={handleHit}
            disabled={!targetId || !connected}
          >
            HIT ⚔
          </button>
          {activePlayers.length === 0 && (
            <div style={{ color: '#555', fontSize: '12px', marginTop: '10px', textAlign: 'center' }}>
              No targets available
            </div>
          )}
        </div>

        {/* Event log (full width) */}
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="panel-title">Event Log</div>
          <div className="event-log" ref={logRef}>
            {log.length === 0 && (
              <div style={{ color: '#444' }}>No events yet.</div>
            )}
            {log.map((entry, i) => (
              <div key={i} className="log-entry">
                <span className={entry.type}>{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Game ended overlay */}
      {gameResult && (
        <div className="game-ended-overlay">
          <div className={`result-card ${gameResult.won ? 'winner' : 'loser'}`}>
            <div className="result-icon">{gameResult.won ? '🏆' : '💀'}</div>
            <div className="result-title">
              {gameResult.won ? 'Victory!' : 'Eliminated'}
            </div>
            {gameResult.won && (
              <div className="result-payout">
                +{gameResult.payout?.toLocaleString()} sats
                {gameResult.fee > 0 && (
                  <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                    (server fee: {gameResult.fee} sats)
                  </div>
                )}
              </div>
            )}
            <button className="btn-back" onClick={handleLeave}>
              Back to Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
