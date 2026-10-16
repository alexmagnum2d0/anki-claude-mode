import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AnkiCard, AnkiConnection, AnkiDeck, AnkiImage, AnkiLanguage, AnkiToday, CardPart } from '../types'
import { isLanguage, WORDS, type Words } from './words'

const PANE = 'anki'
const ANKI_URL = 'http://127.0.0.1:8765'
const POLL_MS = 30_000
const ANKICONNECT_CODE = '2055492159'

const connection = atom({ plugin: 'anki', key: 'connection' } as const, {
  kind: 'unknown',
} as AnkiConnection)
const decks = atom({ plugin: 'anki', key: 'decks' } as const, [] as AnkiDeck[])
const review = atom({ plugin: 'anki', key: 'review' } as const, null as AnkiCard | null)
const images = atom({ plugin: 'anki', key: 'images' } as const, {} as Record<string, AnkiImage>)
const reviewDeck = atom({ plugin: 'anki', key: 'reviewDeck' } as const, null as string | null)
const busy = atom({ plugin: 'anki', key: 'busy' } as const, false)
const reviewedCount = atom({ plugin: 'anki', key: 'reviewedCount' } as const, 0)
const added = atom({ plugin: 'anki', key: 'added' } as const, [] as string[])
const today = atom({ plugin: 'anki', key: 'today' } as const, null as AnkiToday | null)
// English until the person picks; the pick is kept in the store across sessions.
const language = atom({ plugin: 'anki', key: 'language' } as const, 'en' as AnkiLanguage)

type $ = EngineInterface

// AnkiConnect: one POST per action, `{ result, error }` back.
async function anki<T>($: $, action: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await $.http.fetch(ANKI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  })
  if (!response.ok) throw new Error(`AnkiConnect answered HTTP ${response.status}`)
  const body = JSON.parse(response.text) as { result: T; error: string | null }
  if (body.error) throw new Error(body.error)

  return body.result
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
}

// Card HTML as plain text: the pane draws text, not a web page.
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\[sound:[^\]]*\]/g, '🔊')
    .replace(/<img[^>]*>/gi, '🖼')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n—\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

type DeckStats = Record<
  string,
  { name: string; new_count: number; learn_count: number; review_count: number; total_in_deck: number }
>

// Every write redraws the pane, and a redraw under the pointer can eat a click.
function isSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function setConnection($: $, value: AnkiConnection): Promise<void> {
  if (!isSame(await read($, connection), value)) await update($, connection, () => value)
}

// Runs `work` off the press: the press returns at once, a second press while
// the work runs is dropped (no card is graded twice), and the pane shows "…".
async function act($: $, work: () => Promise<void>): Promise<void> {
  let wasBusy = false
  await update($, busy, now => {
    wasBusy = now === true
    return true
  })
  if (wasBusy) {
    return
  }
  $.clock.after(0, () => {
    work()
      .catch(error => $.ui.toast(`Anki: ${reasonOf(error)}`))
      .finally(async () => {
        await update($, busy, () => false)
      })
  })
}

// A click on a pane that does not hold the keyboard only gives it the
// keyboard: the desktop raises `ui.focus` naming the button, and no press.
// Every button is bound here by its key, so that focus can run it.
const actions = new Map<string, () => void>()
const pressedAt = new Map<string, number>()
let drawnOn = ''
// Whether the pane has been drawn without the keyboard for a while. Focus that
// lands while the pane holds the keyboard is the host's own move (the answer
// field vanished, a button redrew), never a click; and the host can draw the
// pane unfocused and focus it again a few ms later, which is no click either.
let isUnfocusedSettled = false
let drawnCount = 0
const SETTLED_MS = 100

function bind(key: string, run: () => void): { key: string; onPress: () => void } {
  actions.set(key, run)

  return {
    key,
    onPress: () => {
      pressedAt.set(key, Date.now())
      run()
    },
  }
}

// A click that only focused: the person's focus on a bound button, with no
// press of it close by (a click on a pane that has the keyboard presses first).
const CLICK_WINDOW_MS = 150

