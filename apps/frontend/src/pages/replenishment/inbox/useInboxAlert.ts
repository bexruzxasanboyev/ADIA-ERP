import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * Phase F-V — the «Ishlarim» attention signal (research Rule 4 / Rec 2: a noisy
 * bakery floor needs an UN-missable cue when a new task lands — a frontline
 * worker must notice without staring at the screen).
 *
 * Given the host's live actionable `count`, on every INCREASE it:
 *   1. plays a short Web Audio beep (oscillator ~880 Hz, ~150 ms, no asset).
 *      Autoplay policies may block audio until the user's first interaction, so
 *      the whole thing is wrapped in try/catch and degrades SILENTLY — never an
 *      error, never a crash.
 *   2. sets a `document.title` badge «(N) …» while `count > 0`, cleared back to
 *      the original title when it drops to 0 (and on unmount).
 *   3. returns a `flash` boolean that pulses true briefly so the header can
 *      animate (honours prefers-reduced-motion — no beep/flash churn there).
 *
 * Polling stays the HOST's concern (the spec: re-fetch existing queries on a
 * ~25 s interval). This hook only reacts to the count the host already derives;
 * it adds no network and no new endpoint.
 *
 * @param count   the live actionable task count
 * @param enabled gate the whole effect (e.g. only for the scoped role / when the
 *                inbox tab is active). Defaults to true.
 */
export function useInboxAlert(count: number, enabled = true): { flash: boolean } {
  const reducedMotion = usePrefersReducedMotion();
  const [flash, setFlash] = useState(false);

  // Remember the previous count to detect a RISE (not the first render, not a
  // drop). `undefined` until the first observed value so the initial load — a
  // cold count of N — never beeps.
  const prevCount = useRef<number | undefined>(undefined);
  // Capture the document title once so we can restore it verbatim.
  const baseTitle = useRef<string | null>(null);
  // A single shared AudioContext, created lazily on the first beep (some
  // browsers reject construction before a user gesture — guarded).
  const audioCtx = useRef<AudioContext | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- (1) + (3): beep + flash on a count increase. -----------------------
  useEffect(() => {
    if (!enabled) {
      prevCount.current = count;
      return;
    }
    const prev = prevCount.current;
    prevCount.current = count;
    if (prev === undefined) return; // first observation — establish baseline only
    if (count <= prev) return; // unchanged or dropped — no alert

    // (1) Beep — best-effort, fully swallowed.
    if (!reducedMotion) playBeep(audioCtx);

    // (3) Flash — pulse the header once; reduced-motion users skip the churn.
    if (!reducedMotion) {
      setFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 1200);
    }
  }, [count, enabled, reducedMotion]);

  // ---- (2): document.title badge while count > 0. -------------------------
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (baseTitle.current === null) baseTitle.current = document.title;
    const base = baseTitle.current;
    if (enabled && count > 0) {
      document.title = `(${count}) ${base}`;
    } else {
      document.title = base;
    }
  }, [count, enabled]);

  // Restore the title + clear timers on unmount.
  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (typeof document !== 'undefined' && baseTitle.current !== null) {
        document.title = baseTitle.current;
      }
    };
  }, []);

  return { flash };
}

/**
 * Play a short notification beep via the Web Audio API. No audio asset — a bare
 * oscillator. Every step is guarded: an absent AudioContext, a suspended
 * context (autoplay policy), or any throw degrades to silence.
 */
function playBeep(ctxRef: React.MutableRefObject<AudioContext | null>): void {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    let ctx = ctxRef.current;
    if (!ctx) {
      ctx = new Ctor();
      ctxRef.current = ctx;
    }
    // Autoplay policy may leave the context suspended until a gesture; try to
    // resume, but don't await (and swallow any rejection).
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    // A soft attack + quick decay so the cue is a gentle "ding", not a buzz.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  } catch {
    // Autoplay blocked or Web Audio unavailable — degrade silently.
  }
}
