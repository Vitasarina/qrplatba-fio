// Result sounds, synthesized with the Web Audio API so no audio files need to be
// bundled (important: the kiosk runs offline in an Android WebView). A short rising
// two-tone chime signals a received payment; a lower falling buzz signals "not
// received" (timeout / expiry).
//
// Browsers/WebViews block audio until the user has interacted with the page. Call
// unlockSound() from a real click/tap handler (e.g. the numpad or the "wait" button)
// to create/resume the AudioContext; playSuccess()/playFail() are then audible.

let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) {
    try {
      ctx = new Ctor()
    } catch {
      return null
    }
  }
  return ctx
}

// Prime audio on a user gesture so later result sounds are allowed to play.
export function unlockSound(): void {
  const c = audioContext()
  if (c && c.state === 'suspended') c.resume().catch(() => {})
}

// Play a sequence of tones. Each tone: [frequency Hz, start offset s, duration s].
function playTones(tones: Array<[number, number, number]>, type: OscillatorType = 'sine'): void {
  const c = audioContext()
  if (!c) return
  if (c.state === 'suspended') c.resume().catch(() => {})
  const now = c.currentTime
  for (const [freq, offset, dur] of tones) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = type
    osc.frequency.value = freq
    // Small attack/decay envelope to avoid clicks.
    const start = now + offset
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
    osc.connect(gain).connect(c.destination)
    osc.start(start)
    osc.stop(start + dur + 0.02)
  }
}

// Payment received: bright rising major third (C6 → E6 → G6).
export function playSuccess(): void {
  playTones([
    [1047, 0, 0.16],
    [1319, 0.14, 0.16],
    [1568, 0.28, 0.26],
  ], 'sine')
}

// Payment NOT received (timeout / expiry): two low falling tones.
export function playFail(): void {
  playTones([
    [420, 0, 0.22],
    [300, 0.2, 0.34],
  ], 'triangle')
}