function runSwallowedClick($: $, key: string): void {
  const focusedAt = Date.now()
  $.clock.after(CLICK_WINDOW_MS, () => {
    const pressed = pressedAt.get(key)
    if (pressed !== undefined && Math.abs(pressed - focusedAt) < 1000) return
    actions.get(key)?.()
  })
}

// Sounds play off any dispatch, so a press never waits for a clip to end.
function playLater($: $, files: string[]): void {
  if (files.length > 0) $.clock.after(0, () => void playSounds($, files))
}

async function refreshDecks($: $): Promise<void> {
  try {
    const names = await anki<string[]>($, 'deckNames')
    const stats = await anki<DeckStats>($, 'getDeckStats', { decks: names })
    const list = Object.values(stats)
      .map(one => ({
        name: one.name,
        newCount: one.new_count,
        learnCount: one.learn_count,
        reviewCount: one.review_count,
        total: one.total_in_deck,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (!isSame(await read($, decks), list)) await update($, decks, () => list)
    await setConnection($, { kind: 'ok' })
  } catch (error) {
    await setConnection($, { kind: 'offline', reason: reasonOf(error) })
    return
  }
  await refreshToday($)
}

// A day in Anki is never longer than this, whatever its rollover hour.
const DAY_BOUND_MS = 48 * 60 * 60 * 1000

// One revlog row as cardReviews answers it; the eighth value is the time taken, in ms.
type ReviewRow = [number, number, number, number, number, number, number, number, number]

// What Anki's deck list says under the decks: the cards studied today and the
// time they took. Anki counts today from its own rollover hour, which AnkiConnect
// does not give; its count of today's reviews does follow it, so the time is
// summed over that many latest reviews.
async function refreshToday($: $): Promise<void> {
  try {
    const cards = await anki<number>($, 'getNumCardsReviewedToday')
    let seconds = 0
    if (cards > 0) {
      const names = await anki<string[]>($, 'deckNames')
      const startID = Date.now() - DAY_BOUND_MS
      const answers = await anki<({ result: ReviewRow[] | null } | ReviewRow[])[]>($, 'multi', {
        actions: names.map(deck => ({ action: 'cardReviews', params: { deck, startID } })),
      })
      const rows = answers
        .flatMap(one => (Array.isArray(one) ? one : (one.result ?? [])))
        .sort((a, b) => a[0] - b[0])
      seconds = rows.slice(-cards).reduce((sum, row) => sum + row[7], 0) / 1000
    }
    const value = { cards, seconds }
    if (!isSame(await read($, today), value)) await update($, today, () => value)
  } catch {
    // The line under the decks is a nicety: without it the list still works.
  }
}

async function words($: $): Promise<Words> {
  return WORDS[await read($, language)]
}

async function setLanguage($: $, value: AnkiLanguage): Promise<void> {
  await update($, language, () => value)
  await $.store.set('language', value)
}

// What guiCurrentCard answers: the card Anki's own reviewer shows now.
type CardInfo = {
  cardId: number
  deckName: string
  modelName: string
  template: string
  question: string
  answer: string
  fields: Record<string, { value: string; order: number }>
  buttons: number[]
  nextReviews: string[]
}

const SOUND = /\[sound:([^\]]+)\]/g
const TOKEN =
  /<img[^>]*?src=["']?([^"' >]+)["']?[^>]*>|\[anki:play:[qa]:(\d+)\]|\[sound:([^\]]+)\]|\[\[type:(?:[a-z]+:)*([^\]]+)\]\]/gi

// One side's HTML as parts; `sounds` are that side's [anki:play:…] files in order.
export function cardParts(html: string, sounds: string[], fields: CardInfo['fields']): CardPart[] {
  const clean = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  const parts: CardPart[] = []
  const pushText = (chunk: string) => {
    const text = htmlToText(chunk)
    if (text !== '') parts.push({ kind: 'text', text })
  }
  let at = 0
  for (const match of clean.matchAll(TOKEN)) {
    pushText(clean.slice(at, match.index))
    at = match.index + match[0].length
    const [, image, playIndex, sound, typeField] = match
    if (image !== undefined) parts.push({ kind: 'image', file: decodeURIComponent(image) })
    else if (playIndex !== undefined) {
      const file = sounds[Number(playIndex)]
      if (file !== undefined) parts.push({ kind: 'sound', file })
    } else if (sound !== undefined) parts.push({ kind: 'sound', file: sound })
    else if (typeField !== undefined) {
      parts.push({ kind: 'type', expected: htmlToText(fields[typeField.trim()]?.value ?? '') })
    }
  }
  pushText(clean.slice(at))

  return parts
}

