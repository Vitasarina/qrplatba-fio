import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { setPin } from '../lib/pin'
import type { AppMode } from '../types'

// Shop identity fields. Tokens are managed as a separate dynamic list (below).
type Form = {
  name: string
  iban: string
  logoUrl: string
  flipped: boolean
}

const EMPTY: Form = { name: '', iban: '', logoUrl: '', flipped: false }

const MAX_TOKENS = 32

// A token row is either kept (value is the backend mask, contains '*') or newly
// typed (a raw value). Empty rows are dropped on save. We key rows by a stable id
// so React doesn't reuse inputs across add/remove.
type TokenRow = { id: number; value: string }

let rowSeq = 0
function makeRow(value = ''): TokenRow {
  return { id: rowSeq++, value }
}

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
  // One row per configured token (prefilled with the backend mask so leaving it
  // means "keep"). Always at least one row so there's somewhere to type.
  const [tokens, setTokens] = useState<TokenRow[]>([makeRow()])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  async function doFactoryReset() {
    setResetting(true)
    try {
      await api.resetConfig()
      setPin('') // the stored password is wiped; first run will create a new one
      window.location.href = '/setup' // reload into first-run (gate creates a password)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiError ? err.message : 'Reset se nezdařil.' })
      setResetting(false)
      setConfirmReset(false)
    }
  }

  function applyConfig(cfg: {
    name?: string
    iban?: string
    logoUrl?: string
    tokensMasked?: string[]
    mode?: AppMode
    flipped?: boolean
  }) {
    setForm({
      name: cfg.name ?? '',
      iban: cfg.iban ?? '',
      logoUrl: cfg.logoUrl ?? '',
      flipped: cfg.flipped ?? false,
    })
    setMode(cfg.mode ?? null)
    const masks = cfg.tokensMasked ?? []
    setTokens(masks.length ? masks.map((m) => makeRow(m)) : [makeRow()])
  }

  useEffect(() => {
    async function load() {
      try {
        const cfg = await api.getConfig()
        applyConfig(cfg)
      } catch (err) {
        // Missing config on first run is fine; just start empty.
        if (!(err instanceof ApiError) || err.status !== 404) {
          setBanner({
            kind: 'error',
            text: err instanceof ApiError ? err.message : 'Nepodařilo se načíst konfiguraci.',
          })
        }
        setForm(EMPTY)
        setTokens([makeRow()])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function setTokenValue(id: number, value: string) {
    setTokens((rows) => rows.map((r) => (r.id === id ? { ...r, value } : r)))
  }
  function addToken() {
    setTokens((rows) => (rows.length >= MAX_TOKENS ? rows : [...rows, makeRow()]))
  }
  function removeToken(id: number) {
    setTokens((rows) => {
      const next = rows.filter((r) => r.id !== id)
      return next.length ? next : [makeRow()] // never leave zero rows
    })
  }

  // Number of rows that will actually be sent (non-blank), i.e. the resulting
  // token count. A masked row counts as a kept token.
  const activeTokenCount = tokens.filter((r) => r.value.trim() !== '').length

  function validate(): boolean {
    const e: Partial<Record<keyof Form, string>> = {}
    if (!form.name.trim()) e.name = 'Zadejte název obchodu.'
    if (!form.iban.trim()) e.iban = 'Zadejte číslo účtu nebo IBAN.'
    else if (!isAccountShape(form.iban))
      e.iban = 'Zadejte číslo účtu (např. 2400123456/2010) nebo IBAN.'
    if (form.logoUrl.trim() && !/^https?:\/\//i.test(form.logoUrl.trim()))
      e.logoUrl = 'URL loga musí začínat http:// nebo https://.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault()
    setBanner(null)
    if (!validate()) return
    // Send the rows in order, dropping blanks. Masked values (containing '*')
    // tell the backend to keep the stored token at that position; typed values
    // set/replace it. No tokens ⇒ simulation mode.
    const list = tokens.map((r) => r.value.trim()).filter((v) => v !== '')
    setSaving(true)
    try {
      const saved = await api.saveConfig({
        name: form.name.trim(),
        iban: normalizeAccount(form.iban),
        logoUrl: form.logoUrl.trim(),
        tokens: list,
        flipped: form.flipped,
      })
      applyConfig(saved)
      setBanner({ kind: 'success', text: 'Nastavení uloženo.' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof ApiError ? err.message : 'Uložení selhalo.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="page">
      <h1>Nastavení</h1>
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

          {/* Dynamic list of Fio tokens (max 32). A prefilled masked value means
              the stored token is kept; type to replace it; remove the row to drop it. */}
          <fieldset className="field" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ padding: 0, fontWeight: 600 }}>Tokeny banky (Fio) — volitelné</legend>
            <div className="hint" style={{ marginTop: '0.25rem' }}>
              Více tokenů = rychlejší ověřování. Banka se ptá první po 10 s od zobrazení QR a pak
              každých 30 s ÷ počet tokenů. (1 token = každých 30 s.) Jeden účet Fio umožňuje až 32
              tokenů.
            </div>
            <div className="muted" style={{ fontSize: '0.85rem', margin: '0.5rem 0' }}>
              Aktivních tokenů: <strong>{activeTokenCount}</strong> / {MAX_TOKENS}
              {activeTokenCount === 0 && ' — zkušební režim (platby se potvrdí samy).'}
            </div>

            {tokens.map((row, i) => (
              <div key={row.id} className="row" style={{ gap: '0.5rem', marginTop: i === 0 ? 0 : '0.5rem' }}>
                <input
                  type="password"
                  aria-label={`Token ${i + 1}`}
                  value={row.value}
                  onChange={(e) => setTokenValue(row.id, e.target.value)}
                  placeholder="Vlož Fio token"
                  autoComplete="off"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn secondary"
                  aria-label={`Odebrat token ${i + 1}`}
                  title="Odebrat token"
                  onClick={() => removeToken(row.id)}
                  style={{ padding: '0 0.9rem' }}
                >
                  ×
                </button>
              </div>
            ))}

            <button
              type="button"
              className="btn secondary"
              style={{ marginTop: '0.5rem' }}
              onClick={addToken}
              disabled={tokens.length >= MAX_TOKENS}
            >
              + Přidat token
            </button>
            {tokens.length >= MAX_TOKENS && (
              <div className="hint" style={{ marginTop: '0.25rem' }}>
                Dosažen maximální počet tokenů ({MAX_TOKENS}).
              </div>
            )}
          </fieldset>

          <Field
            id="logoUrl"
            label="URL loga (volitelné)"
            value={form.logoUrl}
            error={errors.logoUrl}
            onChange={(v) => set('logoUrl', v)}
            placeholder="https://…/logo.png"
            hint="Zobrazí se jako spořič obrazovky na displeji, když není aktivní platba."
          />

          <div className="field">
            <label className="toggle" htmlFor="flipped">
              <input
                id="flipped"
                type="checkbox"
                className="toggle-input"
                checked={form.flipped}
                onChange={(e) => set('flipped', e.target.checked)}
              />
              <span className="toggle-track" aria-hidden>
                <span className="toggle-thumb" />
              </span>
              <span className="toggle-label">Otočit displej o 180°</span>
            </label>
            <div className="hint" id="flipped-hint">
              Podle toho, na které straně pultu stojíš — prohodí, co je orientované k tobě a co k
              zákazníkovi.
            </div>
          </div>

          <button type="submit" className="btn lg" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden /> : null}
            {saving ? 'Ukládám…' : 'Uložit nastavení'}
          </button>
        </form>
      )}

      {!loading && <ChangePasswordCard onDone={(t) => setBanner({ kind: 'success', text: t })} />}

      {!loading && (
        <div className="card">
          <h2 style={{ margin: '0 0 0.25rem' }}>Obnovit do výchozího stavu</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Smaže konfiguraci (název, účet, tokeny, heslo, logo) i historii plateb a vrátí aplikaci na
            první spuštění — zkušební režim. Při dalším vstupu do nastavení vytvoříte nové heslo.
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

// Change the settings password (current + new + confirm). On success the new
// password becomes the locally-stored credential immediately.
function ChangePasswordCard({ onDone }: { onDone: (text: string) => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const c = current.trim()
    const n = next.trim()
    if (!c) {
      setError('Zadejte současné heslo.')
      return
    }
    if (n.length < 4) {
      setError('Nové heslo musí mít alespoň 4 znaky.')
      return
    }
    if (n !== confirm.trim()) {
      setError('Nová hesla se neshodují.')
      return
    }
    setBusy(true)
    try {
      await api.changePassword(c, n)
      setPin(n) // the new password is now the credential
      setCurrent('')
      setNext('')
      setConfirm('')
      onDone('Heslo bylo změněno.')
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Současné heslo není správné.'
          : err instanceof ApiError
            ? err.message
            : 'Změna hesla selhala.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2 style={{ margin: '0 0 0.25rem' }}>Změnit heslo</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Heslo chrání přístup ke konfiguraci a zadávání plateb. Min. 4 znaky.
      </p>
      <form onSubmit={submit} noValidate>
        {error && <div className="banner error">{error}</div>}
        <Field
          id="pw-current"
          label="Současné heslo"
          type="password"
          value={current}
          onChange={setCurrent}
        />
        <Field id="pw-new" label="Nové heslo" type="password" value={next} onChange={setNext} />
        <Field
          id="pw-confirm"
          label="Nové heslo znovu"
          type="password"
          value={confirm}
          onChange={setConfirm}
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          {busy ? 'Ukládám…' : 'Změnit heslo'}
        </button>
      </form>
    </div>
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
