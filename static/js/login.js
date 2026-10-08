/* StockFlow – login page behaviour (Fetch API). */
(() => {
  'use strict';

  const DEMO_CREDENTIALS = { email: 'admin@stockflow.com', password: 'admin123' };

  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const rememberInput = document.getElementById('remember');
  const submitBtn = document.getElementById('loginBtn');
  const banner = document.getElementById('loginError');
  const bannerText = document.getElementById('loginErrorText');
  const toggleBtn = document.getElementById('togglePassword');
  const toggleIcon = document.getElementById('toggleIcon');

  const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  function setFieldError(input, message) {
    const slot = document.getElementById(`err-${input.id}`);
    slot.textContent = message || '';
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function showBanner(message) {
    bannerText.textContent = message;
    banner.hidden = !message;
  }

  function clearErrors() {
    showBanner('');
    setFieldError(emailInput, '');
    setFieldError(passwordInput, '');
  }

  /** Client-side checks; the server validates again. */
  function validate() {
    let valid = true;
    const email = emailInput.value.trim();
    if (!email) {
      setFieldError(emailInput, 'Enter your email address.');
      valid = false;
    } else if (!EMAIL_PATTERN.test(email)) {
      setFieldError(emailInput, 'Enter a valid email address.');
      valid = false;
    }
    if (!passwordInput.value) {
      setFieldError(passwordInput, 'Enter your password.');
      valid = false;
    }
    return valid;
  }

  toggleBtn.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    toggleBtn.setAttribute('aria-pressed', String(show));
    toggleBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggleIcon.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
  });

  document.getElementById('fillDemo').addEventListener('click', () => {
    emailInput.value = DEMO_CREDENTIALS.email;
    passwordInput.value = DEMO_CREDENTIALS.password;
    clearErrors();
    submitBtn.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();
    if (!validate()) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }

    submitBtn.classList.add('is-loading');
    submitBtn.disabled = true;
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: emailInput.value.trim(),
          password: passwordInput.value,
          remember: rememberInput.checked,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        window.location.assign(data.redirect || '/dashboard');
        return;
      }
      if (data.fields) {
        if (data.fields.email) setFieldError(emailInput, data.fields.email);
        if (data.fields.password) setFieldError(passwordInput, data.fields.password);
      } else {
        showBanner(data.error || 'Sign in failed. Please try again.');
        passwordInput.select();
      }
    } catch (error) {
      showBanner('Cannot reach the server. Check that Flask is running.');
    } finally {
      submitBtn.classList.remove('is-loading');
      submitBtn.disabled = false;
    }
  });

  [emailInput, passwordInput].forEach((input) =>
    input.addEventListener('input', () => {
      setFieldError(input, '');
      showBanner('');
    })
  );
})();