// The sound files a template side plays, in the order Anki numbers them.
export function templateSounds(template: string, fields: CardInfo['fields'], front = ''): string[] {
  const sounds: string[] = []
  for (const [, token = ''] of template.matchAll(/{{([^}]+)}}/g)) {
    if (/^[#^/!]/.test(token)) continue
    const name = token.split(':').pop()?.trim() ?? ''
    if (name === 'FrontSide') sounds.push(...templateSounds(front, fields))
    else for (const [, file = ''] of (fields[name]?.value ?? '').matchAll(SOUND)) sounds.push(file)
  }

  return sounds
}

type Templates = Record<string, { Front: string; Back: string }>

const templatesByModel = new Map<string, Templates>()

async function sidesSounds($: $, info: CardInfo): Promise<{ question: string[]; answer: string[] }> {
  try {
    const templates =
      templatesByModel.get(info.modelName) ??
      (await anki<Templates>($, 'modelTemplates', { modelName: info.modelName }))
    templatesByModel.set(info.modelName, templates)
    const template = templates[info.template] ?? Object.values(templates)[0]
    if (template !== undefined) {
      return {
        question: templateSounds(template.Front, info.fields),
        answer: templateSounds(template.Back, info.fields, template.Front),
      }
    }
  } catch {
    // Fall through to the fields' own order.
  }
  const all = Object.values(info.fields)
    .sort((a, b) => a.order - b.order)
    .flatMap(field => [...field.value.matchAll(SOUND)].map(([, file = '']) => file))

  return { question: all, answer: all }
}

const MAX_IMAGE_BASE64 = 120_000

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  return bytes
}

// Width and height from a PNG, GIF or JPEG header.
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const at = (i: number) => bytes[i] ?? 0
  if (at(0) === 0x89 && at(1) === 0x50) {
    return { width: (at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19), height: (at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23) }
  }
  if (at(0) === 0x47 && at(1) === 0x49) return { width: at(6) | (at(7) << 8), height: at(8) | (at(9) << 8) }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) {
        i++
        continue
      }
      const marker = at(i + 1)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (at(i + 5) << 8) | at(i + 6), width: (at(i + 7) << 8) | at(i + 8) }
      }
      i += 2 + ((at(i + 2) << 8) | at(i + 3))
    }
  }

  return null
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
}

function mimeOf(file: string): string | undefined {
  return MIME[file.split('.').pop()?.toLowerCase() ?? '']
}

async function loadImage($: $, file: string): Promise<AnkiImage> {
  const mime = mimeOf(file)
  if (mime === undefined || !mime.startsWith('image/')) return { missing: 'not-image' }
  const base64 = await anki<string | false>($, 'retrieveMediaFile', { filename: file })
  if (base64 === false) return { missing: 'no-file' }
  if (base64.length > MAX_IMAGE_BASE64) return { missing: 'too-large' }
  const size = imageSize(bytesOf(base64)) ?? { width: 400, height: 300 }
  const { width, height } = size

  return {
    width,
    height,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
      `<image href="data:${mime};base64,${base64}" width="${width}" height="${height}"/></svg>`,
  }
}

async function loadImages($: $, card: AnkiCard): Promise<void> {
  const known = await read($, images)
  const files = [...card.question, ...card.answer].flatMap(part =>
    part.kind === 'image' && known[part.file] === undefined ? [part.file] : [],
  )
  for (const file of new Set(files)) {
    let image: AnkiImage
    try {
      image = await loadImage($, file)
    } catch (error) {
      image = { missing: 'unreadable', reason: reasonOf(error) }
    }
    await update($, images, all => ({ ...all, [file]: image }))
  }
}

