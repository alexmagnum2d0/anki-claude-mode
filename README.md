# anki-claude-mode

**English** · [Русский](README.ru.md)

A mod for [Claude Code](https://claude.com/claude-code): an Anki pane right inside Claude, in the desktop app and in the terminal. It talks to Anki through [AnkiConnect](https://ankiweb.net/shared/info/2055492159). The pane speaks English or Russian.

## What it does

- **Decks**: every deck with its subdecks and the N (new), L (learning) and D (due) counts in Anki's colors, with Anki's line under them: "Studied N cards in … minutes today (…s/card)".
- **Review**: cards look the way Anki shows them, with pictures, sound (🔊 buttons), the typed-answer field (`{{type:…}}`) checked letter by letter as Anki does, and the grade buttons with their intervals above them.
- **Cards from Claude**: Claude gets two tools:
  - `mcp__anki__decks` lists the decks and what is due in each;
  - `mcp__anki__add_cards` adds front/back cards to a deck. It creates the deck if it does not exist and tags the cards `claude`.

  For example: "make 20 cards on Serbian verbs of motion in the deck Serbian".

Review runs through Anki itself (its own reviewer), so the card order, intervals and history are the same as in a normal Anki session.

## Requirements

1. [Anki](https://apps.ankiweb.net/) on the same computer, running while you use the pane.
2. The AnkiConnect add-on: in Anki, Tools → Add-ons → Get Add-ons…, code `2055492159`, then restart Anki.
3. Claude Code.

## Install

In a Claude Code terminal session:

```
/plugin install anki --marketplace alexmagnum2d0/anki-claude-mode
```

Answer `y` to add the marketplace and pick a scope (user, for every session). Once installed, the mod also works in Code sessions in the Claude desktop app.

## Use

- `/anki` opens the pane.
- Click a deck to start reviewing; "← Decks" goes back.
- In the terminal, grade buttons also answer to keys 1–4. The desktop app keeps keys for the prompt, so there you use the buttons.

## Language

The pane starts in English. To switch, click "Русский" / "English" next to "Refresh" in the deck list, or run `/anki ru` or `/anki en`. The choice is kept across sessions.

The words live in [`hooks/words.ts`](hooks/words.ts), one block per language.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

To run the mod from this folder: `claude --plugin-dir /path/to/anki-claude-mode`.

## License

MIT
