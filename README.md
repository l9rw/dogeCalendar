# Calendar

一个基于 Tauri 2、React 和 TypeScript 构建的轻量跨平台桌面日历。

项目目标是提供一个适合常驻系统托盘或 macOS 菜单栏的日历面板，支持月视图、年视图、中国农历、二十四节气、法定节假日与调休、世界时间、定位天气等能力。当前仓库处于原型迭代阶段，已经实现基础月视图和桌面托盘交互，更多领域数据和平台能力正在逐步接入。

## 当前状态

已实现：

- Tauri 2 桌面窗口与系统托盘图标
- 托盘左键显示/隐藏日历窗口
- 托盘菜单中的打开日历、设置和退出操作
- 月视图固定 7 列、6 行日历网格
- 上个月、下个月和回到今天
- 日期选择与日期详情面板
- 当前日期高亮
- 简单农历文本和节气占位展示
- 跟随系统的明暗主题，以及手动切换主题
- 设置面板入口
- 窗口关闭时隐藏到托盘，不直接退出应用
- 桌面端透明、无边框、跳过任务栏窗口配置
- 小屏幕和移动宽度下的响应式布局

规划中：

- 年视图
- 完整的 1900 至 2100 年农历和闰月算法
- 二十四节气预计算数据
- 法定节假日、调休和用户覆盖数据
- 世界时间、时区搜索和排序
- 系统定位与天气 Provider
- SQLite 设置、事件和缓存
- Windows 托盘定位与 macOS 菜单栏面板适配
- 自启动、系统日历、通知和云同步

## 技术栈

- [Tauri 2](https://tauri.app/)：桌面应用壳、窗口和系统托盘
- [React 19](https://react.dev/)：用户界面
- [TypeScript](https://www.typescriptlang.org/)：类型安全的前端开发
- [Vite](https://vite.dev/)：开发服务器和前端构建
- [Rust](https://www.rust-lang.org/)：Tauri 原生层
- [Zustand](https://zustand.docs.pmnd.rs/)：前端状态管理依赖，后续用于扩展跨组件状态

整体设计和后续领域拆分见 [`docs/design.md`](docs/design.md)。

## 环境要求

开发 Tauri 桌面端前，需要准备：

- Node.js 18 或更高版本
- npm
- Rust stable 工具链
- Tauri 2 对应的系统开发依赖

Windows 开发环境通常还需要：

- Microsoft Visual Studio Build Tools，并安装 C++ 桌面开发工作负载
- WebView2 Runtime

macOS 开发环境通常还需要：

- Xcode Command Line Tools

完整的平台依赖说明请参考 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 安装依赖

```bash
npm install
```

## 开发

### 浏览器预览

只启动 Vite 前端开发服务器：

```bash
npm run dev
```

该方式适合快速查看 React UI，但不会启动 Tauri 托盘和原生窗口行为。

### Tauri 桌面开发

启动带原生窗口和系统托盘的开发模式：

```bash
npm run tauri:dev
```

Tauri 配置中的开发地址为 `http://localhost:1420`。开发模式下主窗口默认隐藏，可通过托盘图标或托盘菜单中的“打开日历”显示。

## 构建

### 构建前端

执行 TypeScript 类型检查并生成 Vite 静态资源：

```bash
npm run build
```

输出目录为 `dist/`。

### 构建桌面安装包

构建 Tauri 桌面应用和对应安装包：

```bash
npm run tauri:build
```

构建产物会输出到 `src-tauri/target/release/` 下的 Tauri bundle 目录。具体格式取决于当前操作系统和 Tauri 的 bundle 配置。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite 前端开发服务器 |
| `npm run build` | 类型检查并构建前端 |
| `npm run preview` | 预览已构建的前端资源 |
| `npm run tauri:dev` | 启动 Tauri 桌面开发模式 |
| `npm run tauri:build` | 构建 Tauri 桌面安装包 |
| `npm run tauri` | 直接调用 Tauri CLI |

## 项目结构

```text
calendar/
├─ docs/
│  └─ design.md             # 产品目标、架构和迭代设计
├─ src/
│  ├─ App.tsx               # 当前日历主界面
│  ├─ main.tsx              # React 入口
│  └─ styles/
│     └─ tokens.css         # 主题令牌、布局和响应式样式
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs             # Tauri 应用、托盘和窗口行为
│  │  └─ main.rs            # 原生应用入口
│  ├─ capabilities/         # Tauri 权限配置
│  ├─ icons/                 # 应用图标
│  ├─ Cargo.toml             # Rust 依赖和 crate 配置
│  └─ tauri.conf.json        # 窗口、构建和打包配置
├─ index.html
├─ package.json
└─ vite.config.ts
```

## 当前交互

- 点击日期单元格可查看日期详情，并自动跳转到对应月份。
- 点击左右箭头切换月份。
- 点击“今天”回到当前日期。
- 点击右上角主题按钮切换明暗模式。
- 点击“设置”打开设置面板；托盘菜单也可以打开设置。
- 关闭窗口时应用会隐藏到系统托盘，使用托盘图标可以再次打开。

## 架构方向

当前前端原型集中在 `src/App.tsx`，原生托盘逻辑位于 `src-tauri/src/lib.rs`。后续会按照设计文档逐步拆分为以下层次：

```text
React UI
  -> Zustand stores / Tauri IPC
Rust application services
  -> calendar core / lunar / holiday / weather / location / storage
Platform adapters
  -> Windows tray + popup positioning
  -> macOS NSStatusItem + NSPanel positioning
```

业务计算、数据聚合、缓存和外部请求优先放在 Rust 层；前端负责展示和交互；Windows 与 macOS 的系统 API 通过平台适配层隔离。

## 隐私与数据说明

当前原型不包含定位、天气和远程节假日请求，也不会主动收集用户数据。后续接入网络能力时，计划由 Rust 发起请求、将必要的 API 配置隔离在原生层，并提供定位、天气和缓存清除选项。

## 许可证

当前项目尚未声明正式开源许可证。
