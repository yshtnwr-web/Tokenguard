# Contributing to TokenGuard

Thank you for your interest in contributing! We welcome bug reports, feature suggestions, documentation improvements, and code contributions.

## How to Contribute

### 1. Report Bugs or Suggest Features
Open an issue on GitHub. Please include:
- A clear title and description.
- Steps to reproduce (for bugs).
- Expected vs actual behaviour.
- Screenshots or logs if relevant.

### 2. Submit Code Changes
- Fork the repository.
- Create a new branch from `main` (`git checkout -b feature/your-feature`).
- Make your changes, following the existing code style (no external linter yet, but keep it consistent).
- Test your changes with the mock provider (`node mock-provider.js` and `node index.js`).
- Commit with a clear message (e.g., `Add support for Gemini`).
- Push to your fork and open a Pull Request.

### 3. Improve Documentation
- Typos, clarifications, or new examples are always welcome.
- Edit `README.md` or add new `.md` files.

## Development Setup

1. Clone your fork.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set your credentials (optional – mock provider works without keys).
4. Run `node index.js` (and `node mock-provider.js` for testing).
5. Open `http://localhost:3000/dashboard` (login with your `.env` credentials).

## Code of Conduct

Be respectful and constructive. We aim to foster an open and welcoming community.

## Questions?

Open an issue or reach out via GitHub discussions (once enabled).