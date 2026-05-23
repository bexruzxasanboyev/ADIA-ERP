import '@testing-library/jest-dom/vitest';

/**
 * jsdom ships without `ResizeObserver`, but Recharts'
 * `<ResponsiveContainer>` instantiates one on mount (M8 dashboard
 * charts). Provide a no-op polyfill so the chart-bearing screens can
 * render under vitest.
 */
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverMock;
}