// Plays a side's sounds one after another, as Anki does when a side shows.
async function playSounds($: $, files: string[]): Promise<void> {
  for (const file of files) {
    try {
      const base64 = await anki<string | false>($, 'retrieveMediaFile', { filename: file })
      if (base64 === false) continue
      await $.audio.play({ base64, mime: mimeOf(file) ?? 'audio/mpeg' })
    } catch (error) {
      $.ui.toast((await words($)).soundFailed(reasonOf(error)))
      return
    }
  }
}

function soundsOf(parts: CardPart[]): string[] {
  return parts.flatMap(part => (part.kind === 'sound' ? [part.file] : []))
}

// A card as this version keeps it; one kept by an older version (its sides plain
// strings) survives a reload in $.state and is dropped instead of drawn.
export function isCurrentCard(card: unknown): card is AnkiCard {
  const c = card as Partial<AnkiCard> | null
  return (
    c !== null && typeof c === 'object' && Array.isArray(c.question) && Array.isArray(c.answer) && Array.isArray(c.grades)
  )
}

async function currentCard($: $): Promise<AnkiCard | null> {
  const card = await read($, review)

  return isCurrentCard(card) ? card : null
}

// What was typed into a [[type:…]] field before the answer showed.
let draft = ''

async function showAnswer($: $, typed: string | null): Promise<void> {
  const card = await currentCard($)
  if (card === null || card.isAnswerShown) return
  // Anki's reviewer shows the answer too (and plays its sounds), so a grade lands.
  await anki($, 'guiShowAnswer')
  await update($, review, c => (c ? { ...c, typed, isAnswerShown: true } : c))
}

// Anki's buttons by count: 4 is Again/Hard/Good/Easy, 3 drops Hard, 2 is
// Again/Good. "Good" is keyed "main", the key "Show answer" has too.
type GradeKey = keyof Words['grades']

const GRADES: Record<number, GradeKey[]> = {
  2: ['again', 'main'],
  3: ['again', 'main', 'easy'],
  4: ['again', 'hard', 'main', 'easy'],
}

function gradeOf(ease: number, count: number, w: Words): { key: string; label: string } {
  const key = GRADES[count]?.[ease - 1]
  return key === undefined ? { key: `ease-${ease}`, label: String(ease) } : { key, label: w.grades[key] }
}

// A short one-line text (a word, a phrase) is drawn as a heading: the card's
// main thing, as large as Anki draws it.
const SHORT = 40

function markdownEscape(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>~<])/g, '\\$1')
}

// Anki's own colours: the deck counts, and the typed-answer comparison
// (its .typeGood, .typeBad and .typeMissed).
const COUNT_COLOR = { new: '#3b82f6', learn: '#dc2626', review: '#16a34a' }
// Columns a deck count takes: room for four digits.
const COUNT_CELL = 4
const RUN_BACKGROUND = { good: '#aaffaa', bad: '#ffaaaa', missed: '#cccccc' }

type Run = { kind: 'good' | 'bad' | 'missed'; text: string }

function pushRun(runs: Run[], kind: Run['kind'], char: string): void {
  const last = runs[runs.length - 1]
  if (last !== undefined && last.kind === kind) last.text += char
  else runs.push({ kind, text: char })
}

// The typed answer against the expected one, letter by letter, as Anki shows
// it: in what was typed the letters that match are good and the rest bad; in
// the expected answer the letters that match are good and the rest missed.
export function compareTyped(typed: string, expected: string): { typed: Run[]; expected: Run[] } {
  const a = [...typed.normalize('NFC')]
  const b = [...expected.normalize('NFC')]
  // Longest common subsequence, filled from the end.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i]
      if (row !== undefined) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const result = { typed: [] as Run[], expected: [] as Run[] }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const x = a[i]
    const y = b[j]
    if (x !== undefined && x === y) {
      pushRun(result.typed, 'good', x)
      pushRun(result.expected, 'good', x)
      i++
      j++
    } else if (x !== undefined && (y === undefined || at(i + 1, j) >= at(i, j + 1))) {
      pushRun(result.typed, 'bad', x)
      i++
    } else if (y !== undefined) {
      pushRun(result.expected, 'missed', y)
      j++
    }
  }

  return result
}

