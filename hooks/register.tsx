import type { EngineInterface, Register } from 'claude-code'
import * as dev from './devices'
import type { Choice, Device, Key, Platform } from './devices'
import type { OverlayProps } from './overlay'

const PANE = 'simpane'
const FRAME_MS = 200 // a frame is taken as soon as the last one is in, at most this often
const C = { fg: '#dadada', muted: '#6b6b6b', hot: '#a882ff', err: '#e06c75' }
const KEYS: Record<string, Key> = { return: 'return', enter: 'return', backspace: 'backspace', delete: 'backspace', tab: 'tab', up: 'up', down: 'down', left: 'left', right: 'right', escape: 'home' }

const S = {
  platform: 'ios' as Platform,
  found: { ios: { booted: [] as Device[], off: [] as Choice[] }, android: { booted: [] as Device[], off: [] as Choice[] } },
  device: null as Device | null,
  size: null as { width: number; height: number } | null, // the frame, in pixels
  density: 1, // pixels per input unit: points on iOS, 1 on Android
  axe: true,
  frame: null as { file: string; generation: number } | null,
  box: { cols: 0, rows: 0 },
  down: null as [number, number] | null,
  typed: '',
  status: '',
  error: '',
  loop: null as { cancel: () => void } | null,
  busy: false,
  ticks: 0,
  tmp: '/tmp',
}
const RUN_ID = Math.random().toString(36).slice(2, 8)
const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

async function run($: EngineInterface, argv: string[], timeoutMs = 10_000) {
  return $.process.run(argv, { timeoutMs })
}

async function discover($: EngineInterface) {
  try {
    const ios = await run($, dev.listIos)
    if (ios.exitCode === 0) S.found.ios = dev.parseIos(ios.stdout)
  } catch { /* no Xcode */ }
  try {
    S.found.android = dev.parseAndroid((await run($, dev.listAndroid)).stdout)
  } catch { /* no Android SDK */ }
  S.axe = (await run($, dev.hasAxe).catch(() => ({ exitCode: 1 }))).exitCode === 0
  pick(S.platform)
}

function pick(p: Platform) {
  S.platform = p
  const next = S.found[p].booted[0] ?? null
  if (next?.id !== S.device?.id) {
    S.device = next
    S.size = null
    S.frame = null
    S.density = 1
  }
}

// One frame: the device writes a PNG, the terminal reads it. Two files take
// turns, so the terminal never reads one half-written.
async function tick($: EngineInterface) {
  if (S.busy) return
  S.busy = true
  try {
    if (++S.ticks % 25 === 0 && !(await $.ui.panes()).some(p => p.id === PANE)) return stop()
    const d = S.device
    if (!d) return
    const gen = (S.frame?.generation ?? 0) + 1
    const file = `${S.tmp}/simpane-${RUN_ID}-${gen % 2}.png`
    const r = await run($, dev.capture(d, file))
    if (d !== S.device) return
    if (r.exitCode !== 0) {
      S.error = `no frame from ${d.name}: is it still running? (↻)`
      return redraw($)
    }
    const size = dev.pngSize((await run($, dev.pngHead(file))).stdout)
    if (!size) return
    const resized = !S.size || S.size.width !== size.width || S.size.height !== size.height
    S.size = size
    S.frame = { file, generation: gen }
    if (d.platform === 'ios' && S.axe && S.density === 1) {
      const r = await run($, dev.describeIos(d.id)).catch(() => null)
      S.density = r?.exitCode === 0 ? dev.densityOf(r.stdout, size.width) : 3
    }
    if (S.error) { S.error = ''; return redraw($) }
    if (resized || !(await blit($))) redraw($)
  } catch (err) {
    S.error = String(err)
    redraw($)
  } finally {
    S.busy = false
  }
}

async function blit($: EngineInterface): Promise<boolean> {
  if (!S.frame) return false
  const r = await $.ui.blit({ requestId: PANE, key: 'screen', source: { file: S.frame.file, format: 'png', generation: S.frame.generation } })
  return !('deny' in r && r.deny)
}

function stop() {
  S.loop?.cancel()
  S.loop = null
}

