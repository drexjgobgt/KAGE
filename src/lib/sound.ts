/**
 * Save-confirmation blip generated with WebAudio so KAGE ships zero audio
 * assets and stays fully offline.
 */

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

export function playSaveSound(): void {
  const c = audioContext();
  if (!c) return;
  try {
    const t0 = c.currentTime;

    const tick = c.createOscillator();
    const tickGain = c.createGain();
    tick.type = "triangle";
    tick.frequency.setValueAtTime(740, t0);
    tickGain.gain.setValueAtTime(0.0001, t0);
    tickGain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.004);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.065);
    tick.connect(tickGain).connect(c.destination);
    tick.start(t0);
    tick.stop(t0 + 0.075);

    const ping = c.createOscillator();
    const pingGain = c.createGain();
    ping.type = "sine";
    ping.frequency.setValueAtTime(1108.7, t0 + 0.045);
    pingGain.gain.setValueAtTime(0.0001, t0 + 0.045);
    pingGain.gain.exponentialRampToValueAtTime(0.045, t0 + 0.055);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    ping.connect(pingGain).connect(c.destination);
    ping.start(t0 + 0.045);
    ping.stop(t0 + 0.22);
  } catch {
    /* audio is best-effort */
  }
}
