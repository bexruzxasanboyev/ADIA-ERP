import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/AuthProvider';
import { ToastProvider } from '@/components/ui/toast';
import { LoginPage } from './LoginPage';

function renderLogin() {
  return render(
    <AuthProvider>
      <ToastProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </ToastProvider>
    </AuthProvider>,
  );
}

/** Build a fake `fetch` Response. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LoginPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('labels every form field with an id (WCAG)', () => {
    renderLogin();
    expect(screen.getByLabelText('Elektron pochta')).toHaveAttribute(
      'id',
      'email',
    );
    expect(screen.getByLabelText('Parol')).toHaveAttribute('id', 'password');
    expect(screen.getByLabelText('Elektron pochta')).toHaveAttribute(
      'name',
      'email',
    );
  });

  it('shows an Uzbek error message on invalid credentials (401)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'UNAUTHENTICATED', message: 'bad' },
      }),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('Elektron pochta'), 'x@adia.local');
    await user.type(screen.getByLabelText('Parol'), 'wrongpass');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Elektron pochta yoki parol noto‘g‘ri.',
      );
    });
  });

  it('surfaces a network failure to the user', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('Elektron pochta'), 'x@adia.local');
    await user.type(screen.getByLabelText('Parol'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Kirish' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