async function openPane($: EngineInterface, p?: Platform) {
  await $.ui.open({ id: PANE, title: 'Simulator', focus: true, rows: 40, columns: 48 })
  S.tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/$/, '')
  await refresh($, p)
  S.loop ??= $.clock.every(FRAME_MS, () => void tick($))
}

// Finds what's running and picks a device on platform `p` (or wherever one runs).
async function refresh($: EngineInterface, p?: Platform) {
  await discover($)
  if (p) pick(p)
  else if (!S.device) pick(S.found.ios.booted.length || !S.found.android.booted.length ? 'ios' : 'android')
  redraw($)
}

// Input goes out in the order it came; the next frame shows what it did.
let queue = Promise.resolve()
function send($: EngineInterface, argv: string[] | null, what: string) {
  if (!argv) return
  if (S.platform === 'ios' && !S.axe) {
    S.error = 'iOS input needs AXe: brew install cameroncooke/axe/axe'
    return redraw($)
  }
  queue = queue.then(async () => {
    const r = await run($, argv).catch(err => ({ exitCode: 1, stderr: String(err) }))
    S.status = r.exitCode === 0 ? what : ''
    S.error = r.exitCode === 0 ? '' : `${what} failed: ${String(r.stderr).trim().split('\n').pop()}`
    redraw($)
  })
}

const toDevice = (at: [number, number]): [number, number] => [
  (Math.min(1, Math.max(0, at[0])) * S.size!.width) / S.density,
  (Math.min(1, Math.max(0, at[1])) * S.size!.height) / S.density,
]

function release($: EngineInterface, up: [number, number]) {
  const down = S.down
  S.down = null
  if (!down || !S.device || !S.size) return
  const a = toDevice(down)
  const b = toDevice(up)
  const cell = 1 / Math.max(1, S.box.cols) // a move under about a cell is a tap
  if (Math.hypot(up[0] - down[0], (up[1] - down[1]) / 2) < cell) send($, dev.tap(S.device, ...a), `tap ${a.map(Math.round).join(',')}`)
  else send($, dev.swipe(S.device, a, b, 250), 'swipe')
}

// Typed letters gather for a moment, then go as one text input.
let typing: { cancel: () => void } | null = null
function flush($: EngineInterface) {
  typing?.cancel()
  typing = null
  if (S.typed && S.device) send($, dev.text(S.device, S.typed), `typed “${S.typed}”`)
  S.typed = ''
}

function keyIn($: EngineInterface, k: string) {
  if (!S.device) return
  const ch = k === 'space' ? ' ' : k
  if ([...ch].length === 1) {
    S.typed += ch
    typing?.cancel()
    typing = $.clock.after(150, () => flush($))
    return
  }
  flush($)
  const named = KEYS[k]
  if (named) send($, dev.key(S.device, named), named)
}

