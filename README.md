# Calendar

A lightweight cross-platform desktop calendar built with Tauri 2, React and TypeScript.

[简体中文](./README.zh-CN.md)

The goal is a calendar panel suited to the Windows system tray or the macOS menu bar, supporting month view, year view, the Chinese lunar calendar, the twenty-four solar terms, statutory holidays and adjusted rest days, world time, and weather capabilities. The repository is currently in an early prototype iteration: a basic month view and tray interaction are in place, and additional domain data and platform capabilities are being integrated incrementally.

## Current status

Implemented:

- Tauri 2 desktop window and system tray icon
- Tray left-click to show/hide the calendar window
- Open calendar, settings and quit actions from the tray menu
- Fixed 7-column × 6-row month grid
- Previous month, next month and back to today
- Date selection and date detail panel
- Current date highlight
- Simple lunar text and solar-term placeholder display
- Follows the system light/dark theme, with a manual theme toggle
- Settings panel entry
- Hide to tray on window close instead of quitting the app
- Transparent, frameless window with skip-taskbar configuration
- Responsive layout for small screens and mobile widths

Planned:

- Year view
- Complete lunar calendar and leap-month calculation from 1900 to 2100
- Solar-term data
- Statutory holiday, adjusted rest and user override data
- World time, timezone lookup and sorting
- System location and a weather provider
- SQLite for settings, events and caching
- Windows tray positioning and macOS menu bar panel adaptation
- Autostart, system calendar, notifications and cloud sync

## Tech stack

- [Tauri 2](https://tauri.app/) — desktop shell, window and system tray
- [React 19](https://react.dev/) — user interface
- [TypeScript](https://www.typescriptlang.org/) — type-safe frontend development
- [Vite](https://vite.dev/) — dev server and frontend build
- [Rust](https://www.rust-lang.org/) — Tauri native layer
- [Zustand](https://zustand.docs.pmnd.rs/) — frontend state dependency, later used to extend cross-component state

## Prerequisites

Before developing the Tauri desktop app, prepare:

- Node.js 18 or higher
- npm
- Rust stable toolchain
- Tauri 2 system development dependencies

A Windows dev environment also typically requires:

- Microsoft Visual Studio Build Tools, with the C++ desktop development workload
- WebView2 Runtime

A macOS dev environment also typically requires:

- Xcode Command Line Tools

For the full set of platform dependencies, see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Install dependencies

```bash
npm install
```

## Development

### Browser preview

Start the Vite frontend dev server:

```bash
npm run dev
```

This is handy for quickly inspecting the React UI, but it does not launch the Tauri tray or native window behavior.

### Tauri desktop dev

Start dev mode with the native window and system tray:

```bash
npm run tauri:dev
```

The dev URL in the Tauri config is `http://localhost:1420`. In dev mode the main window is hidden by default and can be shown via the tray icon or the "Open calendar" item in the tray menu.

## Build

### Build the frontend

Run the TypeScript type check and produce Vite static assets:

```bash
npm run build
```

Output goes to `dist/`.

### Build the desktop installer

Build the Tauri desktop app and corresponding installers:

```bash
npm run tauri:build
```

Build artifacts are emitted to the Tauri bundle directory under `src-tauri/target/release/`. The exact format depends on the current OS and Tauri bundle config.

## Common scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite frontend dev server |
| `npm run build` | Type-check and build the frontend |
| `npm run preview` | Preview the built frontend assets |
| `npm run tauri:dev` | Start Tauri desktop dev mode |
| `npm run tauri:build` | Build the Tauri desktop installer |
| `npm run tauri` | Invoke the Tauri CLI directly |

## Project structure

```text
calendar/
├── src/
│   ├── App.tsx               # Current calendar main interface
│   ├── main.tsx              # React entry
│   └── styles/
│       └── tokens.css         # Theme tokens, layout and responsive styles
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs             # Tauri app, tray and window behavior
│   │   └── main.rs            # Native app entry
│   ├── capabilities/         # Tauri permission config
│   ├── icons/                 # App icons
│   ├── Cargo.toml             # Rust dependencies and crate config
│   └── tauri.conf.json        # Window, build and packaging config
├── index.html
├── package.json
└── vite.config.ts
```

## Current interactions

- Click a date cell to view date details and auto-jump to the corresponding month.
- Use the prev/next arrows to switch months.
- Click "Today" to return to the current date.
- Click the theme button in the top-right corner to switch light/dark mode.
- Click "Settings" to open the settings panel; the tray menu can also open settings.
- On window close the app hides to the system tray and can be reopened via the tray icon.

## Architecture direction

The current frontend prototype lives in `src/App.tsx`, and the native tray logic lives in `src-tauri/src/lib.rs`. It will be split into the following layers step by step:

```text
React UI
  -> Zustand stores / Tauri IPC
Rust application services
  -> calendar core / lunar / holiday / weather / location / storage
Platform adapters
  -> Windows tray + popup positioning
  -> macOS NSStatusItem + NSPanel positioning
```

Business calculations, data aggregation, caching and external requests will be placed in the Rust layer; the frontend is responsible for presentation and interaction; Windows and macOS system APIs are isolated through a platform adapter layer.

## Privacy and data notes

The current prototype does not include location, weather or remote holiday requests, and it does not actively collect user data. When network capabilities are added later, requests are planned to be initiated by Rust, with necessary API keys kept in the native layer, and options for location, weather and cache clearing provided.

## License

The project does not yet declare a formal open-source license.