// The card Anki's own reviewer shows now, or back to the decks when it shows none.
async function loadCurrentCard($: $): Promise<void> {
  let info: CardInfo
  try {
    info = await anki<CardInfo>($, 'guiCurrentCard')
  } catch {
    // The reviewer is not active: the deck has nothing left for today.
    const deck = await read($, reviewDeck)
    await update($, review, () => null)
    await update($, reviewDeck, () => null)
    // Anki stays on its own "Congratulations" page, as it does without the pane.
    $.ui.toast((await words($)).deckDone(deck ?? ''))
    await refreshDecks($)
    return
  }
  const sounds = await sidesSounds($, info)
  const card: AnkiCard = {
    cardId: info.cardId,
    deck: info.deckName,
    question: cardParts(info.question, sounds.question, info.fields),
    answer: cardParts(info.answer, sounds.answer, info.fields),
    grades: info.buttons.map((ease, i) => ({ ease, next: htmlToText(info.nextReviews[i] ?? '') })),
    typed: null,
    isAnswerShown: false,
  }
  draft = ''
  await update($, review, () => card)
  await loadImages($, card)
}

async function startReview($: $, deck: string): Promise<void> {
  // Opening a deck with nothing to study sends Anki to its "Congratulations"
  // page, and leaving it at once aborts that page's load ("Failed to fetch"
  // in Anki). Ask fresh counts first, and leave Anki alone when there is none.
  const stats = Object.values(await anki<DeckStats>($, 'getDeckStats', { decks: [deck] }))[0]
  if (stats !== undefined && stats.new_count + stats.learn_count + stats.review_count === 0) {
    $.ui.toast((await words($)).nothingDue(deck))
    await refreshDecks($)
    return
  }
  if (!(await anki<boolean>($, 'guiDeckReview', { name: deck }))) throw new Error(`no deck «${deck}»`)
  await update($, reviewDeck, () => deck)
  await update($, reviewedCount, () => 0)
  await loadCurrentCard($)
}

async function stopReview($: $): Promise<void> {
  await update($, review, () => null)
  await update($, reviewDeck, () => null)
  await anki($, 'guiDeckBrowser').catch(() => undefined)
  await refreshDecks($)
}

async function answerCard($: $, cardId: number, ease: number): Promise<void> {
  // A press drawn for a card already graded grades nothing.
  if ((await currentCard($))?.cardId !== cardId) return
  // Grade only the card Anki's reviewer shows; if it moved on (a click in
  // Anki's own window), show that one instead.
  const shown = await anki<CardInfo>($, 'guiCurrentCard').catch(() => null)
  if (shown?.cardId !== cardId) {
    $.ui.toast((await words($)).cardChanged)
    await loadCurrentCard($)
    return
  }
  await anki($, 'guiShowAnswer')
  if (!(await anki<boolean>($, 'guiAnswerCard', { ease }))) throw new Error('Anki did not take the grade')
  await update($, reviewedCount, n => (n ?? 0) + 1)
  await loadCurrentCard($)
  $.clock.after(0, () => void refreshDecks($))
}

const PREFERRED_MODELS = ['Basic', 'Простая', 'Основная', 'Базовая']

type NewCard = { front: string; back: string }

async function addCards($: $, deck: string, cards: NewCard[], tags: string[]): Promise<string> {
  await anki($, 'createDeck', { deck })
  const models = await anki<string[]>($, 'modelNames')
  const model = PREFERRED_MODELS.find(name => models.includes(name)) ?? models[0]
  const fields = await anki<string[]>($, 'modelFieldNames', { modelName: model })
  const [frontField, backField] = fields
  if (frontField === undefined || backField === undefined) {
    throw new Error(`note type "${model}" has fewer than two fields`)
  }

  const done: string[] = []
  const failed: string[] = []
  for (const card of cards) {
    try {
      await anki($, 'addNote', {
        note: {
          deckName: deck,
          modelName: model,
          fields: { [frontField]: textToHtml(card.front), [backField]: textToHtml(card.back) },
          tags: ['claude', ...tags],
          options: { allowDuplicate: false },
        },
      })
      done.push(card.front)
    } catch (error) {
      failed.push(`${card.front}: ${reasonOf(error)}`)
    }
  }
  await update($, added, list => [...done.map(front => `${deck} · ${front}`), ...(list ?? [])].slice(0, 20))
  await refreshDecks($)
  if (done.length > 0) $.ui.toast((await words($)).added(done.length, deck))

  return [
    `Added ${done.length} of ${cards.length} cards to "${deck}" (note type "${model}", tag "claude").`,
    ...failed.map(line => `Not added: ${line}`),
  ].join('\n')
}

