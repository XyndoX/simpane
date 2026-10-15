import type { ClientModule } from 'claude-code'

// An empty box over the device screen: it reports where a press starts and
// ends (as fractions of the box), and the keys, so the mod can tap or swipe.
export type OverlayProps = { cols: number; rows: number }

const Overlay: ClientModule<OverlayProps> = (props, surface) => {
  const { Box } = surface.elements
  surface.onPointer(e => {
    const at: [number, number] = [(e.fine?.x ?? e.x + 0.5) / props.cols, (e.fine?.y ?? e.y + 0.5) / props.rows]
    if (e.type === 'down' && (e.button ?? 'left') === 'left') surface.post({ down: at })
    else if (e.type === 'up') surface.post({ up: at })
  })
  surface.onKey(e => surface.post({ key: e.key }))
  return <Box width={props.cols} height={props.rows} />
}

export default Overlay
