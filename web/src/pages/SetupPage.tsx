import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { getPin, setPin, notifyPinChange } from '../lib/pin'
import type { AppMode } from '../types'

// The token is entered raw here; on load the backend returns it masked
// (`tokenMasked`), so we never round-trip the real secret into this field.
type Form = {
  name: string
  iban: string
  token: string
  logoUrl: string
  pin: string
}

const EMPTY: Form = { name: '', iban: '', token: '', logoUrl: '', pin: '' }

// Normalize an account input for validation (strip spaces, uppercase). Czech
// account numbers stay as typed apart from whitespace.
function normalizeAccount(v: string): string {
  return v.replace(/\s/g, '').toUpperCase()
}
// Accept EITHER a CZ IBAN shape OR a Czech account-number shape
// ("[prefix-]number/bankcode"). Lenient on purpose — the backend is
// authoritative and normalizes to IBAN; we only catch obvious typos.
function isAccountShape(v: string): boolean {
  const s = normalizeAccount(v)
  const iban = /^CZ\d{22}$/.test(s)
  const accountNumber = /^(\d{1,6}-)?\d{2,10}\/\d{4}$/.test(s)
  return iban || accountNumber
}

export function SetupPage() {
  const [form, setForm] = useState<Form>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({})
  const [banner, setBanner] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [mode, setMode] = useState<AppMode | null>(null)
  // Masked token already stored on the backend (empty if none). Used as the
  // token field placeholder and to decide whether leaving the field blank means
  // "keep the existing token" vs. "no token (simulation)".
  const [existingTokenMasked, setExistingTokenMasked] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  async function doFactoryReset() {
    setResetting(true)
    try {
      await api.resetConfig()
      setPin('') // PIN returns to the default 1234 after a reset
      notifyPinChange()
      window.location.href = '/setup' // reload into first-run (gate will ask for 1234)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiError ? err.message : 'Reset se nezdařil.' })
      setResetting(false)
      setConfirmReset(false)
    }
  }

  useEffect(() => {
    async function load() {
      try {
        const cfg = await api.getConfig()
        // The backend returns the token masked (or empty); never prefill the
        // token field with it, so saving with an untouched field clears nothing
        // unexpectedly — an empty token means "switch to simulation mode".
        setForm({
          name: cfg.name ?? '',
          iban: cfg.iban ?? '',
          token: '',
          logoUrl: cfg.logoUrl ?? '',
          pin: getPin(),
        })
        setMode(cfg.mode ?? null)
        setExistingTokenMasked(cfg.tokenMasked ?? '')
      } catch (err) {
        // Missing config on first run is fine; just start empty.
        if (!(err instanceof ApiError) || err.status !== 404) {
          setBanner({
            kind: 'error',
            text: err instanceof ApiError ? err.message : 'Nepodařilo se načíst konfiguraci.',
          })
        }
        setForm({ ...EMPTY, pin: getPin() })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function validate(): boolean {
    const e: Partial<Record<keyof Form, string>> = {}
    if (!form.name.trim()) e.name = 'Zadejte název obchodu.'
    if (!form.iban.trim()) e.iban = 'Zadejte číslo účtu nebo IBAN.'
    else if (!isAccountShape(form.iban))
      e.iban = 'Zadejte číslo účtu (např. 2400123456/2010) nebo IBAN.'
    // Token is optional: empty ⇒ simulation mode.
    if (form.logoUrl.trim() && !/^https?:\/\//i.test(form.logoUrl.trim()))
      e.logoUrl = 'URL loga musí začínat http:// nebo https://.'
    if (form.pin.trim().length < 4) e.pin = 'PIN musí mít alespoň 4 znaky.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault()
    setBanner(null)
    if (!validate()) return

    // Token field semantics:
    //  - user typed something  ⇒ send it (sets/replaces the Fio token)
    //  - blank + a token exists ⇒ resend the masked marker so the backend keeps
    //    the current token unchanged (we don't hold the raw secret to resend)
    //  - blank + no token       ⇒ send "" (simulation mode)
    // To explicitly remove a token, use "Přepnout na zkušební režim".
    const typed = form.token.trim()
    await save(typed !== '' ? typed : existingTokenMasked)
  }

  // Explicitly clear the Fio token ⇒ simulation mode. Separate from a blank
  // field so an accidental empty save never silently disconnects the bank.
  async function handleSwitchToSim() {
    setBanner(null)
    if (!validate()) return
    setForm((f) => ({ ...f, token: '' }))
    await save('')
  }

  async function save(token: string) {
    setSaving(true)
    try {
      // Authenticated with the CURRENT PIN (already stored from the gate); the new
      // PIN goes in the body and only becomes the credential after a successful save.
      const saved = await api.saveConfig({
        name: form.name.trim(),
        iban: normalizeAccount(form.iban),
        token,
        logoUrl: form.logoUrl.trim(),
        pin: form.pin.trim(),
      })
      setPin(form.pin.trim())
      notifyPinChange()
      // Backend returns the token masked + the resulting mode — reflect both,
      // and clear the token input (we never echo the secret back into it).
      setForm((f) => ({
        ...f,
        name: saved.name ?? f.name,
        iban: saved.iban ?? f.iban,
        logoUrl: saved.logoUrl ?? f.logoUrl,
        token: '',
      }))
      setExistingTokenMasked(saved.tokenMasked ?? '')
      setMode(saved.mode ?? null)
      setBanner({ kind: 'success', text: 'Nastavení uloženo.' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiError ? err.message : 'Uložení selhalo.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="page">
      <h1>První nastavení</h1>
      <p className="subtitle">Údaje obchodu a přístup k bance.</p>

      {loading ? (
        <div className="card">
          <p className="muted">Načítám…</p>
        </div>
      ) : (
        <form className="card" onSubmit={handleSubmit} noValidate>
          {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

          {mode && (
            <div className={`mode-badge ${mode === 'fio' ? 'mode-fio' : 'mode-sim'}`}>
              <span className="mode-dot" aria-hidden />
              {mode === 'fio' ? 'Napojeno na banku (Fio)' : 'Zkušební režim'}
            </div>
          )}

          <Field
            id="name"
            label="Název obchodu"
            value={form.name}
            error={errors.name}
            onChange={(v) => set('name', v)}
            hint="Zobrazí se v platebním příkazu (MSG)."
          />
          <Field
            id="iban"
            label="Číslo účtu / IBAN"
            value={form.iban}
            error={errors.iban}
            onChange={(v) => set('iban', v)}
            placeholder="2400123456/2010"
            hint="Zadej číslo účtu nebo IBAN."
          />
          <Field
            id="token"
            label="Token banky (Fio) — volitelné"
            type="password"
            value={form.token}
            error={errors.token}
            onChange={(v) => set('token', v)}
            placeholder={existingTokenMasked || ''}
            hint="Prázdné = zkušební režim (platby se potvrdí samy). Vyplněním Fio tokenu se aplikace napojí na banku a ověřuje skutečné platby."
          />
          <Field
            id="logoUrl"
            label="URL loga (volitelné)"
            value={form.logoUrl}
            error={errors.logoUrl}
            onChange={(v) => set('logoUrl', v)}
            placeholder="https://…/logo.png"
            hint="Zobrazí se jako spořič obrazovky na displeji, když není aktivní platba."
          />
          <Field
            id="pin"
            label="PIN (přístup ke konfiguraci a zadávání plateb)"
            type="password"
            value={form.pin}
            error={errors.pin}
            onChange={(v) => set('pin', v)}
            hint="Chrání aplikaci na veřejné Wi-Fi. Uloží se do telefonu; tímto PINem se pak odemyká přístup. Min. 4 znaky."
          />

          <button type="submit" className="btn lg" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden /> : null}
            {saving ? 'Ukládám…' : 'Uložit nastavení'}
          </button>

          {/* Explicit way to drop a configured token and return to test mode,
              so an accidentally-empty token field never disconnects the bank. */}
          {mode === 'fio' && existingTokenMasked && (
            <button
              type="button"
              className="btn secondary"
              style={{ marginTop: '0.75rem' }}
              disabled={saving}
              onClick={handleSwitchToSim}
            >
              Přepnout na zkušební režim
            </button>
          )}
        </form>
      )}

      {!loading && (
        <div className="card">
          <h2 style={{ margin: '0 0 0.25rem' }}>Obnovit do výchozího stavu</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Smaže konfiguraci (název, účet, token, PIN, logo) i historii plateb a vrátí aplikaci na
            první spuštění — zkušební režim a PIN 1234.
          </p>
          {!confirmReset ? (
            <button type="button" className="btn danger" onClick={() => setConfirmReset(true)}>
              Obnovit do výchozího stavu
            </button>
          ) : (
            <div className="row" style={{ gap: '0.5rem' }}>
              <button type="button" className="btn danger" disabled={resetting} onClick={doFactoryReset}>
                {resetting ? 'Mažu…' : 'Ano, smazat vše'}
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={resetting}
                onClick={() => setConfirmReset(false)}
              >
                Zrušit
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  type = 'text',
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  hint?: string
  type?: string
  placeholder?: string
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        className={error ? 'invalid' : ''}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        autoComplete="off"
      />
      {error ? (
        <div className="field-error" id={`${id}-err`}>
          {error}
        </div>
      ) : hint ? (
        <div className="hint" id={`${id}-hint`}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}
