import React, { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen';
import LobbyScreen from './components/LobbyScreen';
import GameScreen from './components/GameScreen';

export default function App() {
  const [screen, setScreen] = useState('login');
  const [token, setToken]   = useState(null);
  const [userId, setUserId] = useState(null);
  const [gameId, setGameId] = useState(null);

  // Restore session from localStorage
  useEffect(() => {
    const savedToken  = localStorage.getItem('la_token');
    const savedUserId = localStorage.getItem('la_userId');
    if (savedToken && savedUserId) {
      setToken(savedToken);
      setUserId(savedUserId);
      setScreen('lobby');
    }
  }, []);

  function handleLogin(token, userId) {
    localStorage.setItem('la_token', token);
    localStorage.setItem('la_userId', userId);
    setToken(token);
    setUserId(userId);
    setScreen('lobby');
  }

  function handleLogout() {
    localStorage.removeItem('la_token');
    localStorage.removeItem('la_userId');
    setToken(null);
    setUserId(null);
    setGameId(null);
    setScreen('login');
  }

  function handleJoinGame(gId) {
    setGameId(gId);
    setScreen('game');
  }

  function handleLeaveGame() {
    setGameId(null);
    setScreen('lobby');
  }

  if (screen === 'login') {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (screen === 'lobby') {
    return (
      <LobbyScreen
        token={token}
        userId={userId}
        onJoinGame={handleJoinGame}
        onLogout={handleLogout}
      />
    );
  }

  if (screen === 'game') {
    return (
      <GameScreen
        token={token}
        userId={userId}
        gameId={gameId}
        onLeave={handleLeaveGame}
      />
    );
  }

  return null;
}
