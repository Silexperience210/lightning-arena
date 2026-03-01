// Lightning Arena - Frontend Application
const API_URL = window.location.origin;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initParticles();
    loadStats();
    initAmountSelector();
    
    // Auto-load victory.json if pasted
    const victoryJson = document.getElementById('victory-json');
    if (victoryJson) {
        victoryJson.addEventListener('paste', handlePaste);
    }
});

// Particle Animation
function initParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    
    for (let i = 0; i < 50; i++) {
        const particle = document.createElement('div');
        particle.style.cssText = `
            position: absolute;
            width: ${Math.random() * 4}px;
            height: ${Math.random() * 4}px;
            background: rgba(247, 147, 26, ${Math.random() * 0.5});
            border-radius: 50%;
            left: ${Math.random() * 100}%;
            top: ${Math.random() * 100}%;
            animation: float ${10 + Math.random() * 20}s infinite ease-in-out;
        `;
        container.appendChild(particle);
    }
}

// Amount Selector
function initAmountSelector() {
    const buttons = document.querySelectorAll('.amount-btn');
    const input = document.getElementById('amount');
    
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (input) input.value = btn.dataset.amount;
        });
    });
}

// Load Statistics
async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/api/stats`);
        const data = await response.json();
        
        animateValue('total-games', 0, data.totalGames || 0, 1000);
        animateValue('total-sats', 0, data.totalSatsInGame || 0, 1000);
        animateValue('active-players', 0, data.totalDeposits || 0, 1000);
    } catch (err) {
        console.log('Stats not available');
    }
}

// Animate Number
function animateValue(id, start, end, duration) {
    const obj = document.getElementById(id);
    if (!obj) return;
    
    const range = end - start;
    const minTimer = 50;
    let stepTime = Math.abs(Math.floor(duration / range));
    stepTime = Math.max(stepTime, minTimer);
    
    let startTime = new Date().getTime();
    let endTime = startTime + duration;
    let timer;
    
    function run() {
        let now = new Date().getTime();
        let remaining = Math.max((endTime - now) / duration, 0);
        let value = Math.round(end - (remaining * range));
        obj.innerHTML = value.toLocaleString();
        if (value == end) clearInterval(timer);
    }
    
    timer = setInterval(run, stepTime);
    run();
}

// Create Deposit
async function createDeposit() {
    const lnAddress = document.getElementById('ln-address').value;
    const amount = document.getElementById('amount').value;
    
    if (!lnAddress || !amount) {
        showError('Please fill in all fields');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/deposit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lnAddress, amount: parseInt(amount) })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showInvoice(data);
        } else {
            showError(data.error || 'Failed to create deposit');
        }
    } catch (err) {
        showError('Network error');
    }
}

// Show Invoice
function showInvoice(data) {
    const resultBox = document.getElementById('invoice-result');
    const invoiceText = document.getElementById('invoice-text');
    
    if (resultBox && invoiceText) {
        resultBox.classList.remove('hidden');
        invoiceText.textContent = data.paymentRequest || 'Invoice: ' + data.ticketId;
        
        // Scroll to result
        resultBox.scrollIntoView({ behavior: 'smooth' });
    }
}

// Copy Invoice
function copyInvoice() {
    const text = document.getElementById('invoice-text')?.textContent;
    if (text) {
        navigator.clipboard.writeText(text).then(() => {
            showSuccess('Copied to clipboard!');
        });
    }
}

// Handle Paste (auto-format JSON)
function handlePaste(e) {
    setTimeout(() => {
        const textarea = e.target;
        try {
            const json = JSON.parse(textarea.value);
            textarea.value = JSON.stringify(json, null, 2);
        } catch (err) {
            // Not valid JSON, leave as-is
        }
    }, 0);
}

// Validate Victory
async function validateVictory() {
    const jsonText = document.getElementById('victory-json').value;
    const resultBox = document.getElementById('validation-result');
    
    if (!jsonText) {
        showError('Please paste your victory.json content');
        return;
    }
    
    try {
        const victoryData = JSON.parse(jsonText);
        
        // Show loading
        if (resultBox) {
            resultBox.classList.remove('hidden');
            resultBox.innerHTML = '<p>Validating...</p>';
        }
        
        // First, check if auto-withdrawal is available
        const checkResponse = await fetch(`${API_URL}/api/check-withdrawal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticketId: victoryData.ticket_id })
        });
        
        const checkData = await checkResponse.json();
        
        // Show result
        if (resultBox) {
            let html = '';
            
            if (checkData.canAutoWithdraw) {
                html += `
                    <div style="background: #e8f5e9; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
                        <h3 style="color: #2e7d32;">⚡ Auto-Withdrawal Available!</h3>
                        <p>Your deposit address: <code>${checkData.lnAddress}</code></p>
                        <button class="btn btn-primary" onclick="withdraw('${victoryData.ticket_id}', null)" style="margin-top: 12px;">
                            Confirm Auto-Withdrawal (${victoryData.sats} sats)
                        </button>
                    </div>
                `;
            }
            
            html += `
                <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 12px;">
                    <h3>Manual Withdrawal</h3>
                    <input type="text" id="manual-ln-address" placeholder="your@wallet.com or lnbc1..." 
                           class="input" style="margin: 12px 0;">
                    <button class="btn btn-secondary" onclick="withdraw('${victoryData.ticket_id}', document.getElementById('manual-ln-address').value)">
                        Withdraw to Different Address
                    </button>
                </div>
            `;
            
            resultBox.innerHTML = html;
        }
        
    } catch (err) {
        showError('Invalid JSON format');
    }
}

