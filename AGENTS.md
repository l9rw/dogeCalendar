# dogeCalendar 开发指南

本指南适用于整个仓库。dogeCalendar 是基于 Tauri 2、Rust、React 19、TypeScript、Vite 7 和 Zustand 5 的桌面日历应用，主要维护 Windows 与 macOS 两端。

**公共 UI 改动必须同时考虑 Windows 和 macOS 的体验。不能因为开发机器只运行其中一个平台，就把另一端视为不受影响。共享功能保持一致，平台专属行为保留各自的系统习惯。**

## 基础架构

```text
React UI（main / detail / clock 各自独立的 WebView）
  -> Zustand 状态 / Tauri invoke 与事件
Rust commands
  -> services（天气、定位、世界时间、JSON 存储）
  -> providers（第三方网络数据源）
原生平台适配
  -> Windows：任务栏时钟、鼠标钩子、UI Automation、窗口定位
  -> macOS：菜单栏图标、AppKit 窗口、Space、原生背景材质
```

### 前端职责

| 路径 | 职责 |
| --- | --- |
| `src/main.tsx` | React 入口，首次渲染前应用主题，设置 `data-platform`，查询 macOS 原生玻璃能力 |
| `src/App.tsx` | 主日历、日期详情、世界时钟入口，月份导航、键盘和滚轮交互、原生事件订阅 |
| `src/components/` | 设置、天气、世界时钟等共享组件 |
| `src/stores/settingsStore.ts` | 主题、颜色、透明度、语言、日历及更新偏好；使用 `localStorage` 持久化 |
| `src/stores/infoStore.ts` | 天气、定位、世界时钟状态及异步 IPC 调用 |
| `src/services/ipc.ts` | 共享业务 IPC 封装与 TypeScript 数据类型；部分窗口及平台命令仍由组件直接调用 |
| `src/services/calendarData.ts` | 本地日期键、农历显示、节日及休/班标记；缺少内置年份时请求远程节假日数据 |
| `src/services/huangli.ts` | 使用 `lunar-typescript` 本地计算黄历，详情面板按需加载 |
| `src/data/` | 中英文文案、颜色及年度节假日覆盖数据 |
| `src/styles/tokens.css` | 共享设计令牌、布局、响应式样式、平台及原生玻璃样式覆盖 |

主窗口和辅助窗口加载同一前端，通过 URL 参数 `?panel=detail&date=...`、`?panel=clock` 选择界面。它们不是同一 React 树，各 WebView 的 Zustand 内存独立；不能假设主窗口修改的组件状态会自动同步到辅助窗口。

设置通过 `localStorage` 及 `storage`、`visibilitychange`、`focus` 事件在窗口间重新读取。日期详情复用已有窗口时，通过 `detail-date-changed` 事件更新日期。新增跨窗口状态时，应沿用明确的持久化或事件同步机制。

