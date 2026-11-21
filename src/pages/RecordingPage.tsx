import { useEffect, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import type { SourceRef } from '@shared/capture'
import { PreviewStage } from '@/components/capture/PreviewStage'
import { SourcePanel } from '@/components/capture/SourcePanel'
import { SourcePickerModal } from '@/components/capture/SourcePickerModal'
import { SourceTypeTiles, type SourceTab } from '@/components/capture/SourceTypeTiles'
import { AudioMixer } from '@/components/recording/AudioMixer'
import { OutputPanel } from '@/components/recording/OutputPanel'
import { RecordingDock } from '@/components/recording/RecordingDock'
import { RecordingNotices } from '@/components/recording/RecordingNotices'
import { VideoSettingsPanel } from '@/components/recording/VideoSettingsPanel'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useCaptureStore } from '@/store/captureStore'
import { useRecordingStore } from '@/store/recordingStore'

export function RecordingPage() {
  const [tab, setTab] = useState<SourceTab>('screen')
  const [pickerOpen, setPickerOpen] = useState(false)
  const { snapshot, error, busy, init, refresh, selectSource, setRegion, clearSelection } =
    useCaptureStore()
  const recordingStatus = useRecordingStore((state) => state.status)

  useEffect(() => {
    void init()
  }, [init])

  // Al cargar la selección guardada, el tipo de fuente refleja lo que ya estaba elegido.
  const selectedKind = snapshot?.selection?.kind
  useEffect(() => {
    if (selectedKind) setTab(selectedKind)
  }, [selectedKind])

  const recordingActive =
    recordingStatus.state === 'recording' || recordingStatus.state === 'paused'
  const selection = snapshot?.selection ?? null
  const selectedSource = selection
    ? snapshot?.sources.find((source) => source.id === selection.id && source.kind === selection.kind)
    : undefined

  const chooseTab = (next: SourceTab): void => {
    setTab(next)
    setPickerOpen(true)
  }

  const pick = (source: SourceRef): void => {
    void selectSource(source).then(() => setPickerOpen(false))
  }

  return (
    <div className="page page--wide">
      <header className="page__header page__header--split">
        <div>
          <h1>Grabar pantalla</h1>
          <p>Elige la fuente, ajusta la salida y graba con control real de inicio, pausa y fin.</p>
        </div>
        <Button
          icon={<RefreshCw size={14} />}
          onClick={() => void refresh()}
          disabled={busy || !snapshot}
        >
          Actualizar fuentes
        </Button>
      </header>

      {error && <p className="notice notice--error">{error}</p>}

      {!snapshot ? (
        <EmptyState
          icon={<Monitor size={26} />}
          title="Detectando fuentes"
          description="Consultando los monitores y ventanas reales del sistema…"
        />
      ) : (
        <>
          {snapshot.warnings.map((warning) => (
            <p
              key={warning}
              className={snapshot.permission === 'denied' ? 'notice notice--error' : 'notice'}
            >
              {warning}
            </p>
          ))}

          <div className="rec-layout">
            <div className="rec-main">
              <PreviewStage
                selection={selection}
                available={snapshot.selectionAvailable}
                thumbnailUrl={selectedSource?.thumbnailUrl ?? null}
                region={snapshot.region ?? null}
                onRegionChange={(region) => void setRegion(region)}
              />
              <RecordingDock />
              <RecordingNotices />
            </div>

            <div className="rec-side">
              <SourceTypeTiles value={tab} onChange={chooseTab} />
              <SourcePanel
                snapshot={snapshot}
                busy={busy}
                locked={recordingActive}
                onChange={() => setPickerOpen(true)}
                onClear={() => void clearSelection()}
              />
              <VideoSettingsPanel />
              <AudioMixer />
              <OutputPanel />
            </div>
          </div>

          <SourcePickerModal
            open={pickerOpen}
            tab={tab}
            snapshot={snapshot}
            busy={busy}
            locked={recordingActive}
            onClose={() => setPickerOpen(false)}
            onSelect={pick}
            onSaveRegion={setRegion}
          />
        </>
      )}
    </div>
  )
}
