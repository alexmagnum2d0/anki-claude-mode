import type { AnkiLanguage, AnkiToday, MissingImage } from '../types'

// Every word the pane shows, in each language it speaks. What Claude reads
// (tool descriptions and results) stays English.
export type Words = {
  connecting: string
  offline: string
  offlineHelp: (code: string) => string
  retry: string
  decks: string
  noDecks: string
  refresh: string
  refreshed: string
  // The letters above the count columns, as Anki colors them.
  headings: { new: string; learn: string; review: string }
  addedByClaude: string
  backToDecks: string
  showAnswer: string
  yourAnswer: string
  check: string
  answerField: string
  loadingImage: string
  missing: Record<MissingImage, string>
  grades: { again: string; hard: string; main: string; easy: string }
  soundFailed: (reason: string) => string
  deckDone: (deck: string) => string
  nothingDue: (deck: string) => string
  cardChanged: string
  added: (count: number, deck: string) => string
  today: (value: AnkiToday) => string
  // The button that switches to the other language, named in that language.
  switchTo: string
}

// The Russian plural form for a whole count: 1 карточка, 2 карточки, 5 карточек.
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  if (units >= 2 && units <= 4) return few
  return many
}

const fixed = (value: number) => value.toFixed(2)

export const WORDS: Record<AnkiLanguage, Words> = {
  en: {
    connecting: 'Connecting to Anki…',
    offline: 'Anki is not responding',
    offlineHelp: code =>
      `Open Anki. If it is already open, install the AnkiConnect add-on: Tools → Add-ons → Get Add-ons…, code ${code}, then restart Anki.`,
    retry: 'Check again',
    decks: 'Decks',
    noDecks: 'No decks.',
    refresh: '↻ Refresh',
    refreshed: 'Anki: decks refreshed',
    headings: { new: 'N', learn: 'L', review: 'D' },
    addedByClaude: 'Added by Claude',
    backToDecks: '← Decks',
    showAnswer: 'Show answer',
    yourAnswer: 'Your answer',
    check: 'Check',
    answerField: '[answer field]',
    loadingImage: '🖼 loading…',
    missing: { 'not-image': 'not an image', 'no-file': 'no such file', 'too-large': 'too large for the pane', unreadable: 'could not be read' },
    grades: { again: 'Again', hard: 'Hard', main: 'Good', easy: 'Easy' },
    soundFailed: reason => `Anki: the sound did not play: ${reason}`,
    deckDone: deck => `Anki: you have finished “${deck}” for now`,
    nothingDue: deck => `Anki: nothing to study in “${deck}” right now`,
    cardChanged: 'Anki: the card in Anki changed, showing the current one',
    added: (count, deck) => `Anki: added ${count} to “${deck}”`,
    // Worded as Anki words it: "Studied 17 cards in 2.43 minutes today (8.56s/card)".
    today: ({ cards, seconds }) =>
      cards === 0
        ? 'No cards have been studied today.'
        : `Studied ${cards} ${cards === 1 ? 'card' : 'cards'} in ${fixed(seconds / 60)} minutes today (${fixed(seconds / cards)}s/card)`,
    switchTo: 'Русский',
  },
  ru: {
    connecting: 'Подключаюсь к Anki…',
    offline: 'Anki не отвечает',
    offlineHelp: code =>
      `Откройте Anki. Если он уже открыт, установите аддон AnkiConnect: Инструменты → Дополнения → Получить дополнения, код ${code}, затем перезапустите Anki.`,
    retry: 'Проверить снова',
    decks: 'Колоды',
    noDecks: 'Колод нет.',
    refresh: '↻ Обновить',
    refreshed: 'Anki: колоды обновлены',
    headings: { new: 'Н', learn: 'И', review: 'П' },
    addedByClaude: 'Добавлено Claude',
    backToDecks: '← Колоды',
    showAnswer: 'Показать ответ',
    yourAnswer: 'Ваш ответ',
    check: 'Проверить',
    answerField: '[поле для ответа]',
    loadingImage: '🖼 загружаю…',
    missing: { 'not-image': 'не картинка', 'no-file': 'файла нет', 'too-large': 'слишком большая для панели', unreadable: 'не читается' },
    grades: { again: 'Снова', hard: 'Трудно', main: 'Хорошо', easy: 'Легко' },
    soundFailed: reason => `Anki: звук не играет: ${reason}`,
    deckDone: deck => `Anki: в колоде «${deck}» на сегодня всё`,
    nothingDue: deck => `Anki: в колоде «${deck}» сейчас нечего повторять`,
    cardChanged: 'Anki: карточка в Anki сменилась, показываю текущую',
    added: (count, deck) => `Anki: добавлено ${count} в «${deck}»`,
    // Worded as Anki words it: «Сегодня 17 карточек за 2,43 минут (8,56 с/карт.)».
    today: ({ cards, seconds }) =>
      cards === 0
        ? 'Сегодня не было изучено ни одной карточки.'
        : `Сегодня ${cards} ${plural(cards, 'карточка', 'карточки', 'карточек')} за ${fixed(seconds / 60).replace('.', ',')} минут (${fixed(seconds / cards).replace('.', ',')} с/карт.)`,
    switchTo: 'English',
  },
}

export function isLanguage(value: unknown): value is AnkiLanguage {
  return value === 'en' || value === 'ru'
}
