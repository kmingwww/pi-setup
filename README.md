# pi-setup

Personal [pi](https://github.com/earendil-works/pi-coding-agent) configuration package with two extensions: an interactive TUI question tool and a desktop/terminal notification system.

## Extensions

- **[ask_user_question](docs/ask-user-question.md)** — TUI tool for structured multiple-choice prompts with write-in
- **[notify](docs/notify.md)** — Desktop & terminal notifications when the agent is idle and waiting for input

## Project structure

```
├── extensions/
│   ├── ask-user-question.ts     # TUI question tool extension
│   └── notify.ts                # Notification extension
├── docs/
│   ├── ask-user-question.md     # Ask tool documentation
│   └── notify.md                # Notify extension documentation
├── tests/
│   ├── ask-user-question.test.ts
│   └── notify.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Usage

Install as a pi package from this repo, or clone and register locally. The `package.json` declares extensions under `pi.extensions` so pi auto-discovers them:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type-check
npx tsc --noEmit
```

Tests use [Vitest](https://vitest.dev/) with mocked pi-tui components and child_process calls — no actual TUI or system binaries needed.

## License

MIT