### 原生层职责

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/main.rs` | 调用库入口 `run()` |
| `src-tauri/src/lib.rs` | Tauri 初始化、命令注册、窗口创建/显示/隐藏、原生菜单和平台行为分发 |
| `src-tauri/src/commands/` | 世界时间、定位、天气、自启动及更新等 IPC 命令 |
| `src-tauri/src/state.rs`、`domain/` | 共享应用状态和可序列化数据模型 |
| `src-tauri/src/services/` | 业务逻辑、缓存及本地存储 |
| `src-tauri/src/providers/` | IP 定位、Open-Meteo 天气及地名查询等网络请求 |
| `src-tauri/src/taskbar_clock.rs`、`clock_hover.rs`、`date_format.rs` | Windows 专属任务栏识别、鼠标覆盖层及系统日期/时间格式 |
| `src-tauri/tauri.conf.json`、`capabilities/` | 窗口、构建、打包、CSP 及 WebView 权限配置 |

天气、IP/手动定位和世界时间主要由 Rust 处理；日历标记与黄历在前端处理。不要笼统假定所有网络请求都经过 Rust，`calendarData.ts` 也有前端请求。

原生业务数据保存在应用数据目录的 `calendar-data.json`，包含世界时钟、定位、天气缓存及 macOS 菜单栏样式，写入使用临时文件再重命名。界面偏好使用前端 `localStorage`；自启动状态由系统管理。修改持久化字段时考虑现有用户数据与缺失字段的默认值。

## Windows 与 macOS 差异

| 维度 | Windows | macOS |
| --- | --- | --- |
| 应用入口 | 拦截系统任务栏时钟左/右键，当前不创建独立托盘图标 | 菜单栏状态图标，左键切换日历，右键打开原生菜单；不显示 Dock 图标 |
| 原生实现 | Win32 鼠标钩子、UI Automation 时钟识别及近透明鼠标覆盖层 | Tauri 托盘配合 AppKit，通过 `objc2` 调整状态图标和窗口 |
| 主面板定位 | 按点击所在显示器工作区的右下角定位，避开任务栏 | 在菜单栏图标下方居中，并限制在屏幕可用区域内 |
| 背景与字体 | 透明 WebView 外壳配合共享 CSS 面板背景，默认字体栈为 Segoe UI / Microsoft YaHei | macOS 26+ 使用 `NSGlassEffectView`，较旧系统回退菜单材质；原生玻璃分支使用 Apple 系统字体 |
| 主界面顺序 | 当前日期/时间区域在日历上方 | CSS 平台覆盖将当前日期/时间区域放在日历下方 |
| 滚轮翻月 | 按纵向滚动阈值翻月 | 聚合触控板手势，一次手势只翻一次；过滤横向及 Ctrl 缩放输入，避免惯性连翻 |
| 辅助面板焦点 | 显示日期详情/世界时钟窗口时设置焦点 | 日期详情作为主窗口子窗口跟随全屏 Space，显示时不抢主日历焦点；世界时钟可获焦 |
| 平台设置 | 设置系统短日期/短时间格式，会影响其他应用，不只是本应用 | 设置菜单栏图标为日历、日期或星期加日期；玻璃不透明度仅在能力可用时显示 |
| 自启动 | 使用自启动插件 | 打包应用在满足条件时优先使用 `SMAppService`，否则回退 LaunchAgent |
| 更新安装 | Windows 安装包与 PowerShell 安装流程 | 原生更新或 DMG 应用替换流程，需考虑安装目录可写性 |

主窗口当前为固定 `420 × 510`，默认隐藏、无边框、透明、跳过任务栏且置顶。日期详情宽度为 `350`，高度跟随主窗口；世界时钟为 `520 × 300`。辅助窗口优先放在主窗口左侧，空间不足时转到右侧并限制在屏幕范围内。布局不能只按浏览器大窗口设计。

关闭窗口是隐藏，不是退出。主面板隐藏时也会隐藏辅助面板。两端失焦处理均有延迟和跨窗口焦点检查，但实现不同；在主窗口、辅助窗口和菜单间操作时不能意外收起整个应用。

平台命令通过 Rust 条件编译注册。调用 `taskbar_date_format_*`、`taskbar_time_format_*` 前确认是 Windows；调用 `menu_bar_style_*`、`macos_glass_enabled` 前确认是 macOS，避免另一端出现未注册命令错误。AppKit 窗口操作沿用现有主线程调度，Windows 钩子及 UI Automation 逻辑保留线程与缓存边界。

## 公共 UI 修改要求

1. 修改 `App.tsx`、共享组件、状态或 `tokens.css` 前，同时检查共享规则、`[data-platform="macos"]`、`[data-platform="windows"]` 和 `[data-native-glass="true"]` 覆盖，确认影响的是哪些窗口及平台。
2. 优先复用设计令牌和共享组件。主题色与背景会被运行时设置覆盖，不要用硬编码颜色绕过主题；只有真实平台差异才添加平台限定样式，避免把一端修复无条件应用到另一端。
3. 同时考虑 Windows 普通面板、macOS 原生玻璃和旧系统材质回退。检查浅色、深色、跟随系统、自定义颜色、玻璃透明度及 `prefers-reduced-transparency`，保证文字、选中态和按钮边界可辨识。
4. 按实际主/辅助窗口尺寸检查高度、滚动、菜单和弹层裁剪；注意 macOS 日期区域排序、不同字体字宽和中英文文案长度。调整布局尺寸时同步审视 Rust 窗口尺寸及定位代码。
5. 同时考虑 Windows 鼠标滚轮和 macOS 触控板惯性，不能删掉平台手势分支后只验证鼠标。键盘操作、输入框、下拉选择、搜索及拖拽不能触发错误翻月或失焦隐藏。
6. 保留多窗口设置同步、重新显示时的主题/时钟刷新及事件清理。新增 Tauri 命令、事件或数据字段时同步检查 Rust、TypeScript、命令注册和相关窗口权限。
7. 新增公共文案优先使用 `src/data/i18n.ts`，同时考虑中文和英文；平台专属功能只在相应平台或能力可用时展示，不能让另一端出现不可用入口。
8. 验证结论必须区分两端实际测试与静态检查。无法运行某个平台时，在交付说明中写明未验证的平台及需回归的行为，不能将浏览器预览或单平台通过描述为双端验证完成。

### 双端回归清单

| 检查项 | Windows | macOS |
| --- | --- | --- |
| 打开与收起 | 任务栏时钟左键、右键菜单、点击外部后隐藏 | 菜单栏图标左键、右键菜单、点击外部后隐藏 |
| 跨窗口交互 | 日期详情、世界时钟、设置切换时焦点正常 | 日期详情不抢焦点，切换辅助窗口及全屏 Space 后正常 |
| 视觉与布局 | 常用显示缩放下无裁剪，字体和选中态清晰 | Retina、玻璃及旧系统回退下无裁剪，底部日期区域正确 |
| 输入 | 鼠标滚轮、键盘、输入框、选择器及拖拽 | 触控板惯性、横向手势、键盘、选择器及拖拽 |
| 状态同步 | 更改主题/语言后辅助窗口及重开面板正确 | 更改主题/语言后辅助窗口及重开面板正确 |
| 显示器边界 | 多屏、不同缩放、任务栏位置下窗口可见 | 多屏、菜单栏、Dock 和全屏 Space 下窗口可见 |

## 开发与验证

命令从仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装前端依赖 |
| `npm run dev` | Vite 浏览器预览，端口 `1420`；不包含原生入口、材质、窗口焦点或定位行为 |
| `npm run tauri:dev` | 当前平台原生开发模式；主窗口默认隐藏，通过平台入口打开 |
| `npm run build` | TypeScript 类型检查及前端构建 |
| `npm test` | 运行 `src/services/*.test.mjs` 中的前端服务测试 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 检查当前平台 Rust 编译 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 运行当前平台 Rust 测试 |
| `npm run tauri:build` | 构建当前平台桌面应用与安装包 |

前端改动至少执行 `npm run build`，服务逻辑变更补充 `npm test`；Rust 改动执行对应编译检查和相关测试。平台条件编译代码需要对应系统验证，macOS 编译通过不代表 Windows 分支已编译通过。需要真实 Windows 桌面的忽略测试不等于自动回归覆盖。

发布配置位于 `.github/workflows/release.yml`，当前矩阵为 Windows x86_64 和 macOS Apple Silicon，不能假定已有 Intel Mac 发布产物。修改发布版本时保持 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 与发布标签一致。

## 维护边界

- 以当前代码和配置为准，README 和设计资料可能滞后。当前黄历已在前端本地计算，不要沿用旧文档中在线黄历请求的描述。
- 不要将 SQLite、原生地理定位、系统日历事件、通知或云同步写成现有能力；当前使用 JSON 存储及 IP/手动定位，日历事件开关仍禁用。
- 窗口透明不等于鼠标点击穿透。Windows 时钟覆盖层用于捕获输入，不能当作主日历支持点击穿透的证据。
- macOS 启用了私有 API 且使用 ad-hoc 签名，不能假定可提交 Mac App Store 或已完成公证。其他平台的兜底代码不代表已有完整支持。
- 保持改动聚焦，保留工作区中已有的用户修改；不要手工编辑 `dist/`、`node_modules/`、`src-tauri/target/` 或 `src-tauri/gen/` 等构建产物。
