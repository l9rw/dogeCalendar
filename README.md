# dogeCalendar

A lightweight cross-platform desktop calendar built with Tauri 2, React and TypeScript.

[简体中文](./README.zh-CN.md)

The app provides a calendar panel opened from the Windows taskbar clock or macOS menu bar. It includes a month view, Chinese lunar dates, holiday labels, world clocks, weather, and a date-detail panel. It is still a prototype; some calendar data is approximate or incomplete.

## Current status

Implemented:

- Tauri 2 desktop panels opened from the Windows taskbar clock or macOS menu bar icon
- Fixed 7-column × 6-row month grid with month/year selection and a Today shortcut
- Date selection and a separate detail panel with online Chinese almanac data
- Current date highlight
- Lunar dates via the browser's Chinese calendar, approximate solar-term dates, and built-in holiday labels and limited 2026 rest/workday overrides
- Searchable world clocks with 12/24-hour display and saved city choices
- Current weather from Open-Meteo, IP-based location fallback, manual coordinates, and a clearable weather cache
- System, light, and dark themes; settings panel and macOS menu bar icon styles
- Hide the panel on close instead of quitting the app
- Transparent, frameless window with skip-taskbar configuration
- Responsive layout for small screens and mobile widths

Planned:

- Year view
- Complete validated lunar, solar-term, and annual statutory holiday/adjusted-workday data
- User holiday overrides and events
- SQLite storage (current settings and caches use a local JSON file)
- Autostart, system calendar, notifications and cloud sync

## Tech stack

- [Tauri 2](https://tauri.app/) — desktop shell, window and system tray
- [React 19](https://react.dev/) — user interface
- [TypeScript](https://www.typescriptlang.org/) — type-safe frontend development
- [Vite](https://vite.dev/) — dev server and frontend build
- [Rust](https://www.rust-lang.org/) — Tauri native layer
- [Zustand](https://zustand.docs.pmnd.rs/) — frontend state for world clocks, location and weather

## Prerequisites

Before developing the Tauri desktop app, prepare:

- Node.js 20.19+ or 22.12+ (required by Vite 7)
- npm
- Rust stable toolchain
- Tauri 2 system development dependencies

A Windows dev environment also typically requires:

- Microsoft Visual Studio Build Tools, with the C++ desktop development workload
- WebView2 Runtime

A macOS desktop dev environment also requires:

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

### macOS desktop development

1. Install Xcode Command Line Tools (full Xcode is not needed for macOS desktop development):

   ```bash
   xcode-select --install
   xcode-select -p
   ```

2. Install Node.js 20.19+ (20.x) or 22.12+, npm, and Rust stable. This example uses [Homebrew](https://brew.sh/); skip installation commands for tools you already have. Homebrew's `rustup` requires its binaries on `PATH` (`brew --prefix` works on both Apple Silicon and Intel Macs):

   ```bash
   brew install node rustup
   export PATH="$(brew --prefix rustup)/bin:$PATH"
   rustup default stable
   node --version
   npm --version
   rustc --version
   cargo --version
   ```

   Add the `export PATH=...` line above to `~/.zshrc` to make Rust available in new terminals, then open a new terminal. If Rust is already installed through another method, just verify that `rustc` and `cargo` are available.

3. From the project root, install dependencies and launch the native app:

   ```bash
   npm install
   npm run tauri:dev
   ```

The main window starts hidden. Use the macOS **menu bar status icon** (not the window's title-bar controls): left-click to toggle the calendar panel beneath the icon; clicking outside dismisses it. Right-click to open the app's context menu, including Settings and Quit. The app has no Dock icon, so quit through the app menu or press `Ctrl+C` in the dev terminal. Browser-only `npm run dev` does not provide a menu bar icon.

The Tauri dev URL is `http://localhost:1420`. Run `npm run tauri:build` to bundle the macOS app. This project enables `macOSPrivateApi` for transparent windows; builds using this private API cannot be submitted to the Mac App Store.

### Other desktop platforms

After installing the platform prerequisites, start dev mode with the native window:

```bash
npm run tauri:dev
```

The main window starts hidden in dev mode. On Windows, click the taskbar clock to toggle it, or right-click for the app's context menu.

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
dogeCalendar/
├── src/
│   ├── App.tsx               # Calendar, settings and date-detail UI
│   ├── components/           # Weather and world clock panels
│   ├── services/             # Calendar data and Tauri IPC
│   ├── stores/               # Frontend information state
│   ├── main.tsx              # React entry
│   └── styles/
│       └── tokens.css        # Theme tokens, layout and responsive styles
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs             # Tauri app and platform window behavior
│   │   ├── commands/         # IPC commands
│   │   ├── providers/        # Network providers
│   │   ├── services/         # Storage, weather, location and time
│   │   └── main.rs           # Native app entry
│   ├── capabilities/         # Tauri permission config
│   ├── icons/                 # App icons
│   ├── Cargo.toml             # Rust dependencies and crate config
│   └── tauri.conf.json        # Window, build and packaging config
├── index.html
├── package.json
└── vite.config.ts
```

## Current interactions

- Click a date cell to open its detail panel and jump to its month.
- Use the arrows or month/year selectors to navigate; the Today button returns to the current date.
- Open the world clock from the More menu. Set theme, location and weather options in Settings.
- Closing the panel hides it; reopen it with the Windows taskbar clock or macOS menu bar icon.

## Architecture direction

The UI is centered in `src/App.tsx`, with calendar data in `src/services/calendarData.ts` and native window behavior in `src-tauri/src/lib.rs`. Other services are split as follows:

```text
React UI
  -> Zustand stores / Tauri IPC
Rust application services
  -> world time / weather / location / JSON storage
Platform adapters
  -> Windows tray + popup positioning
  -> macOS NSStatusItem + NSPanel positioning
```

World clocks, weather, location, caching and external requests use the Rust layer; calendar labels are currently calculated in the frontend. Platform-specific window behavior lives in the native layer.

## Privacy and data notes

Opening date details requests almanac data for the selected date from `60s.viki.moe` (or `60s.7se.cn` as a fallback). The weather panel requests IP-based location from `ipwho.is`, `ipinfo.io` or `freeipapi.com`, then sends coordinates to Open-Meteo for current weather. These are third-party services; the IP-based location providers receive your IP address as part of the request. Setting manual coordinates avoids the IP-location lookup while using the saved location, but weather requests still send coordinates to Open-Meteo. The app saves location, weather cache and world clock preferences in a JSON file in the platform's app-data directory. Settings can clear the saved location and weather cache. No account or cloud sync is implemented.

## License

This project is licensed under the [Apache License 2.0](./LICENSE). You may use, modify and distribute it under the terms of that license; see `LICENSE` for the full text and redistribution requirements.
