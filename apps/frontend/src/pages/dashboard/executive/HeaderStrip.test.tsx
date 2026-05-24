import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeaderStrip } from './HeaderStrip';

describe('HeaderStrip', () => {
  beforeEach(() => {
    // 24-may 2026 14:00 (afternoon → "Xayrli kun").
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 24, 14, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the greeting and the user name', () => {
    render(<HeaderStrip userName="Akmal Karimov" isoDate="2026-05-24" />);
    expect(screen.getByText('Xayrli kun,')).toBeInTheDocument();
    expect(screen.getByText('Akmal Karimov')).toBeInTheDocument();
  });

  it('renders the long Uzbek date', () => {
    render(<HeaderStrip userName="Akmal Karimov" isoDate="2026-05-24" />);
    expect(
      screen.getByText('24-may 2026, yakshanba'),
    ).toBeInTheDocument();
  });
});
