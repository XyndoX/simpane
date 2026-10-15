// What simpane runs: finding devices, taking a frame, and sending a tap, swipe,
// text or key. Pure command builders and parsers, so they're easy to test.
// iOS: AXe (frames, input; github.com/cameroncooke/AXe) and xcrun simctl (boot,
// frames without AXe). Android: adb and emulator.

export type Platform = 'ios' | 'android'
export type Device = { platform: Platform; id: string; name: string }
export type Choice = { id: string; name: string } // a device to boot
export type Argv = string[]

// The tools live outside the engine's PATH more often than not.
const EXTRA = '$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator'
export const sh = (script: string, ...args: string[]): Argv => ['/bin/sh', '-c', `PATH="$PATH:${EXTRA}"; ${script}`, 'sh', ...args]

export const listIos = sh('xcrun simctl list devices available -j')
export const listAndroid = sh('adb devices 2>/dev/null; echo ---; emulator -list-avds 2>/dev/null')
export const hasAxe = sh('command -v axe >/dev/null')

export function parseIos(json: string): { booted: Device[]; off: Choice[] } {
  const booted: Device[] = []
  const off: Choice[] = []
  const all = (JSON.parse(json) as { devices: Record<string, { udid: string; name: string; state: string }[]> }).devices
  for (const [runtime, list] of Object.entries(all)) {
    if (!/iOS/.test(runtime)) continue
    for (const d of list) {
      if (d.state === 'Booted') booted.push({ platform: 'ios', id: d.udid, name: d.name })
      else if (!off.some(o => o.name === d.name)) off.push({ id: d.udid, name: d.name })
    }
  }
  const phonesFirst = (a: { name: string }, b: { name: string }) => Number(b.name.startsWith('iPhone')) - Number(a.name.startsWith('iPhone'))
  return { booted: booted.sort(phonesFirst), off: off.sort(phonesFirst) }
}

export function parseAndroid(out: string): { booted: Device[]; off: Choice[] } {
  const [devs = '', avds = ''] = out.split('---')
  const booted = devs.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[1] === 'device').map(p => ({ platform: 'android' as const, id: p[0]!, name: p[0]! }))
  const off = avds.split('\n').map(l => l.trim()).filter(Boolean).map(n => ({ id: n, name: n.replace(/_/g, ' ') }))
  return { booted, off }
}

// Boots headless: the screen lives in the pane, not in a window.
export const boot = (p: Platform, id: string): Argv =>
  p === 'ios'
    ? sh('xcrun simctl boot "$1"', id)
    : sh('nohup emulator -avd "$1" -no-window -no-audio -no-boot-anim >/dev/null 2>&1 &', id)

export const capture = (d: Device, file: string): Argv =>
  d.platform === 'ios'
    ? sh('if command -v axe >/dev/null; then axe screenshot --udid "$1" --output "$2"; else xcrun simctl io "$1" screenshot --type=png "$2"; fi >/dev/null 2>&1', d.id, file)
    : sh('adb -s "$1" exec-out screencap -p > "$2"', d.id, file)

// The first 24 bytes of a PNG hold its width and height (big-endian, at 16 and 20).
export const pngHead = (file: string): Argv => sh('head -c 24 "$1" | od -An -tu1', file)
export function pngSize(od: string): { width: number; height: number } | null {
  const b = od.trim().split(/\s+/).map(Number)
  if (b.length < 24 || b[1] !== 80 || b[2] !== 78 || b[3] !== 71) return null // \x89PNG
  const u32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
  return { width: u32(16), height: u32(20) }
}

// iOS input is in points; the frame is in pixels. The app's frame is in points.
export const describeIos = (id: string): Argv => sh('axe describe-ui --udid "$1"', id)
export function densityOf(json: string, pixelWidth: number): number {
  const points = Number((JSON.parse(json) as { frame?: { width?: number } }[])[0]?.frame?.width)
  return points > 0 ? pixelWidth / points : 3
}

const r = Math.round
export function tap(d: Device, x: number, y: number): Argv {
  return d.platform === 'ios'
    ? sh('axe tap -x "$2" -y "$3" --udid "$1"', d.id, String(r(x)), String(r(y)))
    : sh('adb -s "$1" shell input tap "$2" "$3"', d.id, String(r(x)), String(r(y)))
}

export function swipe(d: Device, a: [number, number], b: [number, number], ms: number): Argv {
  const n = [a[0], a[1], b[0], b[1]].map(v => String(r(v)))
  return d.platform === 'ios'
    ? sh('axe swipe --start-x "$2" --start-y "$3" --end-x "$4" --end-y "$5" --duration "$6" --udid "$1"', d.id, ...n, String(ms / 1000))
    : sh('adb -s "$1" shell input swipe "$2" "$3" "$4" "$5" "$6"', d.id, ...n, String(r(ms)))
}

// `adb shell input text` goes through the device's shell: spaces become %s and
// the whole thing is single-quoted there.
export function text(d: Device, s: string): Argv {
  if (d.platform === 'ios') return sh('printf %s "$2" | axe type --stdin --udid "$1"', d.id, s)
  const quoted = "'" + s.replace(/%/g, '\\%').replace(/ /g, '%s').replace(/'/g, `'\\''`) + "'"
  return sh('adb -s "$1" shell input text "$2"', d.id, quoted)
}

export type Key = 'home' | 'back' | 'lock' | 'return' | 'backspace' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'apps'
// iOS: HID usage codes for keys, AXe buttons for hardware. Android: keyevents.
const IOS_KEY: Partial<Record<Key, number>> = { return: 40, backspace: 42, tab: 43, right: 79, left: 80, down: 81, up: 82 }
const IOS_BUTTON: Partial<Record<Key, string>> = { home: 'home', lock: 'lock' }
const ANDROID_KEY: Record<Key, number> = { home: 3, back: 4, lock: 26, return: 66, backspace: 67, tab: 61, up: 19, down: 20, left: 21, right: 22, apps: 187 }

export function key(d: Device, k: Key): Argv | null {
  if (d.platform === 'android') return sh('adb -s "$1" shell input keyevent "$2"', d.id, String(ANDROID_KEY[k]))
  if (IOS_BUTTON[k]) return sh('axe button "$2" --udid "$1"', d.id, IOS_BUTTON[k]!)
  if (IOS_KEY[k]) return sh('axe key "$2" --udid "$1"', d.id, String(IOS_KEY[k]))
  return null // no back or app switcher button on iOS
}

// The biggest box of cells that keeps the frame's shape; a cell is about twice
// as tall as wide.
export function fit(width: number, height: number, cols: number, rows: number): { cols: number; rows: number } {
  const a = height / width
  const byRows = Math.max(4, Math.min(rows, Math.floor((cols * a) / 2)))
  return { cols: Math.max(4, Math.min(cols, Math.round((byRows * 2) / a))), rows: byRows }
}
