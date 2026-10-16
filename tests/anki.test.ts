import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { compareTyped, isCurrentCard, todayLine } from '../hooks/register'

const PANE = {
  plugin: 'anki',
  component: 'Pane',
  requestId: 'anki',
  props: {
    title: 'Anki',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type Call = { action: string; params: Record<string, unknown> }

type FakeCard = {
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

const GRADES = { buttons: [1, 2, 3, 4], nextReviews: ['<1m', '<6m', '<10m', '4d'] }

const SIMPLE_CARD: FakeCard = {
  cardId: 42,
  deckName: 'Spanish',
  modelName: 'Basic',
  template: 'Card 1',
  question: '<style>.card{}</style>perro',
  answer: '<style>.card{}</style>perro<hr id=answer>собака<br>dog',
  fields: { Front: { value: 'perro', order: 0 }, Back: { value: 'собака<br>dog', order: 1 } },
  ...GRADES,
}

// The shape of the person's own Serbian cards: picture, typed answer, sound.
const TYPED_CARD: FakeCard = {
  cardId: 43,
  deckName: 'Spanish',
  modelName: 'Word',
  template: 'Card 1',
  question: '<style>.card{}</style><img src="rice.png">\n\n[[type:Text]]',
  answer: '<style>.card{}</style>[[type:Text]]<br><br><img src="rice.png"><br><br>[anki:play:a:0]',
  fields: {
    Text: { value: 'pirinač', order: 0 },
    Image: { value: '<img src="rice.png">', order: 1 },
    Audio: { value: '[sound:rice.mp3]', order: 2 },
  },
  ...GRADES,
}

const TEMPLATES = { 'Card 1': { Front: '{{Image}}\n\n{{type:Text}}', Back: '{{type:Text}}<br>{{Image}}<br>{{Audio}}' } }

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const STATS = {
  '1': { name: 'Spanish', new_count: 5, learn_count: 1, review_count: 3, total_in_deck: 40 },
  '2': { name: 'Empty', new_count: 0, learn_count: 0, review_count: 0, total_in_deck: 12 },
}

// A revlog row as cardReviews answers it: id first, time taken eighth.
const row = (id: number, taken: number) => [id, 42, -1, 3, 1, 0, 2500, taken, 1]

// A fake AnkiConnect beneath the plugin: one deck, and Anki's own reviewer
// showing `queue` in order once the deck is opened for review.
function fakeAnki(calls: Call[], isOnline: boolean, queue: FakeCard[]) {
  let isReviewing = false
  return (e: { url: string; init?: { body?: string } }) => {
    if (!isOnline) throw new Error('connect ECONNREFUSED 127.0.0.1:8765')
    const call = JSON.parse(e.init?.body ?? '{}') as Call
    calls.push(call)
    const reply = (result: unknown, error: string | null = null) => ({
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ result, error }),
    })
    if (call.action === 'guiDeckReview') isReviewing = true
    if (call.action === 'guiDeckBrowser') isReviewing = false
    if (call.action === 'guiCurrentCard') {
      return isReviewing && queue[0] ? reply(queue[0]) : reply(null, 'Gui review is not currently active.')
    }
    if (call.action === 'guiAnswerCard') queue.shift()
    const results: Record<string, unknown> = {
      deckNames: ['Spanish', 'Empty'],
      getDeckStats: Object.fromEntries(
        Object.entries(STATS).filter(([, deck]) => ((call.params.decks as string[] | undefined) ?? []).includes(deck.name)),
      ),
      guiDeckReview: true,
      guiShowAnswer: true,
      guiAnswerCard: true,
      guiDeckBrowser: null,
      modelTemplates: TEMPLATES,
      retrieveMediaFile: call.params.filename === 'rice.png' ? PNG_1x1 : 'bXAz',
      createDeck: 7,
      modelNames: ['Cloze', 'Простая'],
      modelFieldNames: ['Лицевая сторона', 'Оборотная сторона'],
      addNote: 100,
      // Three reviews today; the oldest row is yesterday's and falls outside.
      getNumCardsReviewedToday: 3,
      multi: [
        { result: [row(1, 99000), row(3, 20000), row(4, 30000)], error: null },
        { result: [row(2, 10000)], error: null },
      ],
    }
    return reply(results[call.action])
  }
}

// What a session answers beneath the plugin: registrations, panes, toasts, time.
function boot(on: On, calls: Call[], isOnline = true, card = SIMPLE_CARD, played: string[] = [], focused: string[] = []) {
  const clock = mock.clock(on)
  const anki = fakeAnki(calls, isOnline, [card, { ...card, cardId: card.cardId + 100 }])
  on('http.fetch', ($, e) => {
    try {
      return { value: anki(e) }
    } catch (error) {
      return { deny: String(error) }
    }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__anki__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', ($, e) => {
    focused.push(e.element ?? '')
    // The kit's bottom answers `{ value }`, as for the registrations above.
    return { value: {} } as never
  })
  on('session.start', ($, e) => e)
  on('audio.play', ($, e) => {
    played.push(JSON.stringify(e))
    return { value: undefined }
  })

  // Presses hand their work to a timer; run the timers it leaves, and theirs.
  return async () => {
    for (let i = 0; i < 6; i++) await clock.advance(50)
  }
}

const START = { cwd: '/tmp', surface: 'desktop', isInteractive: true, source: 'startup' } as never

for (const surface of ['desktop', 'terminal'] as const) {
  test(`decks, review and answer on ${surface}`, async ($, on) => {
    const calls: Call[] = []
    const settle = boot(on, calls)
    await $.session.start(START)
    await $.command.run({ command: 'anki', args: '' } as never)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Spanish/ })).toBeDefined()

    await ui.press({ key: 'deck:Spanish' })

    await settle()
    expect(await ui.find({ type: 'Markdown', text: /perro/ })).toBeDefined()
    expect(await ui.find({ text: /собака/ })).toBeUndefined()

    await ui.press({ key: 'main' })

    await settle()
    expect(await ui.find({ text: /собака\ndog/ })).toBeDefined()
    // Each grade's interval sits above its button, as in Anki.
    expect(await ui.find({ type: 'Text', text: '4d' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /4d/ })).toBeUndefined()

    await ui.press({ key: 'main' })

    await settle()
    expect(calls.find(c => c.action === 'guiAnswerCard')?.params).toEqual({ ease: 3 })
    expect(await ui.find({ text: /Spanish · 1/ })).toBeDefined()
    expect(await ui.find({ key: 'main' })).toBeDefined()

    // The last card of the queue: the pane goes back to the decks.
    await ui.press({ key: 'main' })
    await settle()
    await ui.press({ key: 'main' })
    await settle()
    expect(await ui.find({ text: /Колоды/ })).toBeDefined()
    // Anki stays on its own "Congratulations" page.
    expect(calls.some(c => c.action === 'guiDeckBrowser')).toBe(false)
    await ui.unmount()
  })
}

