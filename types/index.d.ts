export type AnkiDeck = {
  name: string
  newCount: number
  learnCount: number
  reviewCount: number
  total: number
}

// A rendered card side, cut into what the pane draws one by one.
export type CardPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; file: string }
  | { kind: 'sound'; file: string }
  | { kind: 'type'; expected: string }

export type AnkiCard = {
  cardId: number
  deck: string
  question: CardPart[]
  answer: CardPart[]
  // The grades Anki offers for this card, with the interval each one sets.
  grades: { ease: number; next: string }[]
  typed: string | null
  isAnswerShown: boolean
}

// A media file drawn as an SVG holding it, or why it is not drawn.
export type AnkiImage = { svg: string; width: number; height: number } | { missing: string }

// What was studied today, across every deck.
export type AnkiToday = { cards: number; seconds: number }

export type AnkiConnection =
  | { kind: 'unknown' }
  | { kind: 'ok' }
  | { kind: 'offline'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    anki: {
      connection: AnkiConnection
      decks: AnkiDeck[]
      review: AnkiCard | null
      images: Record<string, AnkiImage>
      reviewDeck: string | null
      reviewedCount: number
      busy: boolean
      added: string[]
      today: AnkiToday | null
    }
  }
}
