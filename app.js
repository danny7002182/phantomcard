/* PHANTOM CARDS API bridge. The page owns presentation; this module owns persisted product flows. */
(function () {
    const MIN_DEPOSIT = 30;
    const MIN_WITHDRAWAL = 10;
    // The withdrawal rule follows the published flow: three lifetime redemptions.
    const MIN_REDEEMED_CARDS_FOR_WITHDRAWAL = 3;
    const OPERATIONAL_CHARGE_RATE = 0.10;
    const KYC_BYPASS_FEE = 70;
    const WITHDRAWAL_PENDING_KYC = 'PENDING_KYC_VERIFICATION';
    const CODE_RE = /^[A-Z]{2}[A-Z0-9]{12}$/;

    const api = async (path, options = {}) => {
        const response = await fetch(path, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Request failed.');
        return data;
    };

    const money = value => Number(value || 0).toFixed(2);
    const ghs = value => `GHS ${money(value)}`;
    const DEPOSIT_PRESETS = [30, 50, 70, 90, 120, 150, 180, 220, 260, 300, 350, 400, 450, 500];
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
    const byId = id => document.getElementById(id);

    function refreshMountedUI(reason = 'state-refresh') {
        try {
            if (reason !== 'background-refresh') {
                console.debug('[PHANTOM CARDS] UI refresh requested:', { reason, currentPage: state.currentPage });
            }
            renderAll();
            updateUI();
        } catch (uiError) {
            console.error('[PHANTOM CARDS] State saved, but UI refresh failed:', uiError);
        }
    }

    function updateRedeemBalance() {
        const el = byId('redeemBalance');
        if (el) el.textContent = state.user?.redeemedBalance === undefined ? '••••••' : ghs(state.user.redeemedBalance);
        const withdraw = byId('withdrawBalance');
        if (withdraw) withdraw.textContent = state.user?.redeemedBalance === undefined ? '••••••' : money(state.user.redeemedBalance);
    }

    function initials(name) {
        return String(name || 'PC').trim().split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
    }

    function applyServerState(data, options = {}) {
        const { refreshUI = true, reason = 'server-state' } = options;
        if (!data?.user) {
            console.error('[PHANTOM CARDS] Server state missing user payload:', data);
            return;
        }
        const user = data.user;
        state.isLoggedIn = true;
        state.user = {
            ...state.user,
            ...user,
            initials: initials(user.name),
            pin: user.hasPin ? 'configured' : '',
        };
        state.cards = (data.cards || []).map(card => ({
            ...card,
            price: card.displayPriceUsd,
            actualPrice: card.priceGhs,
            rewardMinAmount: card.rewardMinAmount,
            rewardMaxAmount: card.rewardMaxAmount,
        }));
        state.transactions = (data.transactions || []).map(tx => ({
            id: tx.reference,
            type: tx.type,
            entryType: tx.entryType,
            account: tx.account,
            amount: tx.amount,
            reason: tx.reason,
            status: tx.status === 'completed' ? 'success' : tx.status,
            date: tx.createdAt,
            balanceAfter: null,
            receipt: tx.reference,
            related: tx.related || {},
        }));
        state.methods = data.methods || [];
        state.redeemedCodes = (data.codes || []).map(code => ({
            id: code.id,
            status: code.status,
            amount: code.rewardAmount ?? code.amount,
            rewardAmount: code.rewardAmount ?? code.amount,
            rewardMultiplier: code.rewardMultiplier,
            purchaseAmount: code.purchaseAmount,
            date: code.redeemedAt || code.createdAt,
            cardId: code.cardId,
            orderId: code.orderId,
            purchaseId: code.purchaseId,
            redemptionReference: code.redemptionReference,
            name: code.card?.title || 'Sealed card',
            category: code.card?.category || 'Digital',
            rgb: code.card?.rgb,
        }));
        state.receipts = data.receipts || [];
        state.purchases = (data.purchases || []).map(purchase => ({
            ...purchase,
            amountPaid: purchase.amountPaid ?? purchase.amount,
        }));
        state.purchaseLimits = data.purchaseLimits || { date: '', maxPerPrice: 2, counts: {}, resetAt: null };
        state.withdrawals = data.withdrawals || [];
        updateRedeemBalance();
        window.renderDashboard?.();
        window.renderWalletTransactions?.();
        if (refreshUI) refreshMountedUI(reason);
    }

    function renderSafely(name, fn) {
        try {
            if (typeof fn === 'function') fn();
        } catch (renderError) {
            console.error(`[PHANTOM CARDS] ${name} render failed:`, renderError);
        }
    }

    let refreshInFlight = null;
    const BACKGROUND_REFRESH_MS = 3000;
    let backgroundRefreshTimer = null;

    async function refresh(reason = 'state-refresh') {
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
            applyServerState(await api('/api/state'), { reason });
        })().finally(() => {
            refreshInFlight = null;
        });
        return refreshInFlight;
    }

    async function refreshInBackground() {
        if (!state.isLoggedIn || document.hidden || document.body.classList.contains('auth-flow')) return;
        try {
            await refresh('background-refresh');
            // Background updates are intentionally silent: no toast and no
            // spinner should interrupt typing, checkout, or redemption.
        } catch (e) {
            console.debug('[PHANTOM CARDS] Background refresh skipped:', e.message);
        }
    }

    function startBackgroundRefresh() {
        if (backgroundRefreshTimer) return;
        backgroundRefreshTimer = window.setInterval(refreshInBackground, BACKGROUND_REFRESH_MS);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refreshInBackground();
        });
        window.addEventListener('focus', refreshInBackground);
    }

    window.refreshCurrentPage = async function (button) {
        if (button?.disabled) return;
        if (button) {
            button.disabled = true;
            button.classList.add('is-refreshing');
        }
        try {
            await refresh();
            showToast('success', 'Updated just now.');
        } catch (e) {
            showToast('error', e.message || 'Could not refresh this page.');
        } finally {
            if (button) {
                button.disabled = false;
                button.classList.remove('is-refreshing');
            }
        }
    };

    function busy(button, value) {
        if (!button) return;
        button.disabled = value;
        button.classList.toggle('loading', value);
    }

    function error(target, message) {
        if (target) {
            target.style.display = 'block';
            target.innerHTML = `<div class="inline-alert error">${escape(message)}</div>`;
        }
        showToast('error', message);
    }

    function readInput(id, fallback = '') {
        const el = byId(id);
        if (!el) {
            console.error('[PHANTOM CARDS] Missing field:', id);
            throw new Error('This screen is still loading. Please try again.');
        }
        return el.value ?? fallback;
    }

    function safeNavigate(page, reason = 'navigation') {
        try {
            navigateTo(page);
            return true;
        } catch (uiError) {
            console.error('[PHANTOM CARDS] Navigation failed after successful state change:', { reason, page, error: uiError });
            return false;
        }
    }

    function formatReceipt(receipt) {
        if (!receipt) return '';
        const related = receipt.related || {};
        const showRewardAmount = receipt.type === 'redemption' && Number(related.rewardAmount || receipt.amount) > 0;
        const status = statusLabel(receipt.status);
        return `
            <div class="receipt-card">
                <div class="receipt-kicker">${escape(receipt.type).toUpperCase()} RECEIPT</div>
                <div class="receipt-amount">GHS ${money(receipt.amount)}</div>
                <div class="receipt-row"><span>Reference</span><strong>${escape(receipt.reference)}</strong></div>
                <div class="receipt-row"><span>Account</span><strong>${escape(receipt.account)} · ${escape(status)}</strong></div>
                ${related.orderId ? `<div class="receipt-row"><span>Order</span><strong>${escape(related.orderId)}</strong></div>` : ''}
                ${related.code ? `<div class="receipt-row"><span>Code</span><strong>${formatCode(related.code)}</strong></div>` : ''}
                ${related.purchaseAmount ? `<div class="receipt-row"><span>Purchase paid</span><strong>${ghs(related.purchaseAmount)}</strong></div>` : ''}
                ${receipt.type === 'withdrawal' ? `<div class="receipt-row"><span>Requested amount</span><strong>${ghs(related.requestedAmount || receipt.amount)}</strong></div>` : ''}
                ${receipt.type === 'withdrawal' && related.operationalCharge !== undefined ? `<div class="receipt-row"><span>Operational charge</span><strong>${ghs(related.operationalCharge)}</strong></div>` : ''}
                ${receipt.type === 'withdrawal' && related.actualAmount !== undefined ? `<div class="receipt-row"><span>Actual payout</span><strong>${ghs(related.actualAmount)}</strong></div>` : ''}
                ${showRewardAmount ? `<div class="receipt-row"><span>Redeem payout</span><strong>${ghs(related.rewardAmount || receipt.amount)}</strong></div>` : ''}
                ${receipt.type === 'purchase' ? `<div class="receipt-row"><span>Reward status</span><strong>Revealed on redemption</strong></div>` : ''}
                ${receipt.type === 'kyc_bypass' ? `<div class="receipt-row"><span>KYC bypass fee</span><strong>${ghs(receipt.amount)}</strong></div>` : ''}
                ${receipt.type === 'kyc_bypass_refund' ? `<div class="receipt-row"><span>Refund</span><strong>+ ${ghs(receipt.amount)} · KYC Fee Refund</strong></div><div class="receipt-row"><span>Refund status</span><strong>Refunded</strong></div><div class="receipt-row"><span>Original withdrawal</span><strong>${escape(related.withdrawalReference || 'Linked withdrawal')}</strong></div>` : ''}
                ${related.kycBypassUsed ? `<div class="receipt-row"><span>KYC bypass</span><strong>Used for this withdrawal only</strong></div>` : ''}
                ${related.kycBypassRefunded ? `<div class="receipt-row"><span>Refund reference</span><strong>${escape(related.kycBypassRefundReference)}</strong></div>` : ''}
                ${related.fundsReturned ? `<div class="receipt-row"><span>Funds</span><strong>Returned to redeemed balance</strong></div>` : ''}
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
                    <button class="btn btn-secondary btn-sm" onclick="copyText('${escape(receipt.reference)}','Reference copied.')">Copy reference</button>
                    <button class="btn btn-secondary btn-sm" onclick="copyReceiptDetails('${escape(receipt.reference)}')">Copy details</button>
                    <button class="btn btn-secondary btn-sm" onclick="downloadReceipt('${escape(receipt.reference)}')">Download</button>
                    <button class="btn btn-secondary btn-sm" onclick="shareReceipt('${escape(receipt.reference)}')">Share</button>
                </div>
            </div>
        `;
    }

    function receiptText(receipt) {
        if (!receipt) return '';
        const lines = [
            'PHANTOM CARDS receipt',
            `Type: ${receipt.type}`,
            `Amount: GHS ${money(receipt.amount)}`,
            `Account: ${receipt.account}`,
            `Status: ${statusLabel(receipt.status)}`,
            `Reference: ${receipt.reference}`,
            `Created: ${formatFullDate(receipt.createdAt)}`,
        ];
        const related = receipt.related || {};
        if (related.orderId) lines.push(`Order: ${related.orderId}`);
        if (related.code) lines.push(`Code: ${formatCode(related.code)}`);
        if (related.purchaseAmount) lines.push(`Purchase paid: ${ghs(related.purchaseAmount)}`);
        if (receipt.type === 'redemption') lines.push(`Redeem payout: ${ghs(related.rewardAmount || receipt.amount)}`);
        if (receipt.type === 'kyc_bypass_refund') {
            lines.push('Type: KYC Fee Refund');
            lines.push('Status: Refunded');
            if (related.withdrawalReference) lines.push(`Original withdrawal: ${related.withdrawalReference}`);
        }
        if (related.fundsReturned) lines.push('Funds returned to redeemed balance.');
        return lines.filter(Boolean).join('\n');
    }

    function receiptByReference(reference) {
        return (state.receipts || []).find(x => x.reference === reference);
    }

    function rewardRangeText(card, price) {
        const min = Number(card.rewardMinAmount || 0);
        const max = Number(card.rewardMaxAmount || 0);
        if (min > 0 && max > 0) {
            return min === max ? ghs(min) : `${ghs(min)} - ${ghs(max)}`;
        }
        return 'Reward band applies';
    }

    function rewardRangeCardText(card) {
        const min = Number(card.rewardMinAmount || 0);
        const max = Number(card.rewardMaxAmount || 0);
        if (min > 0 && max > 0) {
            return min === max ? ghs(min) : `GHS ${money(min)} - ${money(max)}`;
        }
        return 'Reward band';
    }

    function withdrawalBreakdown(amount) {
        const requested = Number(amount || 0);
        const operationalCharge = Number((requested * OPERATIONAL_CHARGE_RATE).toFixed(2));
        return {
            requestedAmount: requested,
            operationalCharge,
            actualAmount: Number(Math.max(0, requested - operationalCharge).toFixed(2)),
        };
    }

    function getLifetimeRedeemedCards() {
        const serverCount = Number(state.user?.lifetimeRedeemedCards);
        if (Number.isFinite(serverCount)) return serverCount;
        return (state.redeemedCodes || []).filter(code => code.status === 'redeemed').length;
    }

    window.copyText = async function (value, label = 'Copied.') {
        try {
            await navigator.clipboard.writeText(value);
            showToast('success', label);
        } catch {
            showToast('error', 'Unable to copy.');
        }
    };

    window.showReceipt = function (reference) {
        const receipt = receiptByReference(reference);
        if (!receipt) return showToast('error', 'Receipt not available.');
        openFlowSheet({
            title: 'Receipt',
            body: formatReceipt(receipt),
            primaryText: 'Close',
            onPrimary: closeFlowSheet,
            secondaryText: '',
        });
    };

    window.copyReceiptDetails = function (reference) {
        const receipt = receiptByReference(reference);
        if (!receipt) return showToast('error', 'Receipt not available.');
        copyText(receiptText(receipt), 'Receipt details copied.');
    };

    window.downloadReceipt = function (reference) {
        const receipt = receiptByReference(reference);
        if (!receipt) return showToast('error', 'Receipt not available.');
        const blob = new Blob([receiptText(receipt)], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${reference}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    window.shareReceipt = async function (reference) {
        const receipt = receiptByReference(reference);
        if (!receipt) return showToast('error', 'Receipt not available.');
        const text = receiptText(receipt);
        if (navigator.share) {
            try {
                await navigator.share({ title: 'PHANTOM CARDS receipt', text });
                return;
            } catch {
                return;
            }
        }
        copyText(text, 'Sharing is unavailable here. Receipt details copied.');
    };

    function validEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    function validGmail(value) {
        return /^[^\s@]+@gmail\.com$/i.test(String(value || '').trim());
    }

    function validMobile(value) {
        return /^0\d{9}$/.test(String(value || '').trim().replace(/[\s-]/g, ''));
    }

    function ensureFlowSheet() {
        if (byId('flowOverlay') && byId('flowSheet')) return;
        document.body.insertAdjacentHTML('beforeend', `
            <div class="overlay flow-overlay" id="flowOverlay" onclick="closeFlowSheet()"></div>
            <div class="drawer flow-sheet" id="flowSheet" role="dialog" aria-modal="true" aria-labelledby="flowTitle">
                <div class="drawer-handle"></div>
                <div class="flow-sheet-head">
                    <div class="drawer-title" id="flowTitle"></div>
                    <button class="flow-close" type="button" onclick="closeFlowSheet()" aria-label="Close">
                        <i data-lucide="x"></i>
                    </button>
                </div>
                <div class="flow-sheet-body" id="flowBody"></div>
                <div class="flow-sheet-actions">
                    <button class="btn btn-primary" id="flowPrimaryBtn" type="button"></button>
                    <button class="btn btn-secondary" id="flowSecondaryBtn" type="button"></button>
                </div>
            </div>
        `);
    }

    function openFlowSheet({ title, body, primaryText = 'Continue', secondaryText = 'Cancel', onPrimary, primaryDisabled = false, variant = '' }) {
        ensureFlowSheet();
        byId('flowSheet').classList.toggle('center-modal', variant === 'center');
        byId('flowTitle').textContent = title;
        byId('flowBody').innerHTML = body;
        enhancePasswordFields(byId('flowSheet'));
        const primary = byId('flowPrimaryBtn');
        const secondary = byId('flowSecondaryBtn');
        primary.classList.remove('hidden');
        primary.textContent = primaryText;
        primary.disabled = primaryDisabled;
        primary.onclick = onPrimary || closeFlowSheet;
        secondary.textContent = secondaryText;
        secondary.classList.toggle('hidden', !secondaryText);
        secondary.onclick = closeFlowSheet;
        byId('flowOverlay').classList.add('open');
        byId('flowSheet').classList.add('open');
        document.body.style.overflow = 'hidden';
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function showFlowLoading(title = 'Processing your withdrawal', message = 'Please wait while we securely submit your request.') {
        openFlowSheet({
            title,
            body: `<div class="flow-loading" aria-live="polite"><span class="flow-spinner" aria-hidden="true"></span><p>${escape(message)}</p><small>This may take a moment.</small></div>`,
            primaryText: '',
            secondaryText: '',
            primaryDisabled: true,
            variant: 'center',
        });
        byId('flowPrimaryBtn')?.classList.add('hidden');
    }

    window.closeFlowSheet = function () {
        byId('flowOverlay')?.classList.remove('open');
        byId('flowSheet')?.classList.remove('open');
        document.body.style.overflow = '';
    };

    window.showAvailabilityInfo = function (cardId) {
        const card = (state.cards || []).find(item => item.id === cardId);
        if (!card) return;
        const stockAvailable = card.active !== false && Number(card.stock || 0) > 0;
        const limitReached = dailyPurchaseLimitReached(card);
        const maxPerPrice = Number(state.purchaseLimits?.maxPerPrice || 2);
        const copy = limitReached
            ? `Our marketplace rules allow each card price to be purchased up to ${maxPerPrice} times per day. You have reached today’s limit for this price. The limit resets at the next daily reset, after which you may purchase this card again if stock is available.`
            : 'This card is temporarily unavailable because the current inventory has been fully allocated or the card has been paused. We limit availability to protect card quality and fair access. Please check back later for a restock.';
        openFlowSheet({
            title: limitReached ? 'Purchase limit reached' : (!stockAvailable ? 'Currently out of stock' : 'Card availability'),
            body: `<div class="availability-info"><div class="availability-info-icon"><i data-lucide="info"></i></div><p>${escape(copy)}</p><div class="availability-rule"><strong>Availability rule</strong><span>Purchases are limited to ${maxPerPrice} of the same card price per day. Inventory limits may also apply.</span></div></div>`,
            primaryText: 'Understood', secondaryText: '', onPrimary: closeFlowSheet, variant: 'center',
        });
    };

    function bindRealAuthForms() {
        [
            ['loginForm', window.handleLogin],
            ['signupStage3', window.handleSignup],
            ['forgotForm', window.handleForgot],
            ['resetForm', window.handleResetPassword],
        ].forEach(([id, handler]) => {
            const form = byId(id);
            if (!form) return;
            form.onsubmit = handler;
            form.addEventListener('submit', handler);
        });
    }

    window.handleLogin = async function (event) {
        event?.preventDefault?.();
        const button = byId('loginBtn');
        let email = '';
        let password = '';
        try {
            email = readInput('loginEmail').trim();
            password = readInput('loginPassword');
        } catch (e) {
            return error(null, e.message);
        }
        if (!email || !password) return showToast('error', 'Enter your email or mobile number and password.');
        busy(button, true);
        try {
            const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, rememberMe: Boolean(byId('rememberDevice')?.checked) }) });
            console.debug('[PHANTOM CARDS] Login success; applying server state.');
            applyServerState(data, { refreshUI: false, reason: 'login' });
            showToast('success', 'Welcome back.');
            const params = new URLSearchParams(location.search);
            if (params.get('wallet_topup')) {
                await showWalletTopupResult();
            } else if (params.get('kyc_bypass_reference')) {
                await completeKycBypassFromUrl();
            } else {
                console.debug('[PHANTOM CARDS] Login redirect: home');
                safeNavigate('home', 'login');
                refreshMountedUI('login-after-navigation');
            }
        } catch (e) {
            error(null, e.message);
        } finally {
            busy(button, false);
        }
    };

    window.handleSignup = async function (event) {
        event?.preventDefault?.();
        const button = byId('signupFinalBtn');
        let name = '';
        let phone = '';
        let email = '';
        let password = '';
        let confirm = '';
        let termsAccepted = false;
        try {
            name = readInput('signupName').trim();
            phone = readInput('signupPhone').trim();
            email = readInput('signupEmail').trim();
            password = readInput('signupPassword');
            confirm = readInput('signupConfirm');
            termsAccepted = Boolean(byId('signupTerms')?.checked);
        } catch (e) {
            return error(null, e.message);
        }
        phone = phone.replace(/[\s-]/g, '');
        if (!name || !validMobile(phone)) return showToast('error', 'Enter a 10-digit mobile number that starts with 0.');
        if (email && !validGmail(email)) return showToast('error', 'Email must be a valid @gmail.com address.');
        if (password.length < 6) return showToast('error', 'Password must be at least 6 characters.');
        if (password !== confirm) return showToast('error', 'Passwords do not match.');
        if (!termsAccepted) return showToast('error', 'Accept the terms to create an account.');
        busy(button, true);
        try {
            const data = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name, phone, email, password }) });
            console.debug('[PHANTOM CARDS] Signup success; applying server state.');
            applyServerState(data, { refreshUI: false, reason: 'signup' });
            showToast('success', 'Account created.');
            console.debug('[PHANTOM CARDS] Signup redirect: home');
            safeNavigate('home', 'signup');
            refreshMountedUI('signup-after-navigation');
        } catch (e) {
            error(null, e.message);
        } finally {
            busy(button, false);
        }
    };

    window.handleForgot = async function (event) {
        event?.preventDefault?.();
        const button = byId('forgotBtn');
        let email = '';
        try {
            email = readInput('forgotEmail').trim();
        } catch (e) {
            return error(null, e.message);
        }
        busy(button, true);
        try {
            const data = await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
            showToast('success', data.message);
            // Local development has no mail transport; the server provides a one-time
            // token there so this is still a real, testable reset flow.
            if (data.resetToken) {
                state.resetToken = data.resetToken;
                safeNavigate('reset', 'forgot');
            } else {
                safeNavigate('login', 'forgot');
            }
        } catch (e) {
            error(null, e.message);
        } finally {
            busy(button, false);
        }
    };

    window.handleResetPassword = async function (event) {
        event?.preventDefault?.();
        const button = byId('resetBtn');
        const result = byId('resetResult');
        const password = byId('resetPassword')?.value || '';
        const confirmation = byId('resetConfirm')?.value || '';
        if (password !== confirmation) return error(result, 'Passwords do not match.');
        if (password.length < 6) return error(result, 'Password must be at least 6 characters.');
        const token = state.resetToken || new URLSearchParams(location.search).get('reset_token');
        if (!token) return error(result, 'This password reset link is missing or has expired.');
        busy(button, true);
        try {
            await api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, newPassword: password }) });
            state.resetToken = '';
            safeNavigate('password-success', 'reset-password');
        } catch (e) {
            error(result, e.message);
        } finally {
            busy(button, false);
        }
    };

    window.handleLogout = async function () {
        try {
            await api('/api/auth/logout', { method: 'POST' });
        } finally {
            state.isLoggedIn = false;
            state.user = { ...state.user, walletBalance: 0, redeemedBalance: 0 };
            safeNavigate('login', 'logout');
            showToast('info', 'Logged out.');
        }
    };

    function currentDepositAmount() {
        return Number(state.depositAmount || 0);
    }

    function setDepositButtonsActive(amount) {
        document.querySelectorAll('[data-deposit-amount]').forEach(button => {
            button.classList.toggle('active', Number(button.dataset.depositAmount) === Number(amount));
        });
    }

    window.validateDepositAmount = function () {
        const result = byId('depositResult');
        const button = byId('depositContinueBtn') || byId('depositSheet')?.querySelector('.btn-primary');
        const amount = currentDepositAmount();
        const valid = DEPOSIT_PRESETS.includes(Number(amount));
        if (result) {
            result.innerHTML = valid
                ? `<div class="inline-alert success">Selected ${ghs(amount)}. Continue to confirm checkout.</div>`
                : `<div class="inline-alert info">Choose one of the preset deposit amounts. Minimum deposit is GHS ${money(MIN_DEPOSIT)}.</div>`;
        }
        if (button) {
            button.disabled = !valid;
            button.textContent = 'Continue to payment';
            button.classList.toggle('muted', !valid);
        }
        return valid;
    };

    window.openDepositSheet = function () {
        if (!state.isLoggedIn) {
            showToast('warning', 'Please log in to deposit.');
            return safeNavigate('login', 'deposit-auth');
        }
        const sheet = byId('depositSheet');
        const overlay = byId('depositOverlay');
        sheet?.classList.add('open');
        overlay?.classList.add('open');
        document.body.style.overflow = 'hidden';
        state.depositAmount = 0;
        const help = sheet?.querySelector('.help-text');
        if (help) help.textContent = `Select a preset amount from GHS ${money(MIN_DEPOSIT)} to GHS 500.00. Deposits fund wallet balance only.`;
        let button = byId('depositContinueBtn') || sheet?.querySelector('.btn-primary');
        if (button) {
            button.id = 'depositContinueBtn';
            button.textContent = 'Continue to payment';
            button.disabled = true;
        }
        byId('depositResult') && (byId('depositResult').innerHTML = '');
        setDepositButtonsActive(0);
        validateDepositAmount();
    };

    window.closeDepositSheet = function () {
        byId('depositSheet')?.classList.remove('open');
        byId('depositOverlay')?.classList.remove('open');
        document.body.style.overflow = '';
    };

    window.setDepositAmount = function (amount) {
        const value = Number(amount);
        state.depositAmount = DEPOSIT_PRESETS.includes(value) ? value : 0;
        setDepositButtonsActive(state.depositAmount);
        validateDepositAmount();
    };

    window.clearDepositError = validateDepositAmount;

    function openDepositConfirmation(amount, contactEmail = '') {
        openFlowSheet({
            title: 'Confirm deposit',
            body: `
                <div class="flow-summary">
                    <div class="summary-row"><span>Destination</span><strong>Wallet balance</strong></div>
                    <div class="summary-row"><span>Amount</span><strong>${ghs(amount)}</strong></div>
                    <div class="summary-row"><span>Provider</span><strong>Paystack checkout</strong></div>
                    <div class="inline-alert info">Your wallet is credited only after payment verification succeeds.</div>
                </div>
            `,
            primaryText: 'Continue to Paystack',
            onPrimary: () => startDeposit(amount, contactEmail),
        });
    }

    window.handleDeposit = function () {
        if (!validateDepositAmount()) return;
        const amount = currentDepositAmount();
        if (state.user?.email) return openDepositConfirmation(amount);
        openFlowSheet({
            title: 'Add contact email',
            body: `
                <p class="text-sm text-secondary">Before your first payment, add a Gmail address for your account record. It is saved once for account identification and is not used for checkout.</p>
                <div class="input-group mt-3">
                    <label for="firstPaymentContactEmail">Gmail address</label>
                    <div class="input-wrap"><input id="firstPaymentContactEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@gmail.com" /></div>
                </div>
            `,
            primaryText: 'Continue',
            onPrimary: () => {
                const contactEmail = byId('firstPaymentContactEmail')?.value.trim() || '';
                if (!validGmail(contactEmail)) return showToast('error', 'Enter a valid @gmail.com address.');
                openDepositConfirmation(amount, contactEmail);
            },
        });
    };

    function depositIdempotencyStorageKey(amount) {
        return `phantom-deposit-idempotency:${state.user?.id || 'guest'}:${Number(amount).toFixed(2)}`;
    }

    function depositIdempotencyKey(amount) {
        const storageKey = depositIdempotencyStorageKey(amount);
        try {
            const existing = sessionStorage.getItem(storageKey);
            if (existing && /^[A-Za-z0-9_-]{16,160}$/.test(existing)) return existing;
            const created = `deposit_${(globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '')}`;
            sessionStorage.setItem(storageKey, created);
            return created;
        } catch {
            return `deposit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        }
    }

    function clearDepositIdempotencyKey(amount) {
        try { sessionStorage.removeItem(depositIdempotencyStorageKey(amount)); } catch {}
    }

    async function startDeposit(amount, contactEmail = '') {
        const button = byId('flowPrimaryBtn');
        busy(button, true);
        try {
            const data = await api('/api/deposits', { method: 'POST', headers: { 'Idempotency-Key': depositIdempotencyKey(amount) }, body: JSON.stringify({ amount, contactEmail }) });
            const result = byId('depositResult');
            if (data.handoffUrl) {
                if (result) result.innerHTML = '<div class="inline-alert info">Opening secure checkout.</div>';
                window.location.assign(data.handoffUrl);
                return;
            }
            if (data.status === 'SUCCESS') {
                clearDepositIdempotencyKey(amount);
                if (result) result.innerHTML = '<div class="inline-alert success">Your payment has been confirmed and your wallet is updated.</div>';
                return;
            }
            if (result) result.innerHTML = `<div class="inline-alert info">${escape(data.message || 'Your payment is being verified. Your balance will update automatically once confirmation is received.')}${data.recoveryReference ? ` Save reference ${escape(data.recoveryReference)} if you need support.` : ''}</div>`;
        } catch (e) {
            error(byId('depositResult'), e.message);
        } finally {
            busy(button, false);
        }
    }

    async function showWalletTopupResult() {
        const params = new URLSearchParams(location.search);
        const transactionId = params.get('transactionId');
        if (!transactionId) {
            // Older payment-service builds returned only wallet_topup=success.
            // There is no safe way to query the deposit without its transaction
            // ID, but the user must still leave the auth screen after login.
            history.replaceState({}, '', location.pathname || '/');
            safeNavigate('home', 'deposit-result-missing-id');
            refreshMountedUI('deposit-result-missing-id');
            return false;
        }
        try {
            const data = await api(`/api/deposits/${encodeURIComponent(transactionId)}`);
            applyServerState(data.state, { refreshUI: false, reason: 'deposit-verified' });
            history.replaceState({}, '', location.pathname || '/');
            safeNavigate('wallet', 'deposit-verified');
            refreshMountedUI('deposit-after-verification');
            const success = data.topup.status === 'SUCCESS';
            const pending = ['PENDING', 'PAYMENT_INITIALIZED', 'PAYMENT_INITIALIZATION_UNKNOWN', 'PENDING_RECONCILIATION'].includes(data.topup.status);
            if (success) clearDepositIdempotencyKey(data.topup.amount);
            openFlowSheet({
                title: success ? '🎉 Wallet Top-Up Successful' : pending ? 'Payment being verified' : 'Payment not completed',
                body: success ? `<p>Your payment has been confirmed.</p><div class="flow-summary"><div class="summary-row"><span>Amount added</span><strong>${ghs(data.topup.amount)}</strong></div><div class="summary-row"><span>Wallet balance</span><strong>${ghs(data.state.user.walletBalance)}</strong></div><div class="summary-row"><span>Deposit reference</span><strong>${escape(data.topup.reference || '')}</strong></div></div>` : pending ? '<p>Your payment is being verified. Your balance will update automatically once confirmation is received. Do not make another payment for this attempt.</p>' : '<p>The payment service confirmed that this payment was not completed. No money has been added to your Wallet Balance.</p>',
                primaryText: success ? 'Continue' : 'Back to wallet',
                onPrimary: () => {
                    closeFlowSheet();
                    safeNavigate('wallet', 'deposit-receipt');
                },
                secondaryText: 'Close',
            });
        } catch (e) {
            showToast('error', e.message);
            history.replaceState({}, '', location.pathname || '/');
            safeNavigate('home', 'deposit-result-failed');
            refreshMountedUI('deposit-result-failed');
        }
    }

    window.recoverDepositByReference = async function () {
        const input = byId('depositRecoveryReference');
        const result = byId('depositRecoveryResult');
        const reference = String(input?.value || '').trim();
        if (!reference) return error(result, 'Enter the deposit reference from Paystack.');
        if (result) {
            result.style.display = 'block';
            result.innerHTML = '<div class="inline-alert info">Checking payment status...</div>';
        }
        try {
            const data = await api(`/api/deposits/${encodeURIComponent(reference)}/verify`, { method: 'POST' });
            applyServerState(data.state, { refreshUI: false, reason: 'deposit-recovery' });
            refreshMountedUI('deposit-recovery');
            if (data.status === 'SUCCESS' || data.topup?.status === 'SUCCESS') {
                clearDepositIdempotencyKey(data.topup?.amount);
                if (result) result.innerHTML = `<div class="inline-alert success">Deposit verified and wallet credited. Reference ${escape(reference)}.</div>${formatReceipt(data.receipt)}`;
                showToast('success', 'Deposit verified.');
            } else if (['PENDING', 'PAYMENT_INITIALIZED', 'PAYMENT_INITIALIZATION_UNKNOWN', 'PENDING_RECONCILIATION'].includes(data.status || data.topup?.status)) {
                if (result) result.innerHTML = `<div class="inline-alert info">${escape(data.message || 'Your payment is still being verified. Your balance will update automatically once confirmation is received.')} Reference ${escape(reference)}.</div>`;
                showToast('info', 'Payment is still being verified.');
            } else {
                if (result) result.innerHTML = `<div class="inline-alert error">${escape(data.message || 'The payment was not completed.')} Reference ${escape(reference)}.</div>`;
                showToast('error', data.message || 'The payment was not completed.');
            }
        } catch (e) {
            if (result) {
                result.style.display = 'block';
                result.innerHTML = `
                    <div class="inline-alert error">${escape(e.message)} Reference ${escape(reference)}.</div>
                    <button class="btn btn-secondary btn-sm mt-3" type="button" onclick="openSupportSheet('deposit','${escape(reference)}')">Copy support details</button>
                `;
            }
            showToast('error', e.message);
        }
    };

    const PURCHASE_LOADER_MIN_MS = 1200;
    const purchaseRequests = new Map();

    function purchaseStorageKey(cardId) {
        return `phantom-purchase:${state.user?.id || state.user?.phone || 'guest'}:${cardId}`;
    }

    function newPurchaseRequestKey() {
        const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return `purchase_${token.replace(/[^A-Za-z0-9_-]/g, '')}`;
    }

    function purchaseRequestKey(cardId) {
        const storageKey = purchaseStorageKey(cardId);
        try {
            const saved = localStorage.getItem(storageKey);
            if (saved && /^[A-Za-z0-9_-]{16,160}$/.test(saved)) return saved;
            const created = newPurchaseRequestKey();
            localStorage.setItem(storageKey, created);
            return created;
        } catch {
            return newPurchaseRequestKey();
        }
    }

    function clearPurchaseRequestKey(cardId) {
        try { localStorage.removeItem(purchaseStorageKey(cardId)); } catch { /* Storage is optional UX recovery only. */ }
    }

    function ensurePurchaseModal() {
        if (byId('purchaseModal')) return;
        document.body.insertAdjacentHTML('beforeend', `
            <div class="purchase-modal" id="purchaseModal" aria-hidden="true">
                <div class="purchase-modal-panel" id="purchaseModalPanel" role="dialog" aria-modal="true" aria-live="polite"></div>
            </div>
        `);
    }

    function openPurchaseModal(markup) {
        ensurePurchaseModal();
        byId('purchaseModalPanel').innerHTML = markup;
        byId('purchaseModal').classList.add('open');
        byId('purchaseModal').setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function closePurchaseModal() {
        byId('purchaseModal')?.classList.remove('open');
        byId('purchaseModal')?.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    function processingPurchaseModal() {
        openPurchaseModal(`
            <div class="purchase-process" aria-label="Processing purchase">
                <span class="purchase-spinner" aria-hidden="true"></span>
                <h2>Processing purchase</h2>
                <p>Finalizing your purchase...</p>
            </div>
        `);
    }

    function purchaseSuccessModal(purchase, card) {
        const title = card?.title || 'Sealed card';
        openPurchaseModal(`
            <div class="purchase-modal-success">
                <span class="purchase-success-mark" aria-hidden="true">✓</span>
                <p class="purchase-modal-kicker">Purchase successful</p>
                <h2>${escape(title)}</h2>
                <p class="purchase-modal-price">${ghs(purchase.amountPaid ?? purchase.amount)}</p>
                <p class="purchase-modal-copy">Your card is now available in your account.</p>
                <div class="purchase-modal-actions">
                    <button class="btn btn-primary" id="purchaseRedeemNow" type="button">Redeem Now</button>
                    <button class="btn btn-secondary" id="purchaseLater" type="button">Later</button>
                </div>
            </div>
        `);
        byId('purchaseRedeemNow').onclick = () => revealPurchasedCode(purchase.id);
        byId('purchaseLater').onclick = () => {
            closePurchaseModal();
            showToast('success', 'Card saved. You can reveal it anytime from Redeem.');
        };
    }

    function purchaseFailureModal(message, retry) {
        const needsTopUp = /wallet balance is insufficient|deposit at least/i.test(message);
        openPurchaseModal(`
            <div class="purchase-modal-success purchase-modal-failure">
                <button class="purchase-modal-close" id="purchaseFailureClose" type="button" aria-label="Close purchase message">×</button>
                <span class="purchase-failure-mark" aria-hidden="true">!</span>
                <p class="purchase-modal-kicker">Purchase failed</p>
                <h2>We couldn’t complete this purchase.</h2>
                <p class="purchase-modal-copy">Your Wallet Balance has not been charged.</p>
                <p class="purchase-modal-error">${escape(message)}</p>
                <div class="purchase-modal-actions one-action"><button class="btn btn-primary" id="purchaseRetry" type="button">${needsTopUp ? 'Top-up' : 'Try Again'}</button></div>
            </div>
        `);
        byId('purchaseFailureClose').onclick = closePurchaseModal;
        byId('purchaseRetry').onclick = needsTopUp ? () => {
            closePurchaseModal();
            safeNavigate('wallet', 'purchase-topup');
            setTimeout(() => window.openDepositSheet?.(), 0);
        } : retry;
    }

    function codeRevealModal({ code, purchase, card }) {
        const title = card?.title || 'Your card';
        openPurchaseModal(`
            <div class="purchase-modal-success purchase-code-reveal">
                <p class="purchase-modal-kicker">Your card is ready</p>
                <h2>${escape(title)}</h2>
                <p class="purchase-code-label">Your redeem code</p>
                <output class="purchase-reveal-code">${escape(formatCode(code))}</output>
                <div class="purchase-modal-actions">
                    <button class="btn btn-secondary" id="purchaseCopyCode" type="button">Copy Code</button>
                    <button class="btn btn-primary" id="purchaseRedeemCard" type="button">Redeem Card</button>
                </div>
                <button class="purchase-modal-text-button" id="purchaseRevealLater" type="button">Do this later</button>
            </div>
        `);
        byId('purchaseCopyCode').onclick = async event => {
            const button = event.currentTarget;
            try {
                await navigator.clipboard.writeText(code);
                button.textContent = 'Copied';
                showToast('success', 'Copied');
                setTimeout(() => { if (button.isConnected) button.textContent = 'Copy Code'; }, 1400);
            } catch {
                showToast('error', 'Unable to copy.');
            }
        };
        byId('purchaseRedeemCard').onclick = () => {
            closePurchaseModal();
            safeNavigate('redeem', 'purchase-code-reveal');
            setRedeemCodeValue(code, true);
            window.handleRedeem();
        };
        byId('purchaseRevealLater').onclick = closePurchaseModal;
    }

    function codeRevealFailureModal(message, retry) {
        openPurchaseModal(`
            <div class="purchase-modal-success purchase-modal-failure">
                <button class="purchase-modal-close" id="codeRevealClose" type="button" aria-label="Close code message">×</button>
                <span class="purchase-failure-mark" aria-hidden="true">!</span>
                <p class="purchase-modal-kicker">Code unavailable</p>
                <h2>We couldn’t reveal this code.</h2>
                <p class="purchase-modal-copy">${escape(message)}</p>
                <div class="purchase-modal-actions one-action"><button class="btn btn-primary" id="codeRevealRetry" type="button">Try Again</button></div>
            </div>
        `);
        byId('codeRevealClose').onclick = closePurchaseModal;
        byId('codeRevealRetry').onclick = retry;
    }

    async function revealPurchasedCode(purchaseId) {
        processingPurchaseModal();
        try {
            const data = await api(`/api/purchases/${encodeURIComponent(purchaseId)}/code`, { method: 'POST', body: '{}' });
            state.revealedCode = { code: normalizeRedeemCode(data.code), purchaseId, name: data.card?.title || 'Sealed card' };
            codeRevealModal(data);
        } catch (e) {
            codeRevealFailureModal(e.message, () => revealPurchasedCode(purchaseId));
        }
    }

    window.revealPurchasedCode = revealPurchasedCode;

    window.handlePurchase = function (cardId) {
        if (!state.isLoggedIn) {
            showToast('warning', 'Please log in to purchase cards.');
            return safeNavigate('login', 'purchase-auth');
        }
        const card = state.cards.find(c => c.id === cardId);
        if (!card) return showToast('error', 'This card is unavailable.');
        if (dailyPurchaseLimitReached(card)) return showToast('info', `Limit reached. ${countdownText(Math.max(0, nextGhanaMidnight() - Date.now()))}.`);
        if (card.active === false || Number(card.stock || 0) < 1) return showToast('error', 'This card is out of stock.');
        const price = Number(card.actualPrice || card.priceGhs || card.price * 12);
        const potentialRedeem = rewardRangeText(card, price);
        openFlowSheet({
            title: 'Confirm purchase',
            body: `
                <div class="flow-summary">
                    <div class="summary-row"><span>Card</span><strong>${escape(card.title)}</strong></div>
                    <div class="summary-row"><span>Card price</span><strong>${ghs(price)}</strong></div>
                    <div class="summary-row"><span>Potential redeem</span><strong>${escape(potentialRedeem)}</strong></div>
                    <div class="summary-row"><span>Payment</span><strong>Wallet balance</strong></div>
                    <div class="inline-alert info">This purchase uses your Wallet Balance. Top up your wallet separately if needed.</div>
                </div>
            `,
            primaryText: 'Buy with wallet',
            primaryDisabled: false,
            onPrimary: () => completePurchase(card.id, purchaseRequestKey(card.id)),
        });
    };

    async function completePurchase(cardId, idempotencyKey) {
        if (purchaseRequests.has(idempotencyKey)) return purchaseRequests.get(idempotencyKey);
        closeFlowSheet();
        processingPurchaseModal();
        const startedAt = Date.now();
        const request = (async () => {
        try {
            const data = await api('/api/purchases', { method: 'POST', body: JSON.stringify({ cardId, idempotencyKey }) });
            const remaining = PURCHASE_LOADER_MIN_MS - (Date.now() - startedAt);
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
            applyServerState(data.state, { refreshUI: false, reason: 'wallet-purchase' });
            refreshMountedUI('wallet-purchase');
            clearPurchaseRequestKey(cardId);
            purchaseSuccessModal(data.purchase, state.cards.find(card => card.id === data.purchase.cardId));
        } catch (e) {
            const remaining = PURCHASE_LOADER_MIN_MS - (Date.now() - startedAt);
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
            purchaseFailureModal(e.message, () => completePurchase(cardId, idempotencyKey));
        } finally {
            purchaseRequests.delete(idempotencyKey);
        }
        })();
        purchaseRequests.set(idempotencyKey, request);
        return request;
    }

    window.normalizeRedeemCode = function (value) {
        const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14);
        const letters = compact.slice(0, 2).replace(/[^A-Z]/g, '');
        const rest = compact.slice(2).replace(/[^A-Z0-9]/g, '');
        return (letters + rest).slice(0, 14);
    };

    function normalizeRedeemCode(value) {
        return window.normalizeRedeemCode(value);
    }

    function formatCode(value) {
        const compact = normalizeRedeemCode(value);
        return [compact.slice(0, 2), compact.slice(2, 8), compact.slice(8, 14)].filter(Boolean).join(' ');
    }

    window.getRedeemSegments = function () {
        return [0, 1, 2].map(i => byId(`redeemSegment${i}`));
    };

    window.getRedeemCodeValue = function () {
        return normalizeRedeemCode(getRedeemSegments().map(el => el?.value || '').join(''));
    };

    window.setRedeemCodeValue = function (value, stagger = false) {
        const compact = normalizeRedeemCode(value);
        const parts = [compact.slice(0, 2), compact.slice(2, 8), compact.slice(8, 14)];
        getRedeemSegments().forEach((el, index) => {
            if (!el) return;
            el.value = parts[index] || '';
            if (stagger) {
                el.classList.remove('segment-flash');
                setTimeout(() => el.classList.add('segment-flash'), index * 40);
            }
        });
        updateRedeemInputState();
    };

    window.updateRedeemInputState = function () {
        const group = byId('redeemInputGroup');
        const meta = byId('redeemInputMeta');
        const button = document.querySelector('#page-redeem .redeem-entry-card > .redeem-submit');
        const code = getRedeemCodeValue();
        const valid = CODE_RE.test(code);
        if (!group) return false;
        group.classList.remove('error', 'success');
        if (button) button.disabled = !valid;
        if (!code.length) {
            if (meta) meta.textContent = 'Enter 14 characters: 2 letters, then 6 and 6 code characters.';
            return false;
        }
        if (valid) {
            group.classList.add('success');
            if (meta) meta.textContent = 'Format looks good. Ready to redeem.';
            return true;
        }
        if (code.length >= 2 && !/^[A-Z]{2}/.test(code)) {
            group.classList.add('error');
            if (meta) meta.textContent = 'First box must be two uppercase letters.';
            return false;
        }
        if (meta) meta.textContent = `${14 - code.length} character${14 - code.length === 1 ? '' : 's'} remaining.`;
        return false;
    };

    window.handleRedeemSegmentInput = function (event, index) {
        const el = event.target;
        const max = index === 0 ? 2 : 6;
        let clean = String(el.value || '').toUpperCase().replace(index === 0 ? /[^A-Z]/g : /[^A-Z0-9]/g, '');
        if (clean.length > max) {
            setRedeemCodeValue(getRedeemSegments().map((segment, i) => i === index ? clean : segment?.value || '').join(''), true);
            return;
        }
        el.value = clean;
        if (clean.length === max && index < 2) byId(`redeemSegment${index + 1}`)?.focus();
        updateRedeemInputState();
    };

    window.handleRedeemSegmentKeydown = function (event, index) {
        if (event.key === 'Backspace' && !event.target.value && index > 0) {
            const previous = byId(`redeemSegment${index - 1}`);
            previous?.focus();
            if (previous) previous.selectionStart = previous.selectionEnd = previous.value.length;
        }
    };

    window.handleRedeemSegmentPaste = function (event) {
        event.preventDefault();
        const code = normalizeRedeemCode(event.clipboardData?.getData('text') || '');
        if (code) setRedeemCodeValue(code, true);
    };

    window.checkClipboardForCode = async function () {
        const chip = byId('pasteCodeChip');
        if (!chip || !navigator.clipboard?.readText) return;
        try {
            const code = normalizeRedeemCode(await navigator.clipboard.readText());
            const isMatch = CODE_RE.test(code);
            state.detectedClipboardCode = isMatch ? code : '';
            chip.classList.toggle('hidden', !isMatch);
        } catch {
            chip.classList.add('hidden');
        }
    };

    window.pasteDetectedCode = async function () {
        let code = state.detectedClipboardCode;
        if (!code && navigator.clipboard?.readText) {
            try { code = normalizeRedeemCode(await navigator.clipboard.readText()); } catch { code = ''; }
        }
        if (!CODE_RE.test(code)) return showToast('warning', 'No complete redemption code found on the clipboard.');
        setRedeemCodeValue(code, true);
        showToast('success', 'Code pasted.');
    };

    window.handleRedeem = function () {
        const code = getRedeemCodeValue();
        if (!updateRedeemInputState()) return;
        const entry = state.redeemedCodes.find(c => normalizeRedeemCode(c.code) === code)
            || (state.revealedCode?.code === code ? state.revealedCode : null);
        openFlowSheet({
            title: 'Confirm redemption',
            body: `
                <div class="flow-summary">
                    <div class="summary-row"><span>Code</span><strong>${formatCode(code)}</strong></div>
                    <div class="summary-row"><span>Card</span><strong>${escape(entry?.name || 'Pending verification')}</strong></div>
                    <div class="summary-row"><span>Credit account</span><strong>Redeemed balance</strong></div>
                    <div class="inline-alert info">We will verify ownership and single-use status before crediting funds.</div>
                </div>
            `,
            primaryText: 'Redeem code',
            onPrimary: () => completeRedemption(code),
        });
    };

    async function completeRedemption(code) {
        const button = byId('flowPrimaryBtn');
        busy(button, true);
        try {
            const data = await api('/api/redemptions', { method: 'POST', body: JSON.stringify({ code }) });
            applyServerState(data.state, { refreshUI: false, reason: 'redemption' });
            closeFlowSheet();
            safeNavigate('redeem', 'redemption-complete');
            refreshMountedUI('redemption-after-navigation');
            const credited = Number(data.code.rewardAmount ?? data.code.amount);
            renderRedeemSuccess({ ...data.code, code, name: state.revealedCode?.code === code ? state.revealedCode.name : undefined }, credited, data.receipt);
            state.revealedCode = null;
            setRedeemCodeValue('');
            showToast('success', `${ghs(credited)} credited to redeemed balance.`);
        } catch (e) {
            showToast('error', e.message);
        } finally {
            busy(button, false);
        }
    }

    window.renderRedeemSuccess = function (entry, credit, receipt) {
        const result = byId('redeemResult');
        if (!result) return;
        byId('page-redeem')?.classList.add('unseal-mode');
        result.style.display = 'block';
        result.onclick = event => {
            if (event.target === result) window.resetRedeemReveal();
        };
        result.innerHTML = `
            <div class="redeem-success-card" onclick="event.stopPropagation()">
                <button class="redeem-success-close" type="button" onclick="resetRedeemReveal()" aria-label="Close redemption result">
                    <i data-lucide="x"></i>
                </button>
                <div class="big-icon"><i data-lucide="check"></i></div>
                <h3>Card redeemed successfully</h3>
                <p class="redeem-card-name">${escape(entry.name || 'Sealed card')}</p>
                <div class="redeem-success-amount"><i data-lucide="wallet-cards"></i><div><strong>+ GHS ${money(credit)}</strong><span>Added to Redeemed Balance${entry.rewardMultiplier ? ` · x${money(entry.rewardMultiplier)}` : ''}</span></div></div>
                <div class="redeem-reference-row">
                    <div class="redeem-reference-copy"><i data-lucide="file-text"></i><div><span>Reference</span><strong>${escape(receipt?.reference || entry.redemptionReference || '—')}</strong></div></div>
                    ${(receipt?.reference || entry.redemptionReference) ? `<button type="button" class="redeem-copy-reference" onclick="copyText('${escape(receipt?.reference || entry.redemptionReference)}','Reference copied.')" aria-label="Copy reference"><i data-lucide="copy"></i><span>Copy</span></button>` : ''}
                </div>
                <button class="btn btn-primary btn-lg redeem-withdraw-btn" onclick="navigateTo('withdraw')">Withdraw <span aria-hidden="true">→</span></button>
                <button class="redeem-done-link" type="button" onclick="resetRedeemReveal()">Done</button>
            </div>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    window.resetRedeemReveal = function () {
        const result = byId('redeemResult');
        byId('page-redeem')?.classList.remove('unseal-mode');
        if (result) {
            result.style.display = 'none';
            result.innerHTML = '';
            result.onclick = null;
        }
        renderRedeemHistory();
        getRedeemSegments()[0]?.focus();
        updateRedeemInputState();
    };

    function updateWithdrawValidation() {
        const amount = Number(byId('withdrawAmount')?.value || 0);
        const methodId = byId('withdrawMethod')?.value || '';
        const pin = byId('withdrawPin')?.value || '';
        const button = byId('withdrawSubmitBtn') || document.querySelector('#page-withdraw .btn-primary');
        if (button) button.id = 'withdrawSubmitBtn';
        const lifetimeRedeemedCards = getLifetimeRedeemedCards();
        const eligible = lifetimeRedeemedCards >= MIN_REDEEMED_CARDS_FOR_WITHDRAWAL;
        const valid = Number.isFinite(amount) && amount >= MIN_WITHDRAWAL && amount <= state.user.redeemedBalance && methodId && /^\d{4}$/.test(pin);
        if (button) button.disabled = !valid;
        updateWithdrawSummary();
        updateWithdrawInlineFeedback({ amount, methodId, pin, valid, eligible, lifetimeRedeemedCards });
        return valid;
    }

    function updateWithdrawInlineFeedback({ amount, methodId, pin, valid, eligible, lifetimeRedeemedCards }) {
        const result = byId('withdrawResult');
        if (!result || result.dataset.locked === 'success') return;
        const touched = Boolean(amount || methodId || pin);
        let message = '';
        if (touched && (!Number.isFinite(amount) || amount <= 0)) message = 'Enter an amount to withdraw.';
        else if (amount && amount < MIN_WITHDRAWAL) message = `Minimum withdrawal is GHS ${money(MIN_WITHDRAWAL)}.`;
        else if (amount > state.user.redeemedBalance) message = 'Withdrawal amount exceeds redeemed balance.';
        else if (amount && !methodId) message = 'Choose a saved withdrawal method.';
        else if ((amount || methodId) && pin && !/^\d{4}$/.test(pin)) message = 'PIN must be exactly 4 digits.';
        else if (valid) message = '';
        result.style.display = message ? 'block' : 'none';
        result.innerHTML = message ? `<div class="inline-alert error">${escape(message)}</div>` : '';
    }

    window.updateWithdrawSummary = function () {
        const amount = Number(byId('withdrawAmount')?.value || 0);
        const methodId = byId('withdrawMethod')?.value || '';
        const summary = byId('withdrawSummary');
        if (!summary) return;
        if (amount > 0 && methodId) {
            summary.style.display = 'block';
            const method = (state.methods || []).find(m => m.id === methodId);
            const breakdown = withdrawalBreakdown(amount);
            const sumAmount = byId('sumAmount');
            const sumMethod = byId('sumMethod');
            const sumTotal = byId('sumTotal');
            const rows = summary.querySelectorAll('.row');
            if (rows[2]) rows[2].innerHTML = `<span class="label">Operational charge (10%)</span><span class="value">GHS ${money(breakdown.operationalCharge)}</span>`;
            if (sumAmount) sumAmount.textContent = money(breakdown.requestedAmount);
            if (sumMethod) sumMethod.textContent = method ? `${method.network} - ${method.phone}` : '-';
            if (sumTotal) sumTotal.textContent = money(breakdown.actualAmount);
        } else {
            summary.style.display = 'none';
        }
    };

    window.handleWithdraw = function () {
        const amount = Number(byId('withdrawAmount')?.value || 0);
        const methodId = byId('withdrawMethod')?.value || '';
        const pin = byId('withdrawPin')?.value || '';
        const method = state.methods.find(m => m.id === methodId);
        const result = byId('withdrawResult');
        if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL) return error(result, `Minimum withdrawal is GHS ${money(MIN_WITHDRAWAL)}.`);
        if (amount > state.user.redeemedBalance) return error(result, 'Withdrawal amount exceeds redeemed balance.');
        if (!method) return error(result, 'Choose a saved withdrawal method.');
        if (!/^\d{4}$/.test(pin)) return error(result, 'Enter your 4-digit withdrawal PIN.');
        const lifetimeRedeemedCards = getLifetimeRedeemedCards();
        if (lifetimeRedeemedCards < MIN_REDEEMED_CARDS_FOR_WITHDRAWAL) {
            const remaining = MIN_REDEEMED_CARDS_FOR_WITHDRAWAL - lifetimeRedeemedCards;
            return openFlowSheet({ title: 'Withdrawal not available yet', body: `<p class="text-secondary">You need to redeem at least 3 cards before requesting a withdrawal. Please redeem ${remaining} more card${remaining === 1 ? '' : 's'} and try again.</p>`, primaryText: 'Ok', secondaryText: '', onPrimary: closeFlowSheet, variant: 'center' });
        }
        const breakdown = withdrawalBreakdown(amount);
        openFlowSheet({
            title: 'Confirm withdrawal',
            body: `
                <div class="flow-summary">
                    <div class="summary-row"><span>From</span><strong>Redeemed balance</strong></div>
                    <div class="summary-row"><span>Requested amount</span><strong>${ghs(breakdown.requestedAmount)}</strong></div>
                    <div class="summary-row"><span>Operational charge (10%)</span><strong>${ghs(breakdown.operationalCharge)}</strong></div>
                    <div class="summary-row"><span>Actual payout to admin</span><strong>${ghs(breakdown.actualAmount)}</strong></div>
                    <div class="summary-row"><span>Method</span><strong>${escape(method.network)} · ${escape(method.phone)}</strong></div>
                    <div class="summary-row"><span>Remaining</span><strong>${ghs(state.user.redeemedBalance - amount)}</strong></div>
                </div>
            `,
            primaryText: 'Submit withdrawal',
            onPrimary: () => completeWithdrawal({ amount, methodId, pin }),
        });
    };

    async function completeWithdrawal(payload) {
        const button = byId('flowPrimaryBtn');
        busy(button, true);
        showFlowLoading();
        try {
            const [data] = await Promise.all([
                api('/api/withdrawals', { method: 'POST', body: JSON.stringify(payload) }),
                new Promise(resolve => window.setTimeout(resolve, 1100)),
            ]);
            applyServerState(data.state, { refreshUI: false, reason: 'withdrawal' });
            closeFlowSheet();
            safeNavigate('withdraw', 'withdrawal-complete');
            refreshMountedUI('withdrawal-after-navigation');
            const pendingKyc = data.withdrawal.status === WITHDRAWAL_PENDING_KYC;
            const result = byId('withdrawResult');
            if (result && !pendingKyc) {
                result.dataset.locked = 'success';
                result.style.display = 'block';
                result.innerHTML = `<div class="inline-alert success">Withdrawal request submitted for admin approval. Reference ${escape(data.withdrawal.reference)}.</div>${formatReceipt(data.receipt)}`;
            }
            ['withdrawAmount', 'withdrawPin'].forEach(id => { const el = byId(id); if (el) el.value = ''; });
            byId('withdrawSummary') && (byId('withdrawSummary').style.display = 'none');
            updateWithdrawValidation();
            if (pendingKyc) showKycOptions(data.withdrawal.reference);
            else showToast('success', 'Withdrawal request submitted for admin approval.');
        } catch (e) {
            if (/Redeem \d+ more card/i.test(e.message)) {
                openFlowSheet({ title: 'Withdrawal not available yet', body: `<p class="text-secondary">To request a withdrawal, please redeem at least 3 cards. ${escape(e.message)}</p>`, primaryText: 'Ok', secondaryText: '', onPrimary: closeFlowSheet, variant: 'center' });
            } else showToast('error', e.message);
        } finally {
            busy(button, false);
        }
    }

    function showKycOptions(withdrawalReference) {
        openFlowSheet({
            title: 'Verify your identity',
        body: `<p class="text-secondary text-sm">Choose an option, then confirm to continue.</p><div class="kyc-choice-grid"><button class="kyc-choice" data-kyc-option="verify" type="button" onclick="selectKycOption('verify','${escape(withdrawalReference)}')"><span class="kyc-choice-top"><span>Verify identity</span><span class="kyc-time-tag">24–72 business hours</span></span><p>Upload your documents for account verification. Track the review status in Withdrawal History.</p></button><button class="kyc-choice" data-kyc-option="bypass" type="button" onclick="selectKycOption('bypass','${escape(withdrawalReference)}')"><span class="kyc-choice-top"><span>Continue without KYC</span><span class="kyc-time-tag instant">Instant</span></span><p class="kyc-caution">⚠️ Important: The GHS 70 verification fee is refundable. After successful payment, it appears as a separate KYC Fee Refund transaction linked to this withdrawal.</p></button></div>`,
            primaryText: 'Confirm selection',
            primaryDisabled: true,
            secondaryText: 'Cancel',
            onPrimary: closeFlowSheet,
        });
    }

    window.selectKycOption = function (option, withdrawalReference) {
        document.querySelectorAll('[data-kyc-option]').forEach(button => button.classList.toggle('selected', button.dataset.kycOption === option));
        const confirm = byId('flowPrimaryBtn');
        if (!confirm) return;
        confirm.disabled = false;
        confirm.textContent = option === 'verify' ? 'Continue to verification' : 'Continue to payment';
        confirm.onclick = option === 'verify'
            ? () => startKycVerification(withdrawalReference)
            : () => continueWithoutKyc(withdrawalReference);
    };

    window.continueWithoutKyc = function (withdrawalReference) {
        const withdrawal = (state.withdrawals || []).find(item => item.reference === withdrawalReference);
        if (!withdrawal || withdrawal.status !== WITHDRAWAL_PENDING_KYC) return showToast('error', 'KYC bypass is not available for this withdrawal.');
        openFlowSheet({
            title: 'Continue without KYC',
            body: `
                <div class="flow-summary">
                    <div class="summary-row"><span>Withdrawal</span><strong>${escape(withdrawal.reference)}</strong></div>
                    <div class="summary-row"><span>Requested amount</span><strong>${ghs(withdrawal.requestedAmount || withdrawal.amount)}</strong></div>
                    <div class="summary-row"><span>Actual payout</span><strong>${ghs(withdrawal.actualAmount)}</strong></div>
                    <div class="summary-row"><span>KYC bypass fee</span><strong>${ghs(KYC_BYPASS_FEE)} · Refundable</strong></div>
                </div>
                <p class="kyc-refund-note">⚠️ Important: The GHS 70 verification fee is refundable. After successful payment, it appears as a separate KYC Fee Refund transaction linked to this withdrawal, not as a Redeemed Balance credit.</p>
            `,
            primaryText: `Pay ${ghs(KYC_BYPASS_FEE)} securely`,
            onPrimary: () => startKycBypass(withdrawal.reference),
        });
    };

    window.startKycVerification = function (withdrawalReference) {
        const withdrawal = (state.withdrawals || []).find(item => item.reference === withdrawalReference);
        if (!withdrawal || withdrawal.status !== WITHDRAWAL_PENDING_KYC) return showToast('error', 'KYC is not required for this withdrawal.');
        if (state.user.kycStatus === 'PENDING') return openFlowSheet({ title: 'Verification in review', body: '<p class="text-secondary">Your documents are already being reviewed. Check Withdrawal History for the current status.</p>', primaryText: 'Close', onPrimary: closeFlowSheet });
        state.kycWithdrawalReference = withdrawalReference;
        closeFlowSheet();
        safeNavigate('kyc', 'kyc-document-upload');
        const name = byId('kycFullName'); const phone = byId('kycPhone');
        if (name) name.value = state.user.name || '';
        if (phone) phone.value = state.user.phone || '';
    };

    window.submitKycVerification = async function () {
        const withdrawalReference = state.kycWithdrawalReference;
        const button = byId('kycSubmitBtn');
        const identity = byId('kycIdentityDocument')?.files?.[0];
        const address = byId('kycAddressDocument')?.files?.[0];
        const result = byId('kycSubmissionResult');
        if (!withdrawalReference) return showToast('error', 'Your withdrawal reference is missing. Please return to withdrawals and try again.');
        if (!identity || !address) return error(result, 'Upload both your government-issued ID and proof of address.');
        const validDocument = file => ['image/jpeg', 'image/png', 'application/pdf'].includes(file.type) && file.size > 0 && file.size <= 5 * 1024 * 1024;
        if (!validDocument(identity) || !validDocument(address)) return error(result, 'Each document must be a JPG, PNG, or PDF file no larger than 5 MB.');
        busy(button, true);
        try {
            const readDocument = file => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error(`Could not read ${file.name}. Please choose the file again.`));
                reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, content: String(reader.result || '').split(',')[1] || '' });
                reader.readAsDataURL(file);
            });
            const documents = await Promise.all([readDocument(identity), readDocument(address)]);
            const data = await api('/api/kyc/submissions', { method: 'POST', body: JSON.stringify({ withdrawalReference, name: readInput('kycFullName').trim(), phone: readInput('kycPhone').trim(), documents }) });
            applyServerState(data.state, { refreshUI: false, reason: 'kyc-submitted' });
            state.kycWithdrawalReference = '';
            safeNavigate('withdraw', 'kyc-submitted');
            refreshMountedUI('kyc-submitted');
            openFlowSheet({ title: 'Documents submitted', body: '<div class="submission-success"><div class="submission-success-icon"><i data-lucide="check"></i></div><p class="text-secondary">Thank you. Your identity verification details have been submitted for review. Check Withdrawal History for updates.</p></div>', primaryText: 'Done', onPrimary: closeFlowSheet, variant: 'center' });
        } catch (e) { showToast('error', e.message); } finally { busy(button, false); }
    };

    async function startKycBypass(withdrawalReference) {
        const button = byId('flowPrimaryBtn');
        busy(button, true);
        try {
            const data = await api(`/api/withdrawals/${encodeURIComponent(withdrawalReference)}/kyc-bypass`, { method: 'POST', body: JSON.stringify({}) });
            if (data.handoffUrl) {
                if (button) button.textContent = 'Opening secure checkout…';
                window.location.assign(data.handoffUrl);
                return;
            }
            showToast('info', data.message || 'Your payment is being verified. Your withdrawal will update automatically once confirmation is received.');
            refreshMountedUI('kyc-bypass-initialization-pending');
        } catch (e) {
            showToast('error', e.message);
        } finally {
            busy(button, false);
        }
    }

    async function completeKycBypassFromUrl() {
        const params = new URLSearchParams(location.search);
        const reference = params.get('kyc_bypass_reference') || params.get('kyc_bypass_test');
        if (!reference) return false;
        try {
            const suffix = 'verify';
            console.debug('[PHANTOM CARDS] Verifying KYC bypass payment.');
            const data = await api(`/api/kyc-bypass-payments/${encodeURIComponent(reference)}/${suffix}`, { method: 'POST' });
            applyServerState(data.state, { refreshUI: false, reason: 'kyc-bypass-verified' });
            const confirmed = data.status === 'SUCCESS' || data.withdrawal?.kycBypassUsed === true || Boolean(data.refundReceipt);
            if (!confirmed) {
                history.replaceState({}, '', location.pathname || '/');
                safeNavigate('withdraw', 'kyc-bypass-verification-pending');
                refreshMountedUI('kyc-bypass-verification-pending');
                showToast('info', data.message || 'Your payment is being verified. Your withdrawal will update automatically once confirmation is received.');
                return true;
            }
            history.replaceState({}, '', location.pathname || '/');
            safeNavigate('withdraw', 'kyc-bypass-verified');
            refreshMountedUI('kyc-bypass-after-verification');
            showToast('success', 'KYC bypass confirmed. Your GHS 70.00 KYC Fee Refund is recorded in Withdrawal History.');
            openFlowSheet({
                title: 'Withdrawal approved',
                body: formatReceipt(data.refundReceipt || data.receipt),
                primaryText: 'View withdrawals',
                onPrimary: () => {
                    closeFlowSheet();
                    safeNavigate('withdraw', 'kyc-bypass-receipt');
                },
                secondaryText: 'Close',
            });
            return true;
        } catch (e) {
            // Keep the user in the withdrawals flow when the payment callback is
            // delayed. The callback URL is a payment result, not a normal app
            // visit, so falling through to the homepage hides the useful state.
            safeNavigate('withdraw', 'kyc-bypass-verification-pending');
            refreshMountedUI('kyc-bypass-verification-pending');
            showToast('error', `${e.message} Reference ${reference}.`);
            return false;
        }
    }

    function validateMethodSheet() {
        const network = byId('methodNetwork')?.value || '';
        const accountName = byId('methodAccountName')?.value.trim() || '';
        const phone = byId('methodPhone')?.value.trim() || '';
        const pin = byId('methodPin')?.value.trim() || '';
        const result = byId('methodSheetResult');
        const button = byId('flowPrimaryBtn');
        const valid = network && accountName.length >= 2 && phone.replace(/\D/g, '').length >= 9 && /^\d{4}$/.test(pin);
        if (result) {
            result.innerHTML = !valid && (network || accountName || phone || pin)
                ? '<div class="inline-alert error">Enter a network, account name, valid phone number, and 4-digit PIN.</div>'
                : '';
        }
        if (button) button.disabled = !valid;
        return valid;
    }

    window.validateMethodSheet = validateMethodSheet;

    window.showAddMethod = function () {
        if (!state.isLoggedIn) {
            showToast('warning', 'Please log in to manage withdrawal methods.');
            return safeNavigate('login', 'method-auth');
        }
        openFlowSheet({
            title: 'Add withdrawal method',
            body: `
                <div class="flow-summary">
                    <div class="input-group">
                        <label for="methodNetwork">Network</label>
                        <div class="input-wrap">
                            <select id="methodNetwork" onchange="validateMethodSheet()">
                                <option value="">Choose network</option>
                                <option value="MTN Mobile Money">MTN Mobile Money</option>
                                <option value="Telecel Cash">Telecel Cash</option>
                                <option value="AT Cash">AT Cash</option>
                            </select>
                        </div>
                    </div>
                    <div class="input-group">
                        <label for="methodAccountName">Account name</label>
                        <div class="input-wrap"><input id="methodAccountName" type="text" autocomplete="name" oninput="validateMethodSheet()" placeholder="Name on mobile money account" /></div>
                    </div>
                    <div class="input-group">
                        <label for="methodPhone">Mobile money number</label>
                        <div class="input-wrap"><input id="methodPhone" type="tel" inputmode="tel" autocomplete="tel" oninput="validateMethodSheet()" placeholder="024 123 4567" /></div>
                    </div>
                    <div class="input-group">
                        <label for="methodPin">${state.user.hasPin ? 'Confirm withdrawal PIN' : 'Set withdrawal PIN'}</label>
                        <div class="input-wrap"><input id="methodPin" type="password" maxlength="4" inputmode="numeric" pattern="[0-9]*" oninput="validateMethodSheet()" placeholder="4 digits" /></div>
                        <div class="help-text">This PIN is required before withdrawals move redeemed funds.</div>
                    </div>
                    <div id="methodSheetResult"></div>
                </div>
            `,
            primaryText: 'Save method',
            primaryDisabled: true,
            onPrimary: saveMethodFromSheet,
        });
    };

    async function saveMethodFromSheet() {
        if (!validateMethodSheet()) return;
        const payload = {
            network: byId('methodNetwork')?.value,
            accountName: byId('methodAccountName')?.value.trim(),
            phone: byId('methodPhone')?.value.trim(),
            pin: byId('methodPin')?.value.trim(),
        };
        const button = byId('flowPrimaryBtn');
        busy(button, true);
        try {
            const data = await api('/api/methods', { method: 'POST', body: JSON.stringify(payload) });
            applyServerState(data.state, { reason: 'method-added' });
            closeFlowSheet();
            showToast('success', 'Withdrawal method saved.');
        } catch (e) {
            error(byId('methodSheetResult'), e.message);
        } finally {
            busy(button, false);
            validateMethodSheet();
        }
    }

    window.showPasswordChangeSheet = function () {
        openFlowSheet({
            title: 'Change password',
            body: `
                <div class="flow-summary">
                    <div class="input-group">
                        <label for="currentPassword">Current password</label>
                        <div class="input-wrap"><input id="currentPassword" type="password" autocomplete="current-password" /></div>
                    </div>
                    <div class="input-group">
                        <label for="newPassword">New password</label>
                        <div class="input-wrap"><input id="newPassword" type="password" autocomplete="new-password" /></div>
                        <div class="help-text">Use at least 6 characters.</div>
                    </div>
                    <div class="input-group">
                        <label for="confirmNewPassword">Confirm new password</label>
                        <div class="input-wrap"><input id="confirmNewPassword" type="password" autocomplete="new-password" /></div>
                    </div>
                    <div id="passwordChangeResult"></div>
                </div>
            `,
            primaryText: 'Update password',
            onPrimary: savePasswordChange,
        });
    };

    async function savePasswordChange() {
        const currentPassword = byId('currentPassword')?.value || '';
        const newPassword = byId('newPassword')?.value || '';
        const confirm = byId('confirmNewPassword')?.value || '';
        const result = byId('passwordChangeResult');
        if (!currentPassword) return error(result, 'Enter your current password.');
        if (newPassword.length < 6) return error(result, 'New password must be at least 6 characters.');
        if (newPassword !== confirm) return error(result, 'New passwords do not match.');
        const button = byId('flowPrimaryBtn');
        busy(button, true);
        try {
            const data = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
            applyServerState(data.state, { reason: 'password-changed' });
            closeFlowSheet();
            showToast('success', 'Password updated.');
        } catch (e) {
            error(result, e.message);
        } finally {
            busy(button, false);
        }
    }

    window.showPinChangeSheet = function () {
        openFlowSheet({
            title: state.user.hasPin ? 'Change withdrawal PIN' : 'Set withdrawal PIN',
            body: `
                <div class="flow-summary">
                    ${state.user.hasPin ? `
                        <div class="input-group">
                            <label for="currentPin">Current PIN</label>
                            <div class="input-wrap"><input id="currentPin" type="password" maxlength="4" inputmode="numeric" pattern="[0-9]*" /></div>
                        </div>
                    ` : ''}
                    <div class="input-group">
                        <label for="newPin">New PIN</label>
                        <div class="input-wrap"><input id="newPin" type="password" maxlength="4" inputmode="numeric" pattern="[0-9]*" /></div>
                    </div>
                    <div class="input-group">
                        <label for="confirmNewPin">Confirm new PIN</label>
                        <div class="input-wrap"><input id="confirmNewPin" type="password" maxlength="4" inputmode="numeric" pattern="[0-9]*" /></div>
                    </div>
                    <div id="pinChangeResult"></div>
                </div>
            `,
            primaryText: state.user.hasPin ? 'Update PIN' : 'Set PIN',
            onPrimary: savePinChange,
        });
    };

    async function savePinChange() {
        const currentPin = byId('currentPin')?.value || '';
        const newPin = byId('newPin')?.value || '';
        const confirm = byId('confirmNewPin')?.value || '';
        const result = byId('pinChangeResult');
        if (state.user.hasPin && !/^\d{4}$/.test(currentPin)) return error(result, 'Enter your current 4-digit PIN.');
        if (!/^\d{4}$/.test(newPin)) return error(result, 'New withdrawal PIN must be four digits.');
        if (newPin !== confirm) return error(result, 'New PIN entries do not match.');
        const button = byId('flowPrimaryBtn');
        busy(button, true);
        try {
            const data = await api('/api/auth/pin', { method: 'POST', body: JSON.stringify({ currentPin, newPin }) });
            applyServerState(data.state, { reason: 'pin-changed' });
            closeFlowSheet();
            showToast('success', 'Withdrawal PIN updated.');
        } catch (e) {
            error(result, e.message);
        } finally {
            busy(button, false);
        }
    }

    window.openSupportSheet = function (topic = 'account', reference = '') {
        const recentRefs = (state.transactions || []).slice(0, 5).map(tx => tx.id || tx.reference).filter(Boolean).join(', ');
        const body = [
            `Topic: ${topic}`,
            `User: ${state.user?.email || 'signed out'}`,
            reference ? `Reference: ${reference}` : '',
            `Wallet balance: ${ghs(state.user?.walletBalance || 0)}`,
            `Redeemed balance: ${ghs(state.user?.redeemedBalance || 0)}`,
            recentRefs ? `Recent references: ${recentRefs}` : 'Recent references: none',
        ].filter(Boolean).join('\n');
        openFlowSheet({
            title: 'Support details',
            body: `
                <div class="flow-summary">
                    <div class="inline-alert info">Share these details with support so they can locate the account action quickly.</div>
                    <pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:12px;font-size:0.78rem;">${escape(body)}</pre>
                </div>
            `,
            primaryText: 'Copy details',
            onPrimary: () => copyText(body, 'Support details copied.'),
            secondaryText: 'Close',
        });
    };

    window.selectMethod = async function (id) {
        const previous = (state.methods || []).map(method => ({ ...method }));
        state.methods = previous.map(method => ({ ...method, isDefault: method.id === id }));
        renderMethods();
        renderWithdrawMethods();
        try {
            const data = await api(`/api/methods/${encodeURIComponent(id)}/default`, { method: 'POST', body: '{}' });
            applyServerState(data.state, { refreshUI: false, reason: 'method-default-updated' });
            refreshMountedUI('method-default-updated');
            showToast('success', 'Default withdrawal method updated.');
        } catch (error) {
            state.methods = previous;
            renderMethods();
            renderWithdrawMethods();
            showToast('error', error.message || 'Could not update the default method.');
        }
    };

    window.handleContact = async function (event) {
        event?.preventDefault?.();
        const form = event?.target || byId('contactForm');
        const button = form?.querySelector('button[type="submit"]');
        const values = {
            name: byId('contactName')?.value.trim() || '',
            email: byId('contactEmail')?.value.trim() || '',
            subject: byId('contactSubject')?.value.trim() || '',
            message: byId('contactMessage')?.value.trim() || '',
        };
        if (!values.name || !values.email || !values.subject || !values.message) return showToast('error', 'Complete all contact fields before sending.');
        if (button) button.disabled = true;
        try {
            const data = await api('/api/support/messages', { method: 'POST', body: JSON.stringify(values) });
            form?.reset();
            showToast('success', data.message || 'Your message was received.');
        } catch (error) {
            showToast('error', error.message || 'Could not send your message.');
        } finally {
            if (button) button.disabled = false;
        }
    };

    window.renderMethods = function () {
        const container = byId('methodList');
        const empty = byId('methodEmpty');
        if (!container) return;
        const methods = state.methods || [];
        if (!methods.length) {
            container.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }
        empty?.classList.add('hidden');
        const networkMarks = { 'MTN Mobile Money': 'MTN', 'Telecel Cash': 'TC', 'AT Cash': 'AT' };
        container.innerHTML = methods.map(method => `
            <button class="method-card ${method.isDefault ? 'selected' : ''}" type="button" onclick="selectMethod('${escape(method.id)}')">
                <span class="method-icon">${escape(networkMarks[method.network] || 'MM')}</span>
                <span class="method-info">
                    <span class="method-name">${escape(method.network)}${method.isDefault ? ' · Default' : ''}</span>
                    <span class="method-detail">${escape(method.accountName)} · ${escape(method.phone)}</span>
                </span>
                <span class="method-check">${method.isDefault ? '✓' : ''}</span>
            </button>
        `).join('');
    };

    window.renderWithdrawMethods = function () {
        const select = byId('withdrawMethod');
        if (!select) return;
        const current = select.value;
        const methods = state.methods || [];
        select.innerHTML = '<option value="">Select a method</option>' + methods.map(method =>
            `<option value="${escape(method.id)}">${escape(method.network)} - ${escape(method.phone)}</option>`
        ).join('');
        const preferred = methods.find(method => method.id === current) || methods.find(method => method.isDefault);
        if (preferred) select.value = preferred.id;
        updateWithdrawValidation();
    };

    function maskWithdrawalPhone(phone) {
        const value = String(phone || '').trim();
        if (value.length <= 8) return value;
        return `${value.slice(0, 3)}•••${value.slice(-5)}`;
    }

    window.renderWithdrawalStatusList = function () {
        const container = byId('withdrawalStatusList');
        const empty = byId('withdrawalStatusEmpty');
        if (!container) return;
        const withdrawals = [...(state.withdrawals || [])].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        if (!withdrawals.length) {
            container.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }
        empty?.classList.add('hidden');
        // Keep each refund directly below the withdrawal it belongs to, even
        // though the refund was created a moment later and would otherwise
        // sort above the original entry.
        const regularWithdrawals = withdrawals.filter(item => !item.isRefund);
        const refunds = withdrawals.filter(item => item.isRefund);
        const historyItems = [];
        regularWithdrawals.forEach(item => {
            historyItems.push(item);
            refunds.filter(refund => refund.refundForWithdrawalId === item.id || refund.refundForWithdrawalReference === item.reference).forEach(refund => historyItems.push(refund));
        });
        refunds.filter(refund => !regularWithdrawals.some(item => refund.refundForWithdrawalId === item.id || refund.refundForWithdrawalReference === item.reference)).forEach(refund => historyItems.push(refund));
        container.innerHTML = historyItems.map(item => {
            if (item.isRefund) {
                const originalReference = item.refundForWithdrawalReference || item.related?.withdrawalReference || 'Linked withdrawal';
                const refundDate = item.refundedAt || item.createdAt;
                return `
                    <div class="withdrawal-status-item withdrawal-refund-item">
                        <div>
                            <div class="withdrawal-status-title">
                                <span class="status-badge refunded">REFUNDED</span>
                                <span>KYC Fee Refund</span>
                            </div>
                            <div class="withdrawal-status-meta">Type: KYC Fee Refund · Automatically returned after the GHS 70.00 bypass payment.</div>
                            <div class="withdrawal-status-meta">Original withdrawal: ${escape(originalReference)} · ${escape(formatFullDate(refundDate))}</div>
                        </div>
                        <div style="text-align:right;">
                            <div class="withdrawal-status-amount refund-amount">+ ${ghs(item.actualAmount ?? item.amount)}</div>
                            <button class="btn btn-secondary btn-sm mt-3" type="button" onclick="showReceipt('${escape(item.reference)}')">Refund receipt</button>
                        </div>
                    </div>
                    <article class="withdrawal-status-mobile withdrawal-refund-mobile">
                        <div class="withdrawal-mobile-header">
                            <span class="withdrawal-mobile-status refunded"><span class="withdrawal-mobile-status-mark" aria-hidden="true">↩</span>REFUNDED</span>
                            <strong class="withdrawal-mobile-amount refund-amount">+ ${ghs(item.actualAmount ?? item.amount)}</strong>
                        </div>
                        <div class="withdrawal-mobile-title">KYC Fee Refund</div>
                        <div class="withdrawal-mobile-description">Automatically returned after the GHS 70.00 bypass payment.</div>
                        <div class="withdrawal-mobile-meta"><span>Type: KYC Fee Refund</span><span>Original withdrawal: ${escape(originalReference)}</span><span>${escape(formatFullDate(refundDate))}</span></div>
                        <div class="withdrawal-mobile-footer">
                            <span class="withdrawal-mobile-reference">Ref: ${escape(item.reference)}</span>
                            <button class="withdrawal-mobile-receipt" type="button" onclick="showReceipt('${escape(item.reference)}')">Refund receipt <span aria-hidden="true">→</span></button>
                        </div>
                    </article>
                `;
            }
            const method = (state.methods || []).find(method => method.id === item.methodId);
            const receipt = (state.receipts || []).find(receipt => receipt.reference === item.reference);
            const status = statusClass(item.status);
            const requestedAmount = item.requestedAmount ?? item.amount;
            const actualAmount = item.actualAmount ?? item.amount;
            const charge = Number(item.operationalCharge || 0);
            const refundReference = item.kycBypassRefundReference || '';
            const refundLinkMarkup = item.kycBypassRefunded && refundReference ? `<div class="withdrawal-status-meta withdrawal-refund-link">KYC Fee Refund recorded below as a separate transaction · Ref: ${escape(refundReference)}</div>` : '';
            const bypassAwaitingPayment = item.status === WITHDRAWAL_PENDING_KYC && ['bypass_initialized', 'initialization_unknown', 'reconciliation_pending'].includes(item.paymentStatus);
            const help = item.status === 'pending'
                ? 'Waiting for admin approval.'
                : item.status === WITHDRAWAL_PENDING_KYC
                    ? bypassAwaitingPayment
                        ? 'GHS 70.00 Paystack payment is awaiting confirmation. This withdrawal stays pending until that payment succeeds.'
                        : 'KYC Verification Required. Usually takes 24-72 hours of business operation time.'
                : item.status === 'approved'
                    ? item.kycBypassUsed
                        ? 'Auto-approved after payment confirmation. The GHS 70.00 bypass fee has been refunded.'
                        : 'Approved by admin for payout.'
                    : item.status === 'processing'
                        ? 'Payout is being processed.'
                        : item.status === 'completed'
                            ? 'Payout completed.'
                    : item.status === 'rejected'
                        ? 'Rejected. Funds were returned to redeemed balance.'
                        : statusLabel(item.status);
            const mobileMethod = method ? `${method.network} · ${maskWithdrawalPhone(method.phone)}` : 'Saved mobile money method';
            const mobileStatus = item.status === WITHDRAWAL_PENDING_KYC ? 'PENDING KYC' : statusLabel(item.status).toUpperCase();
            const mobileTitle = item.status === 'approved'
                ? 'Withdrawal approved'
                : item.status === 'processing'
                    ? 'Withdrawal processing'
                    : item.status === 'completed'
                        ? 'Withdrawal completed'
                : item.status === 'pending'
                    ? 'Withdrawal pending'
                    : item.status === WITHDRAWAL_PENDING_KYC
                        ? 'KYC verification required'
                        : item.status === 'rejected'
                            ? 'Withdrawal rejected'
                            : 'Withdrawal update';
            const mobileDescription = item.status === 'approved'
                ? (item.kycBypassUsed ? 'KYC bypass payment' : 'Approved by admin for payout')
                : item.status === 'processing'
                    ? 'Payout is being processed'
                    : item.status === 'completed'
                        ? 'Payout completed'
                : item.status === 'pending'
                    ? 'Waiting for admin approval'
                    : item.status === WITHDRAWAL_PENDING_KYC
                        ? (bypassAwaitingPayment ? 'GHS 70.00 payment awaiting confirmation' : 'Choose KYC verification or pay the bypass fee')
                        : item.status === 'rejected'
                            ? 'Funds returned to redeemed balance'
                            : help;
            const meta = [
                method ? `${method.network} - ${method.phone}` : 'Saved mobile money method',
                formatFullDate(item.approvedAt || item.rejectedAt || item.createdAt),
                item.reference,
            ].filter(Boolean).join(' · ');
            return `
                <div class="withdrawal-status-item">
                    <div>
                        <div class="withdrawal-status-title">
                            <span class="status-badge ${escape(status)}">${escape(statusLabel(item.status))}</span>
                            <span>${escape(help)}</span>
                        </div>
                        <div class="withdrawal-status-meta">${escape(meta)}</div>
                        ${item.adminNote ? `<div class="withdrawal-status-meta">Admin note: ${escape(item.adminNote)}</div>` : ''}
                        ${item.status === WITHDRAWAL_PENDING_KYC ? `<div class="withdrawal-status-meta">${bypassAwaitingPayment ? `Paystack is confirming the refundable ${ghs(KYC_BYPASS_FEE)} fee. No approval is granted until confirmation succeeds.` : `Choose KYC verification, or pay the refundable ${ghs(KYC_BYPASS_FEE)} bypass fee to auto-approve this withdrawal.`}</div>` : ''}
                        ${refundLinkMarkup}
                    </div>
                    <div style="text-align:right;">
                        <div class="withdrawal-status-amount">${ghs(item.actualAmount ?? item.amount)}</div>
                        ${Number(item.operationalCharge || 0) > 0 ? `<div class="withdrawal-status-meta">Requested ${ghs(item.requestedAmount || item.amount)} · Charge ${ghs(item.operationalCharge)}</div>` : ''}
                        ${item.status === WITHDRAWAL_PENDING_KYC ? `<button class="btn btn-secondary btn-sm mt-3" type="button" onclick="startKycVerification('${escape(item.reference)}')">Complete KYC</button><button class="btn btn-primary btn-sm mt-3" type="button" onclick="continueWithoutKyc('${escape(item.reference)}')">${bypassAwaitingPayment ? 'Resume GHS 70.00 payment' : 'Pay GHS 70.00'}</button>` : ''}
                        ${receipt ? `<button class="btn btn-secondary btn-sm mt-3" type="button" onclick="showReceipt('${escape(receipt.reference)}')">Receipt</button>` : ''}
                    </div>
                </div>
                <article class="withdrawal-status-mobile">
                    <div class="withdrawal-mobile-header">
                        <span class="withdrawal-mobile-status ${escape(status)}"><span class="withdrawal-mobile-status-mark" aria-hidden="true">${status === 'approved' ? '✓' : status === 'rejected' ? '×' : '•'}</span>${escape(mobileStatus)}</span>
                        <strong class="withdrawal-mobile-amount">${ghs(actualAmount)}</strong>
                    </div>
                    <div class="withdrawal-mobile-title">${escape(mobileTitle)}</div>
                    <div class="withdrawal-mobile-description">${escape(mobileDescription)}</div>
                    <div class="withdrawal-mobile-meta">
                        <span>${escape(mobileMethod)}</span>
                        <span>${escape(formatFullDate(item.approvedAt || item.rejectedAt || item.createdAt))}</span>
                    </div>
                    <div class="withdrawal-mobile-financials">
                        <div><span>Requested</span><strong>${ghs(requestedAmount)}</strong></div>
                        ${charge > 0 ? `<div><span>Fee</span><strong>${ghs(charge)}</strong></div>` : ''}
                    </div>
                    ${item.adminNote ? `<div class="withdrawal-mobile-note">Admin note: ${escape(item.adminNote)}</div>` : ''}
                    ${refundLinkMarkup}
                    ${item.status === WITHDRAWAL_PENDING_KYC ? `<div class="withdrawal-mobile-actions"><button class="btn btn-secondary btn-sm" type="button" onclick="startKycVerification('${escape(item.reference)}')">Complete KYC</button><button class="btn btn-primary btn-sm" type="button" onclick="continueWithoutKyc('${escape(item.reference)}')">${bypassAwaitingPayment ? 'Resume payment' : 'Pay GHS 70.00'}</button></div>` : ''}
                    <div class="withdrawal-mobile-footer">
                        <span class="withdrawal-mobile-reference">Ref: ${escape(item.reference)}</span>
                        ${receipt ? `<button class="withdrawal-mobile-receipt" type="button" onclick="showReceipt('${escape(receipt.reference)}')">Receipt <span aria-hidden="true">→</span></button>` : ''}
                    </div>
                </article>
            `;
        }).join('');
    };

    const SHOP_PRICE_RANGES = [
        { key: 'starter', label: '$3–$5', min: 3, max: 5 },
        { key: 'core', label: '$6–$10', min: 6, max: 10 },
        { key: 'premium', label: '$11–$20', min: 11, max: 20 },
        { key: 'vault', label: '$21–$50', min: 21, max: 50 },
    ];

    function ghanaDateNow() {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(new Date()).reduce((result, part) => { if (part.type !== 'literal') result[part.type] = part.value; return result; }, {});
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    function purchasePriceKey(card) {
        return Number(card?.price || 0).toFixed(2);
    }

    function dailyPurchaseCount(card) {
        const limits = state.purchaseLimits || {};
        return limits.date === ghanaDateNow() ? Number(limits.counts?.[purchasePriceKey(card)] || 0) : 0;
    }

    function dailyPurchaseLimitReached(card) {
        return dailyPurchaseCount(card) >= Number(state.purchaseLimits?.maxPerPrice || 2);
    }

    function nextGhanaMidnight() {
        const resetAt = Number(new Date(state.purchaseLimits?.resetAt || '').getTime());
        if (Number.isFinite(resetAt) && resetAt > Date.now()) return resetAt;
        const [year, month, day] = ghanaDateNow().split('-').map(Number);
        return Date.UTC(year, month - 1, day + 1);
    }

    function countdownText(milliseconds) {
        const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `Resets in ${hours}h ${minutes}m ${seconds}s`;
    }

    function updateDailyPurchaseCountdowns() {
        const today = ghanaDateNow();
        if (state.purchaseLimits?.date && state.purchaseLimits.date !== today) {
            const [year, month, day] = today.split('-').map(Number);
            const nextReset = new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
            state.purchaseLimits = { ...(state.purchaseLimits || {}), date: today, counts: {}, resetAt: nextReset };
            window.renderShopCards?.();
            window.renderPriceRails?.();
            refresh().catch(() => {});
            return;
        }
        const resetAt = nextGhanaMidnight();
        const remaining = resetAt - Date.now();
        if (remaining <= 0) {
            state.purchaseLimits = { ...(state.purchaseLimits || {}), date: ghanaDateNow(), counts: {}, resetAt: new Date(resetAt + 86400000).toISOString() };
            window.renderShopCards?.();
            window.renderPriceRails?.();
            refresh().catch(() => {});
            return;
        }
        document.querySelectorAll('[data-daily-countdown-card]').forEach(el => {
            el.textContent = countdownText(remaining);
        });
    }

    let dailyPurchaseTimer = null;
    function startDailyPurchaseCountdown() {
        if (dailyPurchaseTimer) return;
        dailyPurchaseTimer = window.setInterval(updateDailyPurchaseCountdowns, 1000);
        updateDailyPurchaseCountdowns();
    }

    function cardIsAvailable(card) {
        return Boolean(card && card.active !== false && Number(card.stock || 0) > 0 && !dailyPurchaseLimitReached(card));
    }

    function cardVisual(card) {
        const fallback = { series: card?.series || 'Phantom Reserve', rgb: card?.rgb || '245,166,35' };
        try {
            return typeof getCardVisual === 'function' ? { ...fallback, ...getCardVisual(card) } : fallback;
        } catch {
            return fallback;
        }
    }

    // Product-face palettes only. Categories share the same charcoal, ivory,
    // and gold family so server-supplied artwork colors never change the Shop
    // visual language.
    function cardTheme(category) {
        const dark = {
            rgb: '216,162,27',
            face: 'linear-gradient(135deg, #302E29 0%, #3B382F 52%, #24221E 100%)',
            ink: '#F7F1E6',
            muted: 'rgba(247,241,230,0.72)',
            overlay: 'linear-gradient(135deg, rgba(216,162,27,0.18) 0%, transparent 48%), linear-gradient(180deg, rgba(48,46,41,0.03) 0%, rgba(48,46,41,0.26) 55%, rgba(24,23,20,0.52) 100%)',
        };
        const themes = {
            Digital: dark,
            Collectible: {
                rgb: '185,133,11',
                face: 'linear-gradient(135deg, #FFF9EE 0%, #F7F1E6 58%, #EDE1C9 100%)',
                ink: '#302E29', muted: 'rgba(48,46,41,0.68)',
                overlay: 'linear-gradient(135deg, rgba(185,133,11,0.15) 0%, transparent 48%), linear-gradient(180deg, rgba(255,249,238,0.06) 0%, rgba(247,241,230,0.08) 55%, rgba(185,133,11,0.14) 100%)',
            },
            Access: {
                rgb: '142,138,94',
                face: 'linear-gradient(135deg, #FFF9EE 0%, #F7F1E6 56%, #E7E2C9 100%)',
                ink: '#302E29', muted: 'rgba(48,46,41,0.68)',
                overlay: 'linear-gradient(135deg, rgba(142,138,94,0.13) 0%, transparent 48%), linear-gradient(180deg, rgba(255,249,238,0.04) 0%, rgba(216,162,27,0.04) 58%, rgba(142,138,94,0.13) 100%)',
            },
            Gaming: {
                rgb: '185,133,11',
                face: 'linear-gradient(135deg, #3A3730 0%, #302E29 55%, #24221E 100%)',
                ink: '#F7F1E6', muted: 'rgba(247,241,230,0.72)',
                overlay: 'linear-gradient(135deg, rgba(185,133,11,0.17) 0%, transparent 48%), linear-gradient(180deg, transparent 0%, rgba(24,23,20,0.48) 100%)',
            },
            Crypto: {
                rgb: '142,138,94',
                face: 'linear-gradient(135deg, #F7F1E6 0%, #EEE6D8 55%, #DED4BF 100%)',
                ink: '#302E29', muted: 'rgba(48,46,41,0.68)',
                overlay: 'linear-gradient(135deg, rgba(142,138,94,0.12) 0%, transparent 48%), linear-gradient(180deg, transparent 0%, rgba(185,133,11,0.11) 100%)',
            },
            Exclusive: dark,
            Limited: { ...dark, rgb: '185,133,11', face: 'linear-gradient(135deg, #302E29 0%, #42391F 55%, #24221E 100%)' },
            Rare: { ...dark, rgb: '216,162,27', face: 'linear-gradient(135deg, #24231F 0%, #302E29 52%, #1D1C19 100%)' },
        };
        return themes[category] || dark;
    }

    function cardFaceStyle(category) {
        const theme = cardTheme(category);
        return `background:${theme.face}; --card-rgb:${theme.rgb}; --card-ink:${theme.ink}; --card-muted:${theme.muted}; --card-overlay:${theme.overlay};`;
    }

    function renderCardTileReal(card, context = 'grid') {
        const visual = cardVisual(card);
        const stockAvailable = Boolean(card && card.active !== false && Number(card.stock || 0) > 0);
        const limitReached = dailyPurchaseLimitReached(card);
        const available = stockAvailable && !limitReached;
        const sizeClass = context === 'rail' ? 'rail-card market-card' : 'product-card market-card';
        const faceStyle = cardFaceStyle(card.category);
        const potentialRedeem = rewardRangeCardText(card);
        const artMark = {
            Digital: '✦', Collectible: '◇', Gaming: '◈', Crypto: '₿',
            Access: '⌁', Exclusive: '✧', Limited: '◆', Rare: '✦',
        }[card.category] || '✦';
        return `
            <div class="${sizeClass} ${available ? '' : 'is-unavailable'}">
                <div class="market-card-top">
                    <div class="market-art" style="${faceStyle}" onclick="${available ? `showDetail('${escape(card.id)}')` : ''}" role="button" tabindex="0" aria-label="View ${escape(card.title)}">
                        <span class="market-art-mark" aria-hidden="true">${artMark}</span>
                        ${available ? '' : `<button class="availability-info-btn" type="button" onclick="event.stopPropagation();showAvailabilityInfo('${escape(card.id)}')" aria-label="Why ${escape(card.title)} is unavailable"><i data-lucide="info"></i></button>`}
                        ${limitReached ? '<span class="market-art-unavailable">Limit reached</span>' : (stockAvailable ? '' : '<span class="market-art-unavailable">Out of stock</span>')}
                    </div>
                    <span class="market-type ${available ? '' : 'unavailable'}"><span class="chip-dot"></span>${limitReached ? 'Limit reached' : (stockAvailable ? escape(card.category) : 'Out of stock')}</span>
                </div>
                <div class="market-card-info">
                    <h3>${escape(card.title)}</h3>
                    <p>${escape(card.category)} · ${available ? 'Sealed card' : 'Unavailable'}</p>
                </div>
                <div class="market-card-values">
                    <div>
                        <span>Card price</span>
                        <strong>$${money(card.price)}</strong>
                    </div>
                    <div class="redeem">
                        <span>Potential redeem</span>
                        <strong>${escape(potentialRedeem)}</strong>
                    </div>
                </div>
                <button class="btn btn-primary buy-btn ${limitReached ? 'daily-limit-reached' : ''}" onclick="handlePurchase('${escape(card.id)}')" ${available ? '' : 'disabled'}>${available ? 'BUY NOW <span aria-hidden="true">→</span>' : (limitReached ? 'Limit Reached' : 'OUT OF STOCK')}</button>
                ${limitReached ? `<small class="daily-limit-countdown" data-daily-countdown-card="${escape(card.id)}">${countdownText(Math.max(0, nextGhanaMidnight() - Date.now()))}</small>` : ''}
            </div>
        `;
    }

    window.renderCardTile = renderCardTileReal;

    window.renderPriceRails = function () {
        const container = byId('priceRailsContainer');
        const grid = byId('shopGrid');
        if (!container || !grid) return;
        container.innerHTML = '';
        grid.style.display = 'grid';
    };

    window.renderShopCards = function () {
        const grid = byId('shopGrid');
        const empty = byId('shopEmpty');
        if (!grid || !empty) return;
        let filtered = [...(state.cards || [])];
        const categoryFilter = state.categoryFilter ?? (SHOP_PRICE_RANGES.some(item => item.key === state.filter) ? 'all' : state.filter);
        const priceFilter = state.priceFilter ?? (SHOP_PRICE_RANGES.some(item => item.key === state.filter) ? state.filter : 'all');
        if (categoryFilter !== 'all') filtered = filtered.filter(card => card.category === categoryFilter);
        if (priceFilter !== 'all') {
            const range = SHOP_PRICE_RANGES.find(item => item.key === priceFilter);
            if (range) filtered = filtered.filter(card => Number(card.price) >= range.min && Number(card.price) <= range.max);
        }
        if (String(state.search || '').trim()) {
            const query = state.search.toLowerCase().trim();
            filtered = filtered.filter(card => [card.title, card.category, card.series].some(value => String(value || '').toLowerCase().includes(query)));
        }
        const sortVal = byId('sortSelect')?.value || 'price-low';
        if (sortVal === 'price-low') filtered.sort((a, b) => Number(a.price) - Number(b.price));
        else if (sortVal === 'price-high') filtered.sort((a, b) => Number(b.price) - Number(a.price));
        else if (sortVal === 'name') filtered.sort((a, b) => String(a.title).localeCompare(String(b.title)));
        if (!filtered.length) {
            grid.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        grid.innerHTML = filtered.map(card => renderCardTileReal(card, 'grid')).join('');
        window.renderPriceRails();
        startDailyPurchaseCountdown();
    };

    window.filterCards = function () {
        state.search = byId('shopSearch')?.value || '';
        window.renderShopCards();
        window.renderPriceRails();
    };

    window.showDetail = function (cardId) {
        const card = (state.cards || []).find(item => item.id === cardId);
        if (!card) return showToast('error', 'This card is unavailable.');
        if (!state.isLoggedIn) {
            showToast('warning', 'Please log in to view card details.');
            return safeNavigate('login', 'detail-auth');
        }
        const limitReached = dailyPurchaseLimitReached(card);
        const available = cardIsAvailable(card);
        const stockAvailable = card.active !== false && Number(card.stock || 0) > 0;
        const visual = cardVisual(card);
        const price = Number(card.actualPrice || card.priceGhs || card.price * 12);
        const potentialRedeem = rewardRangeText(card, price);
        const container = byId('detailContent');
        if (!container) return;
        safeNavigate('detail', 'card-detail');
        const faceStyle = cardFaceStyle(card.category);
        container.innerHTML = `
            <div class="card" style="background:var(--bg-card);">
                <div class="market-card ${available ? '' : 'is-unavailable'}" style="max-width:520px;margin:0 auto 18px;">
                    <div class="card-face" style="${faceStyle}cursor:default;">
                        <span class="sealed-chip ${available ? '' : 'unavailable'}"><span class="chip-dot"></span>${limitReached ? 'Limit reached' : (stockAvailable ? escape(card.category) : 'Out of stock')}</span>
                        ${limitReached ? '<div class="card-unavailable-banner">Limit reached</div>' : (available ? '' : '<div class="card-unavailable-banner">Out of stock</div>')}
                        <div class="card-copy">
                            <div class="card-series">${escape(card.series || visual.series || 'Phantom Reserve')}</div>
                            <div class="card-title">${escape(card.title)}</div>
                            <div class="card-sub">${escape(card.category)} · ${available ? 'Sealed card' : (limitReached ? 'Limit reached today' : 'Unavailable')}</div>
                        </div>
                        <div class="card-value-row">
                            <div class="card-value-metric">
                                <span>Card price</span>
                                <strong>$${money(card.price)}</strong>
                            </div>
                            <div class="card-value-metric redeem">
                                <span>Potential Redeem</span>
                                <strong>${escape(potentialRedeem)}</strong>
                            </div>
                        </div>
                    </div>
                    <button class="btn btn-primary buy-btn ${limitReached ? 'daily-limit-reached' : ''}" onclick="handlePurchase('${escape(card.id)}')" ${available ? '' : 'disabled'}>${available ? 'BUY NOW' : (limitReached ? 'Limit Reached' : 'OUT OF STOCK')}</button>
                    ${limitReached ? `<small class="daily-limit-countdown" data-daily-countdown-card="${escape(card.id)}">${countdownText(Math.max(0, nextGhanaMidnight() - Date.now()))}</small>` : ''}
                </div>
                <div style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0 16px;">
                    <div><span class="text-sm text-muted">Price</span><div class="text-xl font-bold">$${money(card.price)}</div></div>
                    <div><span class="text-sm text-muted">Wallet debit</span><div class="text-xl font-bold">${ghs(price)}</div></div>
                    <div><span class="text-sm text-muted">Potential redeem</span><div class="text-xl font-bold">${escape(potentialRedeem)}</div></div>
                    <div><span class="text-sm text-muted">Availability</span><div class="text-xl font-bold ${available ? '' : 'text-error'}">${available ? (card.stock > 10 ? 'In stock' : 'Limited') : (limitReached ? 'Limit reached today' : 'Out of stock')}</div></div>
                </div>
                <p class="text-sm text-secondary" style="margin:12px 0;">${escape(card.description)}</p>
                <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
                    <button class="btn btn-secondary" style="flex:1;" onclick="goBack('shop')">← Back</button>
                    ${available ? `<button class="btn btn-primary" style="flex:1;" onclick="handlePurchase('${escape(card.id)}')">BUY NOW</button>` : ''}
                </div>
            </div>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    function renderRedeemSupportState() {
        const nudge = byId('pendingCodeNudge');
        const disclosure = byId('redeemHowDisclosure');
        const unused = (state.redeemedCodes || []).filter(code => code.status === 'unused');
        nudge?.classList.toggle('visible', unused.length > 0);
        const title = byId('pendingCodeTitle');
        const value = byId('pendingCodeValue');
        if (title) title.textContent = `${unused.length} code${unused.length === 1 ? '' : 's'} waiting to be redeemed`;
        if (value) value.textContent = unused.length > 0 ? 'Reward band applies until code entry' : 'Ready to redeem';
        if (disclosure) {
            const hasRedeemed = (state.redeemedCodes || []).some(code => code.status === 'redeemed');
            disclosure.classList.toggle('open', !hasRedeemed);
        }
    }

    window.renderRedeemHistory = function () {
        const container = byId('redeemHistory');
        if (!container) return;
        const search = (byId('redeemHistorySearch')?.value || '').trim().toLowerCase();
        const filter = byId('redeemHistoryFilter')?.value || 'all';
        let codes = [...(state.redeemedCodes || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
        if (filter !== 'all') codes = codes.filter(code => code.status === filter);
        if (search) {
            codes = codes.filter(code => [
                code.name,
                code.category,
                code.orderId,
                code.redemptionReference,
            ].some(value => String(value || '').toLowerCase().includes(search)));
        }
        renderRedeemSupportState();
        if (!codes.length) {
            container.innerHTML = `<div class="empty-state" style="padding:20px;"><p class="text-sm text-muted">No matching codes.</p></div>`;
            return;
        }
        container.innerHTML = codes.map(code => {
            const amount = Number(code.status === 'redeemed' ? code.amount : 0);
            const rgb = cardTheme(code.category).rgb;
            const statusLabel = code.status === 'redeemed' ? 'Redeemed' : 'Awaiting redemption';
            const historyIcon = code.status === 'redeemed' ? 'gift' : 'ticket';
            return `
                <div class="redeem-history-item">
                    <div class="redeem-history-swatch" style="--card-rgb:${escape(rgb)};" aria-hidden="true"><i data-lucide="${historyIcon}"></i></div>
                    <div class="redeem-history-main">
                        <div class="redeem-history-title">${escape(code.name || 'Sealed card')}</div>
                        <div class="redeem-history-meta">${code.date ? formatFullDate(code.date) : 'Waiting'} · <span class="status-badge ${escape(code.status)}">${escape(statusLabel)}</span></div>
                        <div class="redeem-history-meta">${code.status === 'redeemed' && code.purchaseAmount ? `Paid ${ghs(code.purchaseAmount)}` : ''}${code.status === 'redeemed' && code.rewardMultiplier ? ` · Multiplier x${money(code.rewardMultiplier)}` : ''}${code.redemptionReference ? ` · ${escape(code.redemptionReference)}` : code.status === 'unused' ? 'Purchased · Awaiting redemption' : ''}</div>
                    </div>
                    <div class="redeem-history-actions">
                        ${code.status === 'unused' ? `<button class="btn btn-secondary btn-sm" type="button" onclick="revealPurchasedCode('${escape(code.purchaseId)}')">Reveal code</button>` : ''}
                        <div class="redeem-history-amount ${amount ? 'is-available' : 'is-locked'}">${amount ? ghs(amount) : 'Locked'}</div>
                        <span class="redeem-history-chevron" aria-hidden="true">›</span>
                    </div>
                </div>
            `;
        }).join('');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    const legacyRenderAll = window.renderAll;
    window.renderAll = function () {
        const renderers = [
            ['shop cards', window.renderShopCards],
            ['price rails', window.renderPriceRails],
            ['dashboard', window.renderDashboard],
            ['wallet transactions', window.renderWalletTransactions],
            ['redeem history', window.renderRedeemHistory],
            ['transaction list', window.renderTransactionList],
            ['methods', window.renderMethods],
            ['faq', window.renderFAQ],
            ['withdraw methods', window.renderWithdrawMethods],
            ['withdrawal status', window.renderWithdrawalStatusList],
            ['balances', window.updateBalances],
            ['stats', window.updateStats],
            ['wallet summary', window.updateWalletSummary],
        ];
        if (!renderers.some(([, fn]) => typeof fn === 'function') && typeof legacyRenderAll === 'function') {
            return renderSafely('legacy all', legacyRenderAll);
        }
        renderers.forEach(([name, fn]) => renderSafely(name, fn));
    };

    window.renderTransactionList = function () {
        const container = byId('txList');
        const empty = byId('txEmpty');
        if (!container) return;
        const search = (byId('txSearch')?.value || '').trim().toLowerCase();
        let list = [...(state.transactions || [])];
        if (state.txFilter === 'purchased') list = list.filter(isPurchaseTx);
        else if (state.txFilter === 'redeemed') list = list.filter(isRedemptionTx);
        else if (state.txFilter === 'deposits') list = list.filter(isDepositTx);
        else if (state.txFilter === 'withdrawals') list = list.filter(isWithdrawalTx);
        else if (state.txFilter === 'pending') list = list.filter(tx => tx.status === 'pending' || tx.status === WITHDRAWAL_PENDING_KYC);
        else if (state.txFilter === 'approved') list = list.filter(tx => tx.status === 'approved');
        else if (state.txFilter === 'failed') list = list.filter(tx => ['failed', 'rejected'].includes(tx.status));
        else if (state.txFilter === 'wallet') list = list.filter(tx => tx.account === 'wallet');
        else if (state.txFilter === 'redeemed-account') list = list.filter(tx => tx.account === 'redeemed');
        if (search) list = list.filter(tx => [tx.id, tx.reference, tx.reason, tx.related?.orderId, tx.related?.code, tx.related?.cardId].some(v => String(v || '').toLowerCase().includes(search)));
        if (!list.length) {
            container.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }
        empty?.classList.add('hidden');
        let group = '';
        container.innerHTML = `<div class="tx-compact-list">${list.map(tx => {
            const nextGroup = getActivityGroup(tx.date);
            const label = nextGroup !== group ? `<div class="tx-date-group">${nextGroup}</div>` : '';
            group = nextGroup;
            return `${label}${renderCompactTx(tx)}`;
        }).join('')}</div>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    window.renderWalletTransactions = function () {
        const container = byId('walletTransactions');
        if (!container) return;
        const recent = (state.transactions || []).slice(0, 10);
        if (!recent.length) {
            container.innerHTML = `<div class="empty-state" style="padding:20px;"><p class="text-sm text-muted">No transactions yet.</p></div>`;
            return;
        }
        container.innerHTML = `<div class="tx-compact-list">${recent.map(renderCompactTx).join('')}</div>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    function isPurchaseTx(tx) {
        return /purchase/i.test(tx.reason || '') || Boolean(tx.related?.orderId && tx.type === 'debit');
    }

    function isRedemptionTx(tx) {
        return /redemption|redeem/i.test(tx.reason || '') || Boolean(tx.related?.code && tx.account === 'redeemed' && tx.type === 'credit');
    }

    function isDepositTx(tx) {
        return /deposit|top[- ]?up/i.test(tx.reason || '') && tx.account === 'wallet';
    }

    function isWithdrawalTx(tx) {
        return isRefundTx(tx) || (/withdraw/i.test(tx.reason || '') && tx.account === 'redeemed');
    }

    function isRefundTx(tx) {
        return tx.entryType === 'REFUND' || tx.related?.transactionType === 'REFUND' || tx.related?.refundType === 'KYC_FEE_REFUND';
    }

    function txIcon(tx) {
        if (isPurchaseTx(tx)) return 'shopping-bag';
        if (isRedemptionTx(tx)) return 'badge-check';
        if (isRefundTx(tx)) return 'undo-2';
        if (isWithdrawalTx(tx)) return 'banknote';
        if (isDepositTx(tx)) return 'zap';
        return tx.type === 'credit' ? 'arrow-down-left' : 'arrow-up-right';
    }

    function txTitle(tx) {
        const cardTitle = state.cards?.find(card => card.id === tx.related?.cardId)?.title;
        if (cardTitle && (isPurchaseTx(tx) || isRedemptionTx(tx))) return cardTitle;
        if (isPurchaseTx(tx)) return 'Card purchase';
        if (isRedemptionTx(tx)) return 'Code redeemed';
        if (isRefundTx(tx)) return 'KYC Fee Refund';
        if (isWithdrawalTx(tx)) return tx.reason;
        if (isDepositTx(tx)) return 'Wallet deposit';
        return tx.reason || 'Transaction';
    }

    function txKind(tx) {
        if (isPurchaseTx(tx)) return 'Purchased';
        if (isRedemptionTx(tx)) return 'Redeemed';
        if (isRefundTx(tx)) return 'KYC Fee Refund · Refunded';
        if (isWithdrawalTx(tx)) return tx.status === WITHDRAWAL_PENDING_KYC ? 'Pending KYC verification' : tx.status === 'pending' ? 'Withdrawal pending' : tx.status === 'approved' ? 'Withdrawal approved' : tx.status === 'processing' ? 'Withdrawal processing' : tx.status === 'completed' ? 'Withdrawal completed' : tx.status === 'rejected' ? 'Withdrawal rejected' : 'Withdrawal';
        if (isDepositTx(tx)) return 'Top-up';
        return tx.type === 'credit' ? 'Credit' : 'Debit';
    }

    function renderCompactTx(tx) {
        const amount = `${tx.type === 'credit' ? '+' : '-'}GHS ${money(tx.amount)}`;
        const status = statusClass(tx.status);
        return `
            <button class="tx-compact-row ${isRefundTx(tx) ? 'refund-transaction' : ''}" type="button" onclick="showReceipt('${escape(tx.id)}')">
                <span class="tx-compact-icon ${tx.account || ''} ${isRefundTx(tx) ? 'refund' : ''}"><i data-lucide="${txIcon(tx)}"></i></span>
                <span class="tx-compact-main">
                    <span class="tx-compact-title">${escape(txTitle(tx))}</span>
                    <span class="tx-compact-type">${escape(txKind(tx))}</span>
                    <span class="tx-compact-date">${formatFullDate(tx.date)} · ${escape(tx.reference || tx.id)}</span>
                </span>
                <span class="tx-compact-side">
                    <span class="tx-compact-amount ${tx.type}">${amount}</span>
                    <span class="tx-status-dot ${status}"><i data-lucide="${statusIcon(status)}"></i></span>
                </span>
            </button>
        `;
    }

    function statusClass(status) {
        if (status === 'success' || status === 'completed') return 'success';
        if (status === 'pending' || status === WITHDRAWAL_PENDING_KYC) return 'pending';
        if (status === 'approved') return 'approved';
        if (status === 'processing') return 'processing';
        if (status === 'refunded') return 'refunded';
        if (status === 'rejected') return 'rejected';
        return 'failed';
    }

    function statusIcon(status) {
        if (status === 'failed' || status === 'rejected') return 'x';
        if (status === 'pending' || status === WITHDRAWAL_PENDING_KYC) return 'clock';
        if (status === 'approved') return 'badge-check';
        if (status === 'processing') return 'loader-circle';
        if (status === 'refunded') return 'undo-2';
        return 'check';
    }

    function statusLabel(status) {
        if (status === 'success') return 'credited';
        if (status === 'completed') return 'completed';
        if (status === 'approved') return 'approved';
        if (status === 'processing') return 'processing';
        if (status === 'pending') return 'pending';
        if (status === 'refunded') return 'Refunded';
        if (status === WITHDRAWAL_PENDING_KYC) return 'Pending KYC Verification';
        if (status === 'rejected') return 'rejected';
        return status || 'unknown';
    }

    function formatFullDate(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    const legacySetTxFilter = window.setTxFilter;
    window.setTxFilter = function (filter, el) {
        document.querySelectorAll('[data-txfilter]').forEach(c => c.classList.remove('active'));
        el?.classList.add('active');
        state.txFilter = filter;
        renderTransactionList();
    };

    document.addEventListener('submit', event => {
        const formId = event.target?.id;
        const handler = formId === 'loginForm' ? window.handleLogin : formId === 'signupStage3' ? window.handleSignup : formId === 'forgotForm' ? window.handleForgot : formId === 'resetForm' ? window.handleResetPassword : formId === 'contactForm' ? window.handleContact : null;
        if (!handler) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        handler(event);
    }, true);

    document.addEventListener('input', event => {
        if (event.target?.id === 'withdrawResult') event.target.dataset.locked = '';
        if (['withdrawAmount', 'withdrawMethod', 'withdrawPin'].includes(event.target?.id)) {
            byId('withdrawResult')?.removeAttribute('data-locked');
            updateWithdrawValidation();
        }
    });

    document.addEventListener('change', event => {
        if (event.target?.id === 'withdrawMethod') {
            byId('withdrawResult')?.removeAttribute('data-locked');
            updateWithdrawValidation();
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeFlowSheet();
        closeDepositSheet();
        if (typeof closeDrawer === 'function') closeDrawer();
    });

    // Design-board renderers. These deliberately use the persisted state only;
    // they never manufacture balances, account data, or transaction records.
    window.renderDashboard = function () {
        const user = state.user || {};
        const name = String(user.name || '').trim();
        const first = name.split(/\s+/)[0] || 'there';
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        const set = (id, value) => { const el = byId(id); if (el) el.textContent = value; };
        set('dashGreeting', `${greeting}, ${first}`);
        set('dashAvatar', initials(name));
        set('dashAccountName', name || 'Your account');
        set('dashAccountId', `User ID • ${String(user.id || '').slice(-8) || '••••••••'}`);
        set('dashAccountEmail', user.email || '—');
        set('dashMemberSince', user.createdAt ? `Member since ${new Date(user.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : 'Member since —');
        set('dashAccountStatus', user.kycStatus === 'REJECTED' ? 'Review needed' : 'Active');
        set('dashWalletBalance', user.walletBalance === undefined ? '••••••' : ghs(user.walletBalance));
        set('dashRedeemedBalance', user.redeemedBalance === undefined ? '••••••' : ghs(user.redeemedBalance));
        const month = new Date().getMonth(); const year = new Date().getFullYear();
        const txs = state.transactions || [];
        const sameMonth = txs.filter(tx => { const d = new Date(tx.date); return d.getMonth() === month && d.getFullYear() === year; });
        set('statPurchases', sameMonth.filter(tx => /Card purchase/i.test(tx.reason)).length);
        set('statRedemptions', sameMonth.filter(tx => /Redeem/i.test(tx.reason)).length);
        set('statWithdrawals', sameMonth.filter(tx => /Withdrawal/i.test(tx.reason)).length);
        if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    let walletFilter = 'all';
    let walletIndex = 0;
    function renderWalletBoard() {
        const wallet = byId('wbsWalletValue'); const redeemed = byId('wbsRedeemedValue');
        if (wallet) wallet.textContent = state.user?.walletBalance === undefined ? '••••••' : ghs(state.user.walletBalance);
        if (redeemed) redeemed.textContent = state.user?.redeemedBalance === undefined ? '••••••' : ghs(state.user.redeemedBalance);
        const target = byId('walletTransactions');
        if (!target) return;
        let txs = [...(state.transactions || [])];
        if (walletFilter === 'deposit') txs = txs.filter(tx => /top-up|deposit/i.test(tx.reason));
        if (walletFilter === 'purchase') txs = txs.filter(tx => /purchase/i.test(tx.reason));
        target.innerHTML = txs.slice(0, 6).map(tx => `<div class="tx-item"><div class="tx-icon ${tx.type === 'credit' ? 'credit' : 'debit'}"><i data-lucide="${/purchase/i.test(tx.reason) ? 'shopping-bag' : /withdraw/i.test(tx.reason) ? 'landmark' : 'wallet'}"></i></div><div class="tx-info"><div class="tx-title">${escape(tx.reason)}</div><div class="tx-meta">${new Date(tx.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div></div><div class="tx-amount ${tx.type === 'credit' ? 'credit' : 'debit'}">${tx.type === 'credit' ? '+' : '-'}${ghs(tx.amount)}</div></div>`).join('') || '<div class="empty-state" style="padding:20px"><p class="text-sm text-muted">No transactions yet.</p></div>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    window.renderWalletTransactions = renderWalletBoard;
    window.setWalletFilter = function (filter, button) { walletFilter = filter; document.querySelectorAll('.transaction-filters button').forEach(item => item.classList.remove('active')); button?.classList.add('active'); renderWalletBoard(); };
    window.walletCarouselGoTo = function (index) { walletIndex = index === 1 ? 1 : 0; const track = byId('walletCarouselTrack'); if (track) track.style.transform = `translateX(-${walletIndex * 50}%)`; document.querySelectorAll('.wallet-pagination button').forEach((button, i) => button.classList.toggle('active', i === walletIndex)); };
    function mountWalletBoard() {
        const page = byId('page-wallet');
        if (!page || page.dataset.boardMounted) return;
        page.dataset.boardMounted = 'true';
        page.innerHTML = `<div class="container app-page"><div class="screen-heading"><h1>Wallet</h1><p>Manage your spending balance and deposits.</p></div><div class="wallet-carousel" id="walletCarousel"><div class="wallet-carousel-track" id="walletCarouselTrack"><div class="wallet-slide"><article class="balance-feature"><div class="balance-feature-top"><span class="surface-icon"><i data-lucide="wallet"></i></span><span class="balance-feature-label">Wallet Balance</span></div><div class="balance-feature-value" id="wbsWalletValue">••••••</div><p class="balance-copy">Available for card purchases</p><button class="btn btn-primary" onclick="openDepositSheet()">Deposit / Top-Up</button></article></div><div class="wallet-slide"><article class="balance-feature"><div class="balance-feature-top"><span class="surface-icon"><i data-lucide="layers"></i></span><span class="balance-feature-label">Redeemed Balance</span></div><div class="balance-feature-value" id="wbsRedeemedValue">••••••</div><p class="balance-copy">Available for withdrawal</p><button class="btn btn-primary" onclick="navigateTo('withdraw')">Withdraw</button></article></div></div></div><div class="wallet-pagination"><button class="active" onclick="walletCarouselGoTo(0)" aria-label="Wallet Balance"></button><button onclick="walletCarouselGoTo(1)" aria-label="Redeemed Balance"></button></div><div class="transaction-heading"><h2>Recent Transactions</h2></div><div class="transaction-filters"><button class="active" onclick="setWalletFilter('all',this)">All</button><button onclick="setWalletFilter('deposit',this)">Deposits</button><button onclick="setWalletFilter('purchase',this)">Purchases</button></div><div class="transaction-panel" id="walletTransactions"></div></div>`;
        const carousel = byId('walletCarousel'); let startX = 0;
        carousel?.addEventListener('touchstart', event => { startX = event.touches[0].clientX; }, { passive: true });
        carousel?.addEventListener('touchend', event => { const dx = event.changedTouches[0].clientX - startX; if (dx < -35) window.walletCarouselGoTo(1); if (dx > 35) window.walletCarouselGoTo(0); }, { passive: true });
    }
    function authShell(title, subtitle, body, extraClass = '') {
        return `<div class="auth-page ${extraClass}"><div class="auth-card"><div class="auth-brand"><span class="brand-star">✦</span> PHANTOM <span class="brand-accent">CARDS</span></div><div class="auth-title">${title}</div><div class="auth-subtitle">${subtitle}</div>${body}</div></div>`;
    }
    function enhancePasswordFields(root = document) {
        const allowed = new Set(['loginPassword', 'signupPassword', 'signupConfirm', 'resetPassword', 'resetConfirm', 'currentPassword', 'newPassword', 'confirmNewPassword']);
        root.querySelectorAll?.('input[type="password"]').forEach(input => {
            if (!allowed.has(input.id) || input.parentElement?.querySelector('[data-password-toggle]')) return;
            const toggleId = `${input.id}Toggle`;
            const button = document.createElement('button');
            button.type = 'button';
            button.id = toggleId;
            button.className = 'field-action password-toggle';
            button.dataset.passwordToggle = 'true';
            button.setAttribute('aria-label', 'Show password as plain text');
            button.setAttribute('aria-pressed', 'false');
            button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            button.addEventListener('click', () => window.togglePasswordVisibility?.(input.id, toggleId));
            input.parentElement?.appendChild(button);
        });
    }
    function mountAuthBoard() {
        const login = byId('page-login');
        if (login) login.innerHTML = authShell('Welcome back', 'Sign in to access your account.', `<form id="loginForm"><div class="auth-field" id="loginEmailField"><label class="field-label" for="loginEmail">Email or mobile number</label><div class="field-wrap"><input id="loginEmail" type="text" autocomplete="username" placeholder="0241234567 or you@gmail.com" required /></div></div><div class="auth-field" id="loginPassField"><label class="field-label" for="loginPassword">Password</label><div class="field-wrap"><input id="loginPassword" type="password" autocomplete="current-password" placeholder="Enter your password" required /></div></div><div class="auth-row"><label class="remember"><input type="checkbox" id="rememberDevice" checked><span class="checkmark"></span>Remember me</label><button type="button" class="forgot-link" onclick="navigateTo('forgot')">Forgot password?</button></div><button class="btn-vault" id="loginBtn" type="submit">Sign in</button></form><div class="auth-footer">Don't have an account? <a onclick="navigateTo('signup')">Create account</a></div>`);
        const signup = byId('page-signup');
        if (signup) signup.innerHTML = authShell('Create your account', 'Join Phantom Cards and start earning real value from your cards.', `<form id="signupStage3"><div class="auth-field"><label class="field-label" for="signupName">Full name</label><div class="field-wrap"><input id="signupName" autocomplete="name" placeholder="Enter your full name" required /></div></div><div class="auth-field"><label class="field-label" for="signupPhone">Mobile number</label><div class="field-wrap"><input id="signupPhone" type="tel" inputmode="numeric" maxlength="10" pattern="0[0-9]{9}" autocomplete="tel" placeholder="0241234567" required /></div></div><div class="auth-field"><label class="field-label" for="signupEmail">Gmail address (optional)</label><div class="field-wrap"><input id="signupEmail" type="email" autocomplete="email" placeholder="you@gmail.com" /></div></div><div class="auth-field"><label class="field-label" for="signupPassword">Password</label><div class="field-wrap"><input id="signupPassword" type="password" minlength="6" autocomplete="new-password" placeholder="At least 6 characters" required /></div></div><div class="password-rules"><span>At least 6 characters</span></div><div class="auth-field"><label class="field-label" for="signupConfirm">Confirm password</label><div class="field-wrap"><input id="signupConfirm" type="password" minlength="6" autocomplete="new-password" placeholder="Confirm your password" required /></div></div><input id="signupTerms" type="checkbox" checked hidden><button class="btn-vault" id="signupFinalBtn" type="submit">Create account</button></form><div class="auth-footer">Already have an account? <a onclick="navigateTo('login')">Sign in</a></div>`);
        const forgot = byId('page-forgot');
        if (forgot) forgot.innerHTML = authShell('Reset your password', `Enter your email address and we'll send you a reset link.`, `<form id="forgotForm"><div class="auth-field"><label class="field-label" for="forgotEmail">Email address</label><div class="field-wrap"><input id="forgotEmail" type="email" autocomplete="email" placeholder="you@example.com" required /></div></div><button class="btn-vault" id="forgotBtn" type="submit">Send reset link</button></form><div class="auth-footer"><a onclick="navigateTo('login')">← Back to login</a></div>`);
    }
    document.addEventListener('DOMContentLoaded', () => {
        const carousel = byId('walletCarousel'); if (!carousel) return;
        let startX = 0;
        carousel.addEventListener('touchstart', event => { startX = event.touches[0].clientX; }, { passive: true });
        carousel.addEventListener('touchend', event => { const dx = event.changedTouches[0].clientX - startX; if (dx < -35) window.walletCarouselGoTo(1); if (dx > 35) window.walletCarouselGoTo(0); }, { passive: true });
    });

    document.addEventListener('DOMContentLoaded', async () => {
        document.title = 'PHANTOM CARDS';
        mountWalletBoard();
        mountAuthBoard();
        enhancePasswordFields();
        document.querySelectorAll('.brand-name').forEach(el => { el.innerHTML = 'PHANTOM <span class="brand-name-accent">CARDS</span>'; });
        const redeemButton = document.querySelector('#page-redeem .redeem-entry-card > .redeem-submit');
        if (redeemButton) redeemButton.disabled = true;
        const withdrawButton = document.querySelector('#page-withdraw .btn-primary');
        if (withdrawButton) {
            withdrawButton.id = 'withdrawSubmitBtn';
            withdrawButton.disabled = true;
        }
        bindRealAuthForms();
        try {
            await refresh();
            const params = new URLSearchParams(location.search);
            if (params.has('wallet_topup')) await showWalletTopupResult();
            else if (params.has('kyc_bypass_reference') || params.has('kyc_bypass_test')) await completeKycBypassFromUrl();
            else safeNavigate('home', 'initial-refresh');
        } catch (e) {
            state.isLoggedIn = false;
            safeNavigate('login', 'initial-refresh-failed');
            const params = new URLSearchParams(location.search);
            if (params.has('wallet_topup') || params.has('kyc_bypass_reference') || params.has('kyc_bypass_test')) showToast('error', e.message);
        } finally {
            document.body.classList.remove('app-booting');
            startBackgroundRefresh();
        }
    });
})();