test('add_cards uses the first two fields of the localized Basic type', async ($, on) => {
  const calls: Call[] = []
  boot(on, calls)
  await $.session.start(START)

  const ran = await $.tool.call({
    tool: 'mcp__anki__add_cards',
    deck: 'Spanish',
    cards: [{ front: 'gato <b>', back: 'кошка' }],
  } as never)

  expect(ran.deny).toBeUndefined()
  const note = calls.find(c => c.action === 'addNote')?.params.note as Record<string, unknown>
  expect(note.modelName).toBe('Простая')
  expect(note.fields).toEqual({ 'Лицевая сторона': 'gato &lt;b&gt;', 'Оборотная сторона': 'кошка' })
})

test('offline Anki shows how to install AnkiConnect', async ($, on) => {
  boot(on, [], false)
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /2055492159/ })).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()
})

test('a typed-answer card: picture, answer field, checked answer and sound', async ($, on) => {
  const played: string[] = []
  const settle = boot(on, [], true, TYPED_CARD, played)
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'deck:Spanish' })
  await settle()
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ text: /type:/ })).toBeUndefined()
  expect(played).toHaveLength(0)

  await ui.input({ key: 'typed', text: 'Pirinac' })

  await settle()
  // Pirinac against pirinač: P and c bad, irina good; p and č missed.
  expect(await ui.find({ type: 'Text', text: '↓' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: 'irina' })).length).toBe(2)
  expect(await ui.find({ type: 'Text', text: 'č' })).toBeDefined()
  expect(await ui.find({ text: /anki:play/ })).toBeUndefined()
  // Anki's own reviewer plays the side's sounds; the pane plays only on 🔊.
  expect(played).toHaveLength(0)

  await ui.press({ key: 'a-sound:rice.mp3' })
  await settle()
  expect(played).toHaveLength(1)
})

test('the terminal draws a picture as its name', async ($, on) => {
  const settle = boot(on, [], true, TYPED_CARD)
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'deck:Spanish' })
  await settle()
  expect(await ui.find({ text: /🖼 rice\.png/ }), JSON.stringify(await ui.drawn())).toBeDefined()
  await ui.input({ key: 'typed', text: 'pirinač' })
  await settle()
  expect(await ui.find({ type: 'Text', text: 'pirinač' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↓' })).toBeUndefined()
})

test('a card kept in the old shape across a reload is not drawn', () => {
  expect(isCurrentCard({ cardId: 1, deck: 'Spanish', question: 'perro', answer: 'собака', isAnswerShown: false })).toBe(false)
  expect(isCurrentCard(null)).toBe(false)
  expect(isCurrentCard({ cardId: 1, deck: 'S', question: [], answer: [], grades: [], typed: null, isAnswerShown: false })).toBe(true)
  expect(isCurrentCard({ cardId: 1, deck: 'S', question: [], answer: [], typed: null, isAnswerShown: false })).toBe(false)
})

test('number keys show on the terminal only', async ($, on) => {
  const settle = boot(on, [])
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'deck:Spanish' })
    await settle()
    await ui.press({ key: 'main' })
    await settle()
    const good = await ui.find({ key: 'main' })
    expect(good?.props.hotkey).toBe(surface === 'terminal' ? '3' : undefined)
    await ui.press({ key: 'home' })
    await settle()
    await ui.unmount()
  }
})