// Withdraw
async function withdraw(ticketId, lnAddress) {
    const resultBox = document.getElementById('validation-result');
    const jsonText = document.getElementById('victory-json').value;
    
    try {
        const victoryData = JSON.parse(jsonText);
        
        if (resultBox) {
            resultBox.innerHTML = '<p>Processing withdrawal...</p>';
        }
        
        const response = await fetch(`${API_URL}/api/withdraw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ victoryData, lnAddress })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            if (resultBox) {
                resultBox.innerHTML = `
                    <div style="background: #e8f5e9; padding: 24px; border-radius: 12px; text-align: center;">
                        <h2 style="color: #2e7d32; margin-bottom: 16px;">✅ Success!</h2>
                        <p>${data.message || `${data.amount} sats sent!`}</p>
                        <p style="margin-top: 12px; font-size: 14px; opacity: 0.7;">
                            ${data.autoWithdrawal ? 'Auto-withdrawal completed' : 'Manual withdrawal completed'}
                        </p>
                    </div>
                `;
            }
        } else {
            throw new Error(data.error || 'Withdrawal failed');
        }
    } catch (err) {
        if (resultBox) {
            resultBox.innerHTML = `
                <div style="background: #ffebee; padding: 24px; border-radius: 12px;">
                    <h3 style="color: #d32f2f;">❌ Error</h3>
                    <p>${err.message}</p>
                </div>
            `;
        }
    }
}

// UI Helpers
function showDeposit() {
    document.getElementById('play')?.scrollIntoView({ behavior: 'smooth' });
}

function showValidate() {
    document.getElementById('validate')?.scrollIntoView({ behavior: 'smooth' });
}

function showDocs() {
    alert('API Documentation:\n\n' +
          'POST /api/deposit - Create deposit ticket\n' +
          'POST /api/withdraw - Withdraw winnings\n' +
          'POST /api/validate - Validate victory\n' +
          'GET  /api/stats - Server statistics');
}

function showTerms() {
    alert('Terms of Service:\n\n' +
          '1. Minimum deposit: 1000 sats\n' +
          '2. 7-day reconnect window\n' +
          '3. Auto-withdrawal to deposit address\n' +
          '4. Server-authoritative gameplay');
}

function showError(msg) {
    alert('Error: ' + msg);
}

function showSuccess(msg) {
    alert('Success: ' + msg);
}

// CSS Animation for particles
const style = document.createElement('style');
style.textContent = `
    @keyframes float {
        0%, 100% { transform: translateY(0) translateX(0); }
        25% { transform: translateY(-20px) translateX(10px); }
        50% { transform: translateY(-10px) translateX(-10px); }
        75% { transform: translateY(-30px) translateX(5px); }
    }
`;
document.head.appendChild(style);
