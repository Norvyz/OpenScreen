import { Monitor, Play, Square, VideoOff } from 'lucide-react'
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { CaptureRegion, SourceRef } from '@shared/capture'
import { Button } from '@/components/ui/Button'
import { usePreviewStream } from '@/hooks/usePreviewStream'
import { cn } from '@/utils/cn'

interface PreviewStageProps {
  selection: SourceRef | null
  available: boolean
  /** Miniatura real que devolvió `desktopCapturer` para la fuente elegida (si existe). */
  thumbnailUrl?: string | null
  region?: CaptureRegion | null
  onRegionChange?: (region: CaptureRegion) => void
}

/**
 * Escenario principal de la página Grabar. Mientras la vista previa en vivo está apagada muestra
 * la miniatura real de la fuente; al encenderla muestra el mismo `MediaStream` que se grabará.
 */
export function PreviewStage({
  selection,
  available,
  thumbnailUrl,
  region,
  onRegionChange
}: PreviewStageProps) {
  const { videoRef, active, error, canPreview, start, stop } = usePreviewStream(selection, available)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null)
  const [currentPoint, setCurrentPoint] = useState<{ x: number; y: number } | null>(null)
  const showThumbnail = !active && Boolean(thumbnailUrl) && available

  const toSourceCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const container = containerRef.current
      if (!container) return null
      const rect = container.getBoundingClientRect()
      const px = Math.max(0, Math.min(rect.width, clientX - rect.left))
      const py = Math.max(0, Math.min(rect.height, clientY - rect.top))
      const sourceWidth = (active ? videoRef.current?.videoWidth : selection?.width) ?? selection?.width ?? rect.width
      const sourceHeight = (active ? videoRef.current?.videoHeight : selection?.height) ?? selection?.height ?? rect.height
      const scaleX = sourceWidth / Math.max(1, rect.width)
      const scaleY = sourceHeight / Math.max(1, rect.height)
      return { x: Math.round(px * scaleX), y: Math.round(py * scaleY) }
    },
    [active, selection, videoRef]
  )

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!onRegionChange || !selection || !available) return
    const coords = toSourceCoords(event.clientX, event.clientY)
    if (!coords) return
    setDragging(true)
    setStartPoint(coords)
    setCurrentPoint(coords)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const coords = toSourceCoords(event.clientX, event.clientY)
    if (coords) setCurrentPoint(coords)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging || !startPoint || !currentPoint || !onRegionChange) {
      setDragging(false)
      setStartPoint(null)
      setCurrentPoint(null)
      return
    }
    const x = Math.min(startPoint.x, currentPoint.x)
    const y = Math.min(startPoint.y, currentPoint.y)
    const width = Math.abs(currentPoint.x - startPoint.x)
    const height = Math.abs(currentPoint.y - startPoint.y)
    if (width > 4 && height > 4) {
      onRegionChange({ x, y, width, height })
    }
    setDragging(false)
    setStartPoint(null)
    setCurrentPoint(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // El puntero ya se liberó; no es un error.
    }
  }

  const rectStyle =
    dragging && startPoint && currentPoint
      ? {
          left: `${Math.min(startPoint.x, currentPoint.x) / ((active ? videoRef.current?.videoWidth : selection?.width) ?? 1) * 100}%`,
          top: `${Math.min(startPoint.y, currentPoint.y) / ((active ? videoRef.current?.videoHeight : selection?.height) ?? 1) * 100}%`,
          width: `${Math.abs(currentPoint.x - startPoint.x) / ((active ? videoRef.current?.videoWidth : selection?.width) ?? 1) * 100}%`,
          height: `${Math.abs(currentPoint.y - startPoint.y) / ((active ? videoRef.current?.videoHeight : selection?.height) ?? 1) * 100}%`
        }
      : null

  return (
    <div className="stage-wrap">
      <div
        ref={containerRef}
        className={cn('stage', active && 'stage--live')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ cursor: onRegionChange ? 'crosshair' : undefined, position: 'relative', touchAction: 'none' }}
      >
        <video ref={videoRef} className="stage__video" autoPlay muted playsInline />
        {showThumbnail && <img className="stage__thumb" src={thumbnailUrl ?? undefined} alt="" />}
        {!active && !showThumbnail && (
          <div className="stage__placeholder">
            {selection ? <VideoOff size={28} /> : <Monitor size={28} />}
            <strong>
              {selection && !available ? 'Fuente no disponible' : 'Elige qué quieres grabar'}
            </strong>
            <span>
              {selection && !available
                ? 'La fuente guardada ya no existe. Elige otra en «Fuente».'
                : 'Selecciona un monitor o una ventana en el panel de la derecha.'}
            </span>
          </div>
        )}
        {region && !dragging && (
          <div
            className="stage__region"
            style={{
              left: `${(region.x / ((selection?.width ?? 1))) * 100}%`,
              top: `${(region.y / ((selection?.height ?? 1))) * 100}%`,
              width: `${(region.width / ((selection?.width ?? 1))) * 100}%`,
              height: `${(region.height / ((selection?.height ?? 1))) * 100}%`
            }}
          />
        )}
        {rectStyle && <div className="stage__region stage__region--draft" style={rectStyle} />}
        <div className="stage__bar">
          <span className="stage__tag">
            {dragging ? 'Seleccionando región…' : active ? 'Vista previa en vivo' : showThumbnail ? 'Miniatura de la fuente' : 'Sin vista previa'}
          </span>
          {active ? (
            <Button icon={<Square size={12} />} onClick={stop}>
              Detener vista previa
            </Button>
          ) : (
            <Button icon={<Play size={12} />} onClick={() => void start()} disabled={!canPreview}>
              Ver vista previa
            </Button>
          )}
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
    </div>
  )
}
