(() => {
  const bundleSizes = [1, 2, 3, 4, 5, 6, 10, 15, 20, 25, 30, 35, 40];
  const makePlans = (prefix, rate) => bundleSizes.map((size) => ({
    id: `${prefix}-${size}`,
    sizeGb: size,
    data: `${size} GB`,
    duration: 'Data bundle',
    price: size * rate
  }));
  const catalog = {
    mtn: { name: 'MTN Ghana', rate: 4, plans: makePlans('mtn', 4) },
    telecel: { name: 'Telecel', rate: 5, plans: makePlans('telecel', 5) },
    airteltigo: { name: 'AirtelTigo', rate: 6, plans: makePlans('airteltigo', 6) }
  };

  let network = 'mtn';
  let selectedPlan = catalog.mtn.plans[0];
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => `GHS ${value.toFixed(2)}`;
  function normalizeRecipient(value) {
    const digits = String(value || '').replace(/\D/g, '');
    let local = digits.startsWith('233') ? digits.slice(3) : digits;
    if (local.startsWith('0')) local = local.slice(1);
    return /^[25]\d{8}$/.test(local) ? local : '';
  }

  function renderPlans() {
    const current = catalog[network];
    $('#network-title').textContent = `${current.name.replace(' Ghana', '')} bundles`;
    $('#plan-grid').innerHTML = current.plans.map((plan, index) => `
      <button class="plan-card ${plan.id === selectedPlan.id ? 'active' : ''}" type="button" data-plan="${plan.id}">
        <small>${index === 0 ? 'STARTER BUNDLE' : index === 1 ? 'POPULAR BUNDLE' : 'DATA BUNDLE'}</small>
        <strong>${plan.data}</strong>
        <em>${plan.duration}</em>
        <b>${money(plan.price)}</b>
      </button>`).join('');

    document.querySelectorAll('.plan-card').forEach((card) => {
      card.addEventListener('click', () => {
        selectedPlan = current.plans.find((plan) => plan.id === card.dataset.plan);
        renderPlans();
        updateSummary();
      });
    });
  }

  function updateSummary() {
    $('#selected-name').textContent = `${catalog[network].name.replace(' Ghana', '')} ${selectedPlan.data} · ${selectedPlan.duration}`;
    $('#selected-price').textContent = money(selectedPlan.price);
    document.querySelectorAll('.network-tab').forEach((tab) => {
      const active = tab.dataset.network === network;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
  }

  function showModal() {
    const rawNumber = normalizeRecipient($('#recipient').value);
    if (!rawNumber) {
      $('#recipient').focus();
      showToast('Enter a valid Ghana number, for example 024 000 0000.');
      return;
    }
    $('#review-network').textContent = catalog[network].name;
    $('#review-bundle').textContent = `${selectedPlan.data} · ${selectedPlan.duration}`;
    $('#review-recipient').textContent = `+233 ${rawNumber.slice(0, 2)} ${rawNumber.slice(2, 5)} ${rawNumber.slice(5)}`;
    $('#review-total').textContent = money(selectedPlan.price);
    $('#review-modal').hidden = false;
    $('#close-modal').focus();
  }

  function closeModal() {
    $('#review-modal').hidden = true;
  }

  async function startCheckout() {
    const button = $('#not-ready-button');
    const recipient = normalizeRecipient($('#recipient').value);
    button.disabled = true;
    button.textContent = 'Opening secure checkout…';
    try {
      const response = await fetch('/api/v1/data-bundles/initialize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network, sizeGb: selectedPlan.sizeGb, recipient })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.authorizationUrl) throw new Error(data.error || 'Checkout could not be started.');
      location.assign(data.authorizationUrl);
    } catch (error) {
      showToast(error.message || 'Checkout could not be started.');
      button.disabled = false;
      button.textContent = 'Continue to Paystack';
    }
  }

  async function showBundleResult() {
    const reference = new URLSearchParams(location.search).get('bundle_order');
    const failed = new URLSearchParams(location.search).get('bundle_payment');
    if (failed) {
      showToast(`Bundle payment ${failed}. No delivery order was created.`);
      history.replaceState({}, '', location.pathname);
      return;
    }
    if (!reference) return;
    try {
      const response = await fetch(`/api/v1/data-bundles/orders/${encodeURIComponent(reference)}`);
      const data = await response.json();
      if (!response.ok || !data.order || data.order.paymentStatus !== 'SUCCESS') throw new Error('Payment is still being confirmed.');
      const order = data.order;
      $('#success-network').textContent = order.networkLabel;
      $('#success-bundle').textContent = `${order.sizeGb} GB data bundle`;
      $('#success-recipient').textContent = order.recipient.replace('+233', '+233 ');
      $('#success-total').textContent = money(order.amount);
      $('#success-modal').hidden = false;
      history.replaceState({}, '', location.pathname);
    } catch (error) {
      showToast(error.message || 'Payment is still being confirmed.');
    }
  }

  let toastTimer;
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  document.querySelectorAll('.network-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      network = tab.dataset.network;
      selectedPlan = catalog[network].plans[0];
      renderPlans();
      updateSummary();
    });
  });

  $('#bundle-form').addEventListener('submit', (event) => {
    event.preventDefault();
    showModal();
  });
  $('#change-plan').addEventListener('click', () => $('#plan-grid').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  $('#close-modal').addEventListener('click', closeModal);
  $('#review-modal').addEventListener('click', (event) => { if (event.target.id === 'review-modal') closeModal(); });
  $('#not-ready-button').addEventListener('click', startCheckout);
  $('#close-success-modal').addEventListener('click', () => { $('#success-modal').hidden = true; });
  $('#close-success-action').addEventListener('click', () => { $('#success-modal').hidden = true; });
  $('#success-modal').addEventListener('click', (event) => { if (event.target.id === 'success-modal') $('#success-modal').hidden = true; });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#review-modal').hidden) closeModal(); });
  $('.menu-button').addEventListener('click', () => showToast('Use the links below to browse PulseData.'));

  renderPlans();
  updateSummary();
  showBundleResult();
})();
