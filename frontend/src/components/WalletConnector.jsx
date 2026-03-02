/**
 * Wallet Connector Component
 * Apple-style glassmorphism UI for hybrid wallet connection
 * Supports both NWC (Alby/BlueWallet) and Escrow (WoS/Phoenix) modes
 */

import React, { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import './WalletConnector.css';

const WalletConnector = ({ apiBaseUrl, onWalletConnected, userToken }) => {
  const [step, setStep] = useState('detect'); // detect, connecting, connected, error
  const [lnAddress, setLnAddress] = useState('');
  const [nwcUri, setNwcUri] = useState('');
  const [walletInfo, setWalletInfo] = useState(null);
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Auto-detect wallet type from LN address
  const detectWalletType = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${apiBaseUrl}/api/wallet/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lnAddress })
      });
      
      const data = await response.json();
      setWalletInfo(data);
      
      if (data.supportsNWC) {
        setStep('connect_nwc');
      } else {
        setStep('deposit_escrow');
      }
    } catch (err) {
      setError('Failed to detect wallet type. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Connect NWC wallet
  const connectNWC = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${apiBaseUrl}/api/wallet/nwc/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userToken}`
        },
        body: JSON.stringify({ 
          nwcUri,
          budgetSats: 100000 // 100k sats daily budget
        })
      });
      
      if (!response.ok) throw new Error('NWC connection failed');
      
      const data = await response.json();
      setStep('connected');
      
      // Fetch initial balance
      await fetchBalance();
      
      if (onWalletConnected) {
        onWalletConnected({
          type: 'nwc',
          lnAddress,
          ...data
        });
      }
    } catch (err) {
      setError('Failed to connect NWC wallet. Please check your connection URI.');
    } finally {
      setLoading(false);
    }
  };

  // Fetch balance
  const fetchBalance = async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/wallet/balance`, {
        headers: { 'Authorization': `Bearer ${userToken}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        setBalance(data);
      }
    } catch (err) {
      console.error('Failed to fetch balance:', err);
    }
  };

  // Switch to escrow mode
  const switchToEscrow = () => {
    setStep('deposit_escrow');
    setWalletInfo(prev => ({
      ...prev,
      recommendedMode: 'escrow'
    }));
  };

  // Render based on step
  const renderContent = () => {
    switch (step) {
      case 'detect':
        return (
          <div className="wallet-step">
            <div className="wallet-icon">⚡</div>
            <h2>Connect Your Lightning Wallet</h2>
            <p>Enter your Lightning Address to get started</p>
            
            <div className="input-group">
              <input
                type="text"
                placeholder="satoshi@getalby.com"
                value={lnAddress}
                onChange={(e) => setLnAddress(e.target.value)}
                className="glass-input"
              />
              <button 
                onClick={detectWalletType}
                disabled={!lnAddress.includes('@') || loading}
                className="glass-button primary"
              >
                {loading ? <span className="spinner" /> : 'Continue'}
              </button>
            </div>
            
            <div className="wallet-hints">
              <span className="hint">💡 Supports: Alby, BlueWallet, WoS, Phoenix, Blixt</span>
            </div>
          </div>
        );
        
      case 'connect_nwc':
        return (
          <div className="wallet-step">
            <div className="wallet-badge nwc">⚡ NWC Enabled</div>
            <h2>Your Wallet Supports Instant P2P!</h2>
            <p className="wallet-desc">
              <strong>{walletInfo?.lnAddress}</strong> supports Nostr Wallet Connect (NWC). 
              This means instant, fee-less payments during gameplay!
            </p>
            
            <div className="nwc-instructions">
              <ol>
                <li>Open your wallet (Alby, BlueWallet, etc.)</li>
                <li>Go to Settings → Nostr Wallet Connect</li>
                <li>Create a new connection</li>
                <li>Set daily budget to 100,000 sats</li>
                <li>Copy the connection URI and paste below</li>
              </ol>
            </div>
            
            <textarea
              placeholder="nostr+walletconnect://..."
              value={nwcUri}
              onChange={(e) => setNwcUri(e.target.value)}
              className="glass-textarea"
              rows={3}
            />
            
            <div className="button-group">
              <button 
                onClick={connectNWC}
                disabled={!nwcUri.startsWith('nostr+walletconnect://') || loading}
                className="glass-button primary"
              >
                {loading ? <span className="spinner" /> : 'Connect NWC Wallet'}
              </button>
              
              <button 
                onClick={switchToEscrow}
                className="glass-button secondary"
              >
                Use Escrow Instead
              </button>
            </div>
            
            <div className="security-note">
              🔒 Your NWC connection is encrypted with AES-256-GCM. 
              We never hold your keys.
            </div>
          </div>
        );
        
      case 'deposit_escrow':
        return (
          <EscrowDeposit 
            lnAddress={lnAddress}
            apiBaseUrl={apiBaseUrl}
            userToken={userToken}
            onDepositComplete={(data) => {
              setStep('connected');
              fetchBalance();
              if (onWalletConnected) {
                onWalletConnected({
                  type: 'escrow',
                  lnAddress,
                  ...data
                });
              }
            }}
          />
        );
        
      case 'connected':
        return (
          <div className="wallet-step connected">
            <div className="success-icon">✓</div>
            <h2>Wallet Connected!</h2>
            
            {balance && (
              <div className="balance-card glass">
                <div className="balance-header">
                  <span className="balance-label">Your Balance</span>
                  <span className={`wallet-type-badge ${balance.walletType}`}>
                    {balance.walletType === 'nwc' ? '⚡ NWC' : '🔒 Escrow'}
                  </span>
                </div>
                
                <div className="balance-amount">
                  {balance.walletType === 'nwc' ? (
                    <>
                      <span className="amount">{balance.nwc?.remaining?.toLocaleString()}</span>
                      <span className="unit">sats available (24h)</span>
                    </>
                  ) : (
                    <>
                      <span className="amount">{balance.escrow?.available?.toLocaleString()}</span>
                      <span className="unit">sats available</span>
                    </>
                  )}
                </div>
                
                {balance.walletType === 'escrow' && (
                  <div className="balance-breakdown">
                    <div className="breakdown-row">
                      <span>Total Balance</span>
                      <span>{balance.escrow.balance.toLocaleString()} sats</span>
                    </div>
                    <div className="breakdown-row">
                      <span>Locked in Games</span>
                      <span>{balance.escrow.locked.toLocaleString()} sats</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            <button 
              onClick={fetchBalance}
              className="glass-button secondary"
            >
              Refresh Balance
            </button>
          </div>
        );
        
      default:
        return null;
    }
  };

  return (
    <div className="wallet-connector glass-card">
      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      
      {renderContent()}
    </div>
  );
};

/**
 * Escrow Deposit Sub-component
 */
const EscrowDeposit = ({ lnAddress, apiBaseUrl, userToken, onDepositComplete }) => {
  const [amount, setAmount] = useState(10000);
  const [invoice, setInvoice] = useState(null);
  const [status, setStatus] = useState('input'); // input, pending, paid
  const [loading, setLoading] = useState(false);
  // Ref to track the active polling timer — cleared on unmount to prevent memory leaks
  const pollTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const createDeposit = async () => {
    setLoading(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/wallet/deposit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userToken}`
        },
        body: JSON.stringify({ amountSats: amount })
      });

      const data = await response.json();
      setInvoice(data);
      setStatus('pending');

      pollPaymentStatus(data.paymentHash);
    } catch (err) {
      console.error('Deposit error:', err);
    } finally {
      setLoading(false);
    }
  };

  const pollPaymentStatus = async (paymentHash) => {
    const checkStatus = async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/wallet/deposit/${paymentHash}`,
          { headers: { 'Authorization': `Bearer ${userToken}` } }
        );

        const data = await response.json();

        if (data.status === 'paid') {
          setStatus('paid');
          onDepositComplete({ amountSats: amount });
          return; // Stop polling — payment confirmed
        }
      } catch (err) {
        console.error('Status check error:', err);
      }

      // Schedule next check — stored in ref so it can be cancelled on unmount
      pollTimerRef.current = setTimeout(checkStatus, 2000);
    };

    checkStatus();
  };

  if (status === 'pending' && invoice) {
    return (
      <div className="wallet-step">
        <div className="wallet-badge escrow">🔒 Escrow Mode</div>
        <h2>Scan to Deposit</h2>
        
        <div className="qr-container glass">
          <QRCodeSVG
            value={invoice.invoice}
            size={200}
            level="M"
            includeMargin
            bgColor="#ffffff"
            fgColor="#000000"
          />
        </div>
        
        <div className="invoice-string">
          <code>{invoice.invoice.substring(0, 50)}...</code>
          <button 
            onClick={() => navigator.clipboard.writeText(invoice.invoice)}
            className="copy-button"
          >
            Copy
          </button>
        </div>
        
        <div className="payment-status">
          <span className="spinner" />
          Waiting for payment... {amount.toLocaleString()} sats
        </div>
        
        <p className="help-text">
          Open your Lightning wallet and scan this QR code to deposit.
          Funds will be held securely during gameplay.
        </p>
      </div>
    );
  }

  return (
    <div className="wallet-step">
      <div className="wallet-badge escrow">🔒 Escrow Mode</div>
      <h2>Deposit to Play</h2>
      
      <p className="wallet-desc">
        <strong>{lnAddress}</strong> works best with Escrow mode. 
        Deposit sats now to join games instantly.
      </p>
      
      <div className="preset-amounts">
        {[5000, 10000, 25000, 50000, 100000].map(preset => (
          <button
            key={preset}
            onClick={() => setAmount(preset)}
            className={`preset-button ${amount === preset ? 'active' : ''}`}
          >
            {preset.toLocaleString()}
          </button>
        ))}
      </div>
      
      <div className="input-group">
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className="glass-input"
          min={1000}
        />
        <span className="input-suffix">sats</span>
      </div>
      
      <button 
        onClick={createDeposit}
        disabled={amount < 1000 || loading}
        className="glass-button primary"
      >
        {loading ? <span className="spinner" /> : 'Create Deposit Invoice'}
      </button>
      
      <div className="security-note">
        🔒 Funds are held in a secure escrow. You can withdraw anytime.
      </div>
    </div>
  );
};

export default WalletConnector;