let wheel = 0
let wheelTimer: { cancel: () => void } | null = null
function scroll($: EngineInterface, by: number) {
  if (!S.device || !S.size) return
  wheel += by
  wheelTimer ??= $.clock.after(120, () => {
    wheelTimer = null
    const d = S.device
    if (!d || !S.size) return
    // Wheel down reads further: the finger moves up.
    const dy = Math.max(-0.35, Math.min(0.35, -wheel * 0.06))
    wheel = 0
    send($, dev.swipe(d, toDevice([0.5, 0.5 - dy / 2]), toDevice([0.5, 0.5 + dy / 2]), 150), 'scroll')
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'simpane', description: 'iPhone / Android simulator screen in a pane: tap, swipe, type; args: [ios|android]' })
    return r
  })

  on('command.run', { command: 'simpane' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    await openPane($, arg === 'android' || arg === 'ios' ? arg : undefined)
    const d = S.device
    return { text: d ? `simpane: ${d.name}. Click to tap, drag to swipe, click the pane and type to type.` : `simpane: no ${S.platform === 'ios' ? 'simulator' : 'emulator'} running; boot one from the pane.` }
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'touch' || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { down?: [number, number]; up?: [number, number]; key?: string }
    if (data.down) S.down = data.down
    else if (data.up) release($, data.up)
    else if (typeof data.key === 'string') keyIn($, data.key)
    return {}
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    scroll($, e.by)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Client, Image } = $.ui.resolve(e)
    const cols = Math.max(20, (e.props?.bodyColumns ?? 48) - 1)
    const height = Math.max(10, e.props?.scroll?.bodyRows ?? 36)
    const d = S.device
    const tab = (p: Platform, label: string) => (
      <Button key={`tab-${p}`} plain dimColor={S.platform !== p} label={S.platform === p ? `[ ${label} ]` : `  ${label}  `} onPress={() => { pick(p); void refresh($, p) }} />
    )
    const tool = (id: string, label: string, k: Key) => <Button key={id} plain dimColor label={label} onPress={() => { if (d) send($, dev.key(d, k), k) }} />
    const header = (
      <Box flexDirection="row">
        {tab('ios', 'iPhone')}
        {tab('android', 'Android')}
        <Box flexGrow={1} />
        {d && tool('home', ' ⌂ ', 'home')}
        {d?.platform === 'android' && tool('back', ' ◁ ', 'back')}
        {d?.platform === 'android' && tool('apps', ' ▢ ', 'apps')}
        <Button key="refresh" plain dimColor label=" ↻" onPress={() => void refresh($, S.platform)} />
      </Box>
    )
    const status = <Text color={S.error ? C.err : C.muted} wrap="truncate-end">{S.error || S.status || ' '}</Text>

    if (!d) {
      const off = S.found[S.platform].off
      const none = S.platform === 'ios'
        ? 'No iOS simulator found. Install Xcode, then: xcrun simctl list'
        : 'No Android emulator found. brew install --cask android-commandlinetools, then sdkmanager + avdmanager (or Android Studio → Device Manager).'
      return (
        <Box flexDirection="column" minHeight={height}>
          {header}
          <Text color={C.fg}>{off.length ? `Nothing running. Boot one (headless, it shows here):` : none}</Text>
          {off.slice(0, Math.max(1, height - 5)).map(c => (
            <Button key={`boot-${c.id}`} plain label={`  ▸ ${c.name}`} onPress={() => {
              S.status = `booting ${c.name}…`
              redraw($)
              void run($, dev.boot(S.platform, c.id), 60_000).then(async r => {
                S.error = r.exitCode === 0 ? '' : `boot failed: ${r.stderr.trim()}`
                // The emulator takes a while to show up in adb.
                for (let i = 0; i < 30 && !S.device && !S.error; i++) {
                  await new Promise(res => $.clock.after(2000, () => res(null)))
                  await refresh($, S.platform)
                }
                S.status = ''
                redraw($)
              })
            }} />
          ))}
          <Box flexGrow={1} />
          {status}
        </Box>
      )
    }

    const box = S.size ? dev.fit(S.size.width, S.size.height, cols, height - 4) : { cols: Math.min(cols, 24), rows: height - 4 }
    S.box = box
    const screen = S.frame
      ? <Image key="screen" source={{ file: S.frame.file, format: 'png', generation: S.frame.generation }} columns={box.cols} rows={box.rows} alt={d.name} />
      : <Box width={box.cols} height={box.rows}><Text color={C.muted}>waiting for the first frame…</Text></Box>
    return (
      <Box flexDirection="column" minHeight={height}>
        {header}
        <Text color={C.hot} bold wrap="truncate-end">{`${d.name}${S.typed ? `  ⌨ ${S.typed}` : ''}`}</Text>
        <Box flexDirection="row">
          <Box flexGrow={1} />
          <Box key="stage" position="relative" width={box.cols} height={box.rows}>
            {screen}
            <Box key="hit" position="absolute" top={0} left={0}>
              <Client key="touch" module="./overlay.tsx" props={{ cols: box.cols, rows: box.rows } satisfies OverlayProps} />
            </Box>
          </Box>
          <Box flexGrow={1} />
        </Box>
        {status}
        <Text color={C.muted} wrap="truncate-end">click tap · drag swipe · wheel scroll · type into the focused pane · esc home</Text>
      </Box>
    )
  })
}
