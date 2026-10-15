import { expect, mock, test } from 'claude-code/testing'
import * as dev from '../hooks/devices'

const UDID = '23178DE1-E556-4C3C-A2C0-A3A1CC59AA9A'
const SIMCTL = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.watchOS-26-5': [{ udid: 'W', name: 'Apple Watch', state: 'Booted' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
      { udid: 'P', name: 'iPad Pro', state: 'Shutdown' },
      { udid: UDID, name: 'iPhone 17', state: 'Booted' },
      { udid: 'Q', name: 'iPhone Air', state: 'Shutdown' },
    ],
  },
})
// od -An -tu1 of a PNG's first 24 bytes: 1206 × 2622.
const HEAD = ' 137  80  78  71  13  10  26  10   0   0   0  13  73  72  68  82\n   0   0   4 182   0   0  10  62\n'

test('device lists, PNG sizes, the box fit and the input commands', () => {
  const ios = dev.parseIos(SIMCTL)
  expect(ios.booted.map(d => d.name)).toEqual(['iPhone 17']) // no watch
  expect(ios.off.map(d => d.name)).toEqual(['iPhone Air', 'iPad Pro'])
  const android = dev.parseAndroid('List of devices attached\nemulator-5554\tdevice\nR58M\tunauthorized\n\n---\nPixel_8_API_35\n')
  expect(android.booted.map(d => d.id)).toEqual(['emulator-5554'])
  expect(android.off).toEqual([{ id: 'Pixel_8_API_35', name: 'Pixel 8 API 35' }])
  expect(dev.pngSize(HEAD)).toEqual({ width: 1206, height: 2622 })
  expect(dev.pngSize('1 2 3')).toBe(null)
  const box = dev.fit(1206, 2622, 60, 30)
  expect(box.rows).toBe(30)
  expect(Math.abs((box.rows * 2) / box.cols - 2622 / 1206) < 0.1).toBe(true)

  const phone = { platform: 'android' as const, id: 'emulator-5554', name: 'x' }
  expect(dev.text(phone, "it's 5 %").slice(-1)[0]).toBe(`'it'\\''s%s5%s\\%'`)
  expect(dev.key(phone, 'back')!.slice(-1)[0]).toBe('4')
  const sim = { platform: 'ios' as const, id: UDID, name: 'iPhone 17' }
  expect(dev.key(sim, 'back')).toBe(null)
  expect(dev.key(sim, 'home')!.slice(-1)[0]).toBe('home')
  expect(dev.densityOf('[{"frame":{"width":390}}]', 1170)).toBe(3)
  expect(dev.tap(sim, 100.4, 200.6).slice(-2)).toEqual(['100', '201'])
})

test('the pane mirrors the booted iPhone and turns clicks, drags and keys into input', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  mock.env(on, { TMPDIR: '/tmp/' })
  const sent: string[][] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'simpane', title: 'Simulator', isShown: true, isFocused: true, isPlaced: true }] }))
  on('process.run', (_$: any, e: any) => {
    const script = String(e.argv[2])
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (script.includes('simctl list')) return ok(SIMCTL)
    if (script.includes('adb devices')) return ok('List of devices attached\n\n---\n')
    if (script.includes('command -v axe >/dev/null')) return ok()
    if (script.includes('describe-ui')) return ok(JSON.stringify([{ type: 'Application', frame: { x: 0, y: 0, width: 402, height: 874 } }]))
    if (script.includes('screenshot')) return ok()
    if (script.includes('od -An')) return ok(HEAD)
    sent.push(e.argv.slice(4))
    return ok()
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as any)
  const res = await $.command.run({ command: 'simpane', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(JSON.stringify(res)).toContain('iPhone 17')
  await clock.advance(500)
  await clock.settle()
  const props = { title: 'Simulator', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} } as any
  const ui = await $.ui.mount({ plugin: 'simpane', surface: 'terminal', component: 'Pane', requestId: 'simpane', props })
  await clock.settle()
  const shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('"type":"Image"')
  expect(shown).toContain('"file":"/tmp/simpane-')
  expect(shown).toContain('"format":"png"')

  // A click in the middle taps the middle of the screen, in points (402 × 874).
  await ui.post({ down: [0.5, 0.5] }, { in: 'touch' })
  await ui.post({ up: [0.5, 0.5] }, { in: 'touch' })
  await clock.settle()
  expect(sent.at(-1)).toEqual([UDID, '201', '437'])
  // A drag swipes.
  await ui.post({ down: [0.5, 0.8] }, { in: 'touch' })
  await ui.post({ up: [0.5, 0.2] }, { in: 'touch' })
  await clock.settle()
  expect(sent.at(-1)).toEqual([UDID, '201', '699', '201', '175', '0.25'])
  // Letters gather into one text input; return is a key.
  for (const k of ['h', 'i', 'space', '!']) await ui.post({ key: k }, { in: 'touch' })
  await clock.advance(200)
  await clock.settle()
  expect(sent.at(-1)).toEqual([UDID, 'hi !'])
  await ui.post({ key: 'return' }, { in: 'touch' })
  await clock.settle()
  expect(sent.at(-1)).toEqual([UDID, '40'])
  await ui.post({ key: 'escape' }, { in: 'touch' })
  await clock.settle()
  expect(sent.at(-1)).toEqual([UDID, 'home'])
})