async function openPane($: $): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Anki' })
  await refreshDecks($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'anki', description: 'Open the Anki pane' })
    await $.tool.register({
      name: 'decks',
      description:
        'Lists the Anki decks of the running Anki app (through AnkiConnect) with their new, learning and due counts.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'add_cards',
      description:
        'Adds front/back flashcards to an Anki deck in the running Anki app (through AnkiConnect). ' +
        'Creates the deck when it does not exist. Plain text; newlines are kept.',
      inputSchema: {
        type: 'object',
        properties: {
          deck: { type: 'string', description: 'Deck name; "Parent::Child" for a subdeck' },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: { front: { type: 'string' }, back: { type: 'string' } },
              required: ['front', 'back'],
            },
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['deck', 'cards'],
      },
      isDeferred: false,
    })
    const saved = await $.store.get('language').catch(() => undefined)
    if (isLanguage(saved) && saved !== (await read($, language))) await update($, language, () => saved)
    $.clock.every(POLL_MS, async () => {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (isOpen && (await read($, reviewDeck)) === null) await refreshDecks($)
    })

    return next(e)
  })

  // `/anki en` or `/anki ru` also sets the language the pane speaks.
  on('command.run', { command: 'anki' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    if (isLanguage(asked)) await setLanguage($, asked)
    await openPane($)

    return { text: isLanguage(asked) ? `Anki pane opened (${asked}).` : 'Anki pane opened.' }
  })

  on('tool.call', { tool: 'mcp__anki__decks' }, async $ => {
    await refreshDecks($)
    const state = await read($, connection)
    if (state.kind !== 'ok') {
      return { deny: `Anki is not reachable (${state.kind === 'offline' ? state.reason : 'unknown'}). Is Anki open with AnkiConnect installed?` }
    }
    const list = await read($, decks)

    return {
      result: list
        .map(d => `${d.name}: ${d.newCount} new, ${d.learnCount} learning, ${d.reviewCount} due, ${d.total} total`)
        .join('\n'),
    }
  }).catch(() => ({ deny: 'The anki mod failed while listing the decks.' }))

  on('tool.call', { tool: 'mcp__anki__add_cards' }, async ($, e) => {
    const input = e as unknown as { deck?: string; cards?: NewCard[]; tags?: string[] }
    if (!input.deck || !Array.isArray(input.cards) || input.cards.length === 0) {
      return { deny: 'add_cards needs a deck and at least one card.' }
    }
    try {
      return { result: await addCards($, input.deck, input.cards, input.tags ?? []) }
    } catch (error) {
      return { deny: `Anki is not reachable or refused the cards: ${reasonOf(error)}` }
    }
  }).catch(() => ({ deny: 'The anki mod failed while adding the cards.' }))

  on('ui.focus', async ($, e, next) => {
    // The terminal moves focus with Tab, which is no click.
    if (drawnOn === 'desktop' && e.requestId === PANE && e.origin.kind === 'person' && e.element !== undefined) {
      if (isUnfocusedSettled && actions.has(e.element)) runSwallowedClick($, e.element)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    actions.clear()
    drawnOn = e.surface
    const drawn = ++drawnCount
    isUnfocusedSettled = false
    if (!e.props.isFocused) {
      $.clock.after(SETTLED_MS, () => {
        if (drawn === drawnCount) isUnfocusedSettled = true
      })
    }
    const state = await read($, connection)
    const lang = await read($, language)
    const w = WORDS[lang]

    if (state.kind === 'unknown') return <Text dimColor>{w.connecting}</Text>

    if (state.kind === 'offline') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{w.offline}</Text>
          <Text dimColor>{w.offlineHelp(ANKICONNECT_CODE)}</Text>
          <Text dimColor>{state.reason}</Text>
          <Box>
            <Button {...bind('retry', () => act($, () => refreshDecks($)))} variant="primary">
              {w.retry}
            </Button>
          </Box>
        </Box>
      )
    }

    const card = await currentCard($)
    if (card !== null) {
      const count = await read($, reviewedCount)
      const media = await read($, images)
      const table = $.ui.resolve(e)
      const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
      const Input = 'Input' in table ? table.Input : undefined
      const Markdown = 'Markdown' in table ? table.Markdown : undefined
      const hasTypeField = card.question.some(part => part.kind === 'type')
      const isBusy = await read($, busy)
      // Keys reach a pane in the terminal only; the desktop app keeps them for the prompt.
      const hotkey = (key: string) => (e.surface === 'terminal' ? { hotkey: key } : {})

      const drawImage = (file: string) => {
        const image = media[file]
        if (image === undefined) return <Text dimColor>{w.loadingImage}</Text>
        if ('missing' in image || Svg === undefined) {
          // A reason kept from an older version is drawn as it was kept.
          const reason =
            'missing' in image
              ? `: ${w.missing[image.missing] ?? String(image.missing)}${image.reason === undefined ? '' : ` (${image.reason})`}`
              : ''
          return <Text dimColor>{`🖼 ${file}${reason}`}</Text>
        }
        const width = Math.min(image.width, 320)

        return <Svg source={image.svg} alt={file} width={width} height={Math.round((image.height * width) / image.width)} />
      }

      const drawText = (text: string) =>
        Markdown !== undefined && text.length <= SHORT && !text.includes('\n') ? (
          <Markdown text={`## ${markdownEscape(text)}`} />
        ) : (
          <Text>{text}</Text>
        )

      const drawType = (expected: string, side: 'q' | 'a') => {
        if (side === 'q') {
          if (Input === undefined) return <Text dimColor>{w.answerField}</Text>

          return (
            <Box width="100%">
              <Input
                key="typed"
                placeholder={w.yourAnswer}
                submitLabel={w.check}
                autoFocus
                onInput={value => {
                  draft = value
                }}
                onSubmit={value => act($, () => showAnswer($, value))}
              />
            </Box>
          )
        }
        const typed = (card.typed ?? '').trim()
        if (typed === '') return drawText(expected)
        const drawRuns = (runs: Run[]) => (
          <Box flexDirection="row" flexWrap="wrap">
            {runs.map(run => (
              <Text bold color="black" backgroundColor={RUN_BACKGROUND[run.kind]}>
                {run.text}
              </Text>
            ))}
          </Box>
        )
        // Right: the answer alone, all good. Wrong: what was typed, ↓, the answer.
        if (typed.normalize('NFC') === expected.trim().normalize('NFC')) return drawRuns([{ kind: 'good', text: expected }])
        const runs = compareTyped(typed, expected.trim())

        return (
          <Box flexDirection="column" alignItems="center">
            {drawRuns(runs.typed)}
            <Text>↓</Text>
            {drawRuns(runs.expected)}
          </Box>
        )
      }

      const drawParts = (parts: CardPart[], side: 'q' | 'a') =>
        parts.map(part => {
          if (part.kind === 'text') return drawText(part.text)
          if (part.kind === 'image') return drawImage(part.file)
          if (part.kind === 'type') return drawType(part.expected, side)

          return (
            <Button {...bind(`${side}-sound:${part.file}`, () => playLater($, [part.file]))} plain dimColor>
              🔊
            </Button>
          )
        })

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Button {...bind('home', () => act($, () => stopReview($)))} plain dimColor>
              {w.backToDecks}
            </Button>
            <Text dimColor wrap="truncate-end">
              {card.deck} · {isBusy ? '…' : String(count)}
            </Text>
          </Box>
          <Box flexDirection="column" alignItems="center" gap={1} borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
            {drawParts(card.isAnswerShown ? card.answer : card.question, card.isAnswerShown ? 'a' : 'q')}
          </Box>
          <Box flexDirection="row" justifyContent="center" alignItems="flex-end" gap={2} flexWrap="wrap">
            {card.isAnswerShown ? (
              card.grades.map(({ ease, next }) => {
                const grade = gradeOf(ease, card.grades.length, w)

                // As Anki draws them: the interval a grade sets, above its button.
                return (
                  <Box key={`grade:${grade.key}`} flexDirection="column" alignItems="center">
                    <Text dimColor>{next ?? ''}</Text>
                    <Button {...bind(grade.key, () => act($, () => answerCard($, card.cardId, ease)))} {...hotkey(String(ease))}>
                      {grade.label}
                    </Button>
                  </Box>
                )
              })
            ) : hasTypeField ? (
              <Button {...bind('main', () => act($, () => showAnswer($, draft)))} variant="primary">
                {w.showAnswer}
              </Button>
            ) : (
              <Button {...bind('main', () => act($, () => showAnswer($, null)))} {...hotkey('s')} variant="primary">
                {w.showAnswer}
              </Button>
            )}
          </Box>
        </Box>
      )
    }

    const list = await read($, decks)
    const recent = await read($, added)
    const studied = await read($, today)
    // Each count sits in a cell of its own width, so the letters above line up.
    const cell = (key: string, text: JSX.Element) => (
      <Box key={key} width={COUNT_CELL} flexDirection="row" justifyContent="flex-end">
        {text}
      </Box>
    )
    const count = (value: number, kind: keyof typeof COUNT_COLOR) =>
      cell(kind, <Text color={COUNT_COLOR[kind]}>{value}</Text>)
    const heading = (letter: string, kind: keyof typeof COUNT_COLOR) =>
      cell(kind, <Text bold color={COUNT_COLOR[kind]}>{letter}</Text>)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold>{w.decks}</Text>
          <Box flexDirection="row" gap={2}>
            <Button {...bind('language', () => act($, () => setLanguage($, lang === 'en' ? 'ru' : 'en')))} plain dimColor>
              {w.switchTo}
            </Button>
            <Button
              {...bind('home', () =>
                act($, async () => {
                  await refreshDecks($)
                  $.ui.toast((await words($)).refreshed)
                }),
              )}
              plain
              dimColor
            >
              {w.refresh}
            </Button>
          </Box>
        </Box>
        {list.length === 0 && <Text dimColor>{w.noDecks}</Text>}
        <Box flexDirection="column">
          {list.length > 0 && (
            <Box key="counts" flexDirection="row" justifyContent="flex-end">
              <Box flexDirection="row" gap={1}>
                {heading(w.headings.new, 'new')}
                {heading(w.headings.learn, 'learn')}
                {heading(w.headings.review, 'review')}
              </Box>
            </Box>
          )}
          {list.map(deck => {
            const path = deck.name.split('::')
            const isDue = deck.newCount + deck.learnCount + deck.reviewCount > 0

            return (
              <Box
                key={`row:${deck.name}`}
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
                paddingLeft={(path.length - 1) * 2}
              >
                <Button
                  {...bind(`deck:${deck.name}`, () => act($, () => startReview($, deck.name)))}
                  plain
                  {...(isDue ? {} : { dimColor: true })}
                >
                  {path[path.length - 1] ?? deck.name}
                </Button>
                <Box flexDirection="row" gap={1}>
                  {count(deck.newCount, 'new')}
                  {count(deck.learnCount, 'learn')}
                  {count(deck.reviewCount, 'review')}
                </Box>
              </Box>
            )
          })}
        </Box>
        {studied !== null && list.length > 0 && (
          <Box flexDirection="row" justifyContent="center">
            <Text>{w.today(studied)}</Text>
          </Box>
        )}
        {recent.length > 0 && (
          <Box flexDirection="column">
            <Text bold>{w.addedByClaude}</Text>
            {recent.map(line => (
              <Text dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
