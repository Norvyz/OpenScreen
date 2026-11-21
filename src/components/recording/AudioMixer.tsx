import { useEffect } from 'react'
import { Mic, Volume2, VolumeX } from 'lucide-react'
import type { AudioTrackKind } from '@shared/audio'
import { Panel } from '@/components/ui/Panel'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { useAudioStore } from '@/store/audioStore'
import { useRecordingStore } from '@/store/recordingStore'
import { useSettingsStore } from '@/store/settingsStore'

const MODES = [
  { value: 'auto', label: 'Captura del escritorio' },
  { value: 'device', label: 'Dispositivo virtual' }
] as const

const TRACK_LABELS: Record<AudioTrackKind, string> = {
  microphone: 'Micrófono',
  system: 'Audio del sistema'
}

interface TrackProps {
  kind: AudioTrackKind
  disabled: boolean
}

function TrackControl({ kind, disabled }: TrackProps) {
  const settings = useSettingsStore((state) => state.settings?.audio)
  const devices = useAudioStore((state) => state.devices)
  const levels = useAudioStore((state) => state.levels)
  const updateTrack = useAudioStore((state) => state.updateTrack)
  const updateSystem = useAudioStore((state) => state.updateSystem)
  const runtime = useRecordingStore((state) => state.status.audio[kind])
  const support = useAudioStore((state) => state.support)
  if (!settings) return null

  const track = settings[kind]
  const deviceOptions = devices.map((device) => ({ value: device.id, label: device.label }))
  const level = Math.round(levels[kind] * 100)
  const systemUnavailable =
    kind === 'system' &&
    settings.system.mode === 'auto' &&
    support?.systemAudio === 'unavailable'

  return (
    <div className="mixer__track">
      <div className="mixer__head">
        <span className="mixer__name">
          <Mic size={14} /> {TRACK_LABELS[kind]}
        </span>
        <div className="mixer__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label={track.muted ? `Activar ${TRACK_LABELS[kind]}` : `Silenciar ${TRACK_LABELS[kind]}`}
            title={track.muted ? 'Activar' : 'Silenciar'}
            disabled={disabled || !track.enabled}
            onClick={() => void updateTrack(kind, { muted: !track.muted })}
          >
            {track.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <Switch
            label={`Capturar ${TRACK_LABELS[kind]}`}
            checked={track.enabled}
            disabled={disabled || systemUnavailable}
            onChange={(enabled) => void updateTrack(kind, { enabled })}
          />
        </div>
      </div>

      {kind === 'system' && (
        <Select
          label="Origen"
          hideLabel
          value={settings.system.mode}
          options={MODES}
          disabled={disabled}
          onChange={(value) => void updateSystem({ mode: value as 'auto' | 'device' })}
        />
      )}

      <Select
        label={kind === 'microphone' ? 'Micrófono' : 'Dispositivo del sistema'}
        hideLabel
        value={track.deviceId ?? ''}
        options={deviceOptions}
        placeholder={kind === 'microphone' ? 'Micrófono predeterminado' : 'Dispositivo automático'}
        disabled={disabled || !track.enabled || (kind === 'system' && settings.system.mode === 'auto')}
        onChange={(value) => void updateTrack(kind, { deviceId: value || null })}
      />

      <div className="mixer__volume">
        <input
          type="range"
          min="0"
          max="2"
          step="0.05"
          aria-label={`Volumen de ${TRACK_LABELS[kind]}`}
          value={track.volume}
          disabled={disabled || !track.enabled}
          onChange={(event) => void updateTrack(kind, { volume: Number(event.target.value) })}
        />
        <span>{Math.round(track.volume * 100)}%</span>
      </div>

      {kind === 'microphone' && (
        <Switch
          label="Supresión de ruido"
          checked={track.noiseSuppression ?? true}
          disabled={disabled || !track.enabled}
          onChange={(value) => void updateTrack(kind, { noiseSuppression: value })}
        />
      )}

      <div
        className="mixer__level"
        role="meter"
        aria-label={`Nivel de ${TRACK_LABELS[kind]}`}
        aria-valuenow={level}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="mixer__level-fill" style={{ width: `${level}%` }} />
      </div>

      {systemUnavailable && (
        <p className="mixer__error">
          La captura automática no está disponible en esta plataforma; elige «Dispositivo virtual».
        </p>
      )}
      {runtime.error && <p className="mixer__error">{runtime.error}</p>}
      {runtime.active && runtime.label && <p className="mixer__source">{runtime.label}</p>}
    </div>
  )
}

/** Mezclador con control independiente y niveles reales del motor de audio. */
export function AudioMixer() {
  const active = useRecordingStore(
    (state) => state.status.state === 'recording' || state.status.state === 'paused'
  )
  const pollLevels = useAudioStore((state) => state.pollLevels)

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(pollLevels, 120)
    return () => window.clearInterval(timer)
  }, [active, pollLevels])

  return (
    <Panel title="Mezclador de audio" icon={<Volume2 size={15} />}>
      <div className="mixer">
        <TrackControl kind="microphone" disabled={active} />
        <TrackControl kind="system" disabled={active} />
      </div>
      <p className="field__hint">
        El volumen y el silencio se aplican en vivo; el dispositivo se aplica en la próxima grabación.
      </p>
    </Panel>
  )
}
