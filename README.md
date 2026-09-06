# SIH26

A browser AI agent that understands the current page locally, filters sensitive information before sending context to a server AI, and validates browser actions before executing them.

**Status:** Architecture and documentation only. Application folders contain empty `.gitkeep` placeholders so Git can track them. No application code, dependencies, or runnable setup exists yet.

## Project structure

```text
SIH26/
├── extension/
│   └── src/
│       ├── ui/           # Side panel, task input, previews, approval
│       ├── background/   # Extension coordination and server communication
│       ├── capture/      # Local screenshot capture
│       ├── dom/          # Page structure, labels, element references
│       ├── vision/       # Local vision and OCR workers
│       ├── privacy/      # Detection, redaction, local value references
│       ├── agent/        # Task loop, validation, execution, result checks
│       └── metrics/      # Timings and resource measurements
├── server/
│   ├── api/              # Request endpoints
│   ├── agent/            # Server reasoning and action planning
│   ├── models/           # Model loading and inference adapters
│   ├── schemas/          # Request and action definitions
│   └── utils/            # Small shared server helpers
├── tests/
│   └── fixtures/         # Synthetic pages and data for tests and demos
└── docs/
    ├── architecture.md
    ├── development.md
    └── privacy.md
```

## Start here

- [Architecture](docs/architecture.md): components, data flow, and stack.
- [Development](docs/development.md): milestones, scope, and verification.
- [Privacy](docs/privacy.md): information-sharing and action rules.

The first target is one complete workflow on a synthetic application portal, including local visual processing, a sanitized server request, and confirmed submission.

Problem reference: [Official SIH 2026 statements](https://sih.gov.in/sih2026PS), entry SIH26171, “On-device Visual Perception for Light-weight Browser Agents.”