// The focus is parked on "home" before a press changes the view, so every view
// must draw it: otherwise the desktop spends the next click on refocusing.
test('every view draws the home button', async ($, on) => {
  const settle = boot(on, [])
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ key: 'home' })).toBeDefined()
  await ui.press({ key: 'deck:Spanish' })
  await settle()
  expect(await ui.find({ key: 'home' })).toBeDefined()
  await ui.press({ key: 'main' })
  await settle()
  expect(await ui.find({ key: 'home' })).toBeDefined()
  await ui.press({ key: 'main' })
  await settle()
  expect(await ui.find({ key: 'home' })).toBeDefined()
})

test('a typed answer is compared letter by letter, as Anki does', () => {
  expect(compareTyped('pirinac', 'pirinač12')).toEqual({
    typed: [
      { kind: 'good', text: 'pirina' },
      { kind: 'bad', text: 'c' },
    ],
    expected: [
      { kind: 'good', text: 'pirina' },
      { kind: 'missed', text: 'č12' },
    ],
  })
  expect(compareTyped('выаджл', 'pirinač12')).toEqual({
    typed: [{ kind: 'bad', text: 'выаджл' }],
    expected: [{ kind: 'missed', text: 'pirinač12' }],
  })
})

test('a deck with nothing to study leaves Anki where it is', async ($, on) => {
  const calls: Call[] = []
  const settle = boot(on, calls)
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ key: 'deck:Empty' })).toBeDefined()
  await ui.press({ key: 'deck:Empty' })
  await settle()
  expect(calls.some(c => c.action === 'guiDeckReview')).toBe(false)
  expect(await ui.find({ text: /Колоды/ })).toBeDefined()
})

// The desktop spends a click on a pane without the keyboard on focusing it:
// `ui.focus` names the button and no press follows. The pane runs it then.
test('a click that only focused the pane still presses the button', async ($, on) => {
  const calls: Call[] = []
  const settle = boot(on, calls)
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle()

  await $.ui.focus({ component: 'Pane', requestId: 'anki', plugin: 'anki', element: 'deck:Spanish', origin: { kind: 'person' } } as never)
  await settle()
  expect(calls.some(c => c.action === 'guiDeckReview')).toBe(true)
  expect(await ui.find({ type: 'Markdown', text: /perro/ })).toBeDefined()
})

test('a click on a focused pane presses once, not again through its focus', async ($, on) => {
  const calls: Call[] = []
  const settle = boot(on, calls)
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'deck:Spanish' })
  await $.ui.focus({ component: 'Pane', requestId: 'anki', plugin: 'anki', element: 'deck:Spanish', origin: { kind: 'person' } } as never)
  await settle()
  expect(calls.filter(c => c.action === 'guiDeckReview')).toHaveLength(1)
})

// Enter in the answer field removes it, and the desktop moves the keyboard to
// the first grade button with the person as origin. That is no click: grading
// the card "again" on it would be the pane answering for the person.
test('focus the host moves inside a focused pane presses nothing', async ($, on) => {
  const calls: Call[] = []
  const settle = boot(on, calls, true, TYPED_CARD)
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'desktop' })
  await settle()

  await ui.press({ key: 'deck:Spanish' })
  await settle()
  await ui.input({ key: 'typed', text: 'pirinač' })
  await settle()
  expect(await ui.find({ key: 'again' })).toBeDefined()
  await $.ui.focus({ component: 'Pane', requestId: 'anki', plugin: 'anki', element: 'again', origin: { kind: 'person' } } as never)
  await settle()
  expect(calls.some(c => c.action === 'guiAnswerCard')).toBe(false)
})

test('the deck counts carry Н, И and П above their columns', async ($, on) => {
  const settle = boot(on, [])
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle()
  for (const letter of ['Н', 'И', 'П']) expect(await ui.find({ type: 'Text', text: letter })).toBeDefined()
  expect(await ui.find({ text: /изучаемые/ })).toBeUndefined()
})

test('under the decks, what was studied today, worded as Anki words it', async ($, on) => {
  const settle = boot(on, [])
  await $.session.start(START)
  await $.command.run({ command: 'anki', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle()
  expect(await ui.find({ type: 'Text', text: 'Сегодня 3 карточки за 1,00 минут (20,00 с/карт.)' })).toBeDefined()

  expect(todayLine({ cards: 17, seconds: 145.513 })).toBe('Сегодня 17 карточек за 2,43 минут (8,56 с/карт.)')
  expect(todayLine({ cards: 21, seconds: 60 })).toMatch(/^Сегодня 21 карточка /)
  expect(todayLine({ cards: 0, seconds: 0 })).toBe('Сегодня не было изучено ни одной карточки.')
})
