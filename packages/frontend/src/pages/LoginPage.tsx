import { useState, type FormEvent } from 'react';
import { useLogin } from '../api/hooks.js';
import { ApiError } from '../api/client.js';
import { Alert } from '../components/ui/primitives.jsx';
import { IconShield } from '../components/ui/Icons.jsx';

/**
 * Экран входа.
 *
 * Регистрации нет: доступ только у заранее заведённого владельца (ТЗ §22).
 * Причина отказа не детализируется — сервер намеренно отвечает одинаково
 * и на несуществующий адрес, и на неверный пароль.
 */
export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await login.mutateAsync({ email, password });
      if (result.mustChangePassword) {
        window.alert('Пароль выдан временно. Смените его в разделе «Настройки» сразу после входа.');
      }
      onSuccess();
    } catch {
      // Сообщение об ошибке показывается ниже через состояние мутации.
    }
  };

  const error = login.error;
  const isLocked = error instanceof ApiError && error.status === 423;
  const isThrottled = error instanceof ApiError && error.status === 429;

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <div className="sidebar__logo">
            <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M6 20.5c2.6-2.2 4.6-2.2 7.2 0s4.6 2.2 7.2 0 4.6-2.2 5.6-1.2" stroke="#60a5fa" strokeWidth="2.4" fill="none" strokeLinecap="round" />
              <path d="M6 13.5c2.6-2.2 4.6-2.2 7.2 0s4.6 2.2 7.2 0 4.6-2.2 5.6-1.2" stroke="#1d4ed8" strokeWidth="2.4" fill="none" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div className="auth__title">Новороссийск</div>
            <div className="auth__subtitle">News monitoring</div>
          </div>
        </div>

        <form className="auth__form" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="login-email">
              Электронная почта
            </label>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="owner@example.com"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="login-password">
              Пароль
            </label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error && (
            <Alert tone={isLocked || isThrottled ? 'warning' : 'danger'}>
              {(error as Error).message}
            </Alert>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={login.isPending}>
            {login.isPending ? <span className="spinner" /> : null}
            {login.isPending ? 'Проверка…' : 'Войти'}
          </button>
        </form>

        <p className="auth__note">
          <IconShield size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Закрытая система. Регистрация новых пользователей отключена.
        </p>
      </div>
    </div>
  );
}
