export type Language = "system" | "zh_CN" | "en_US";

type Dict = Record<string, string>;

const zh: Dict = {
  "settings.title": "设置",
  "settings.appearance": "外观",
  "settings.calendar": "日历",
  "settings.language": "语言",
  "settings.menubarStyle": "标题栏样式",
  "settings.launchAtLogin": "开机启动",
  "settings.update": "在线更新",
  "settings.about": "关于",
  "settings.locationWeather": "位置与天气",
  "settings.taskbarDate": "Windows 任务栏日期",
  "settings.close": "关闭",
  "settings.apply": "应用",
  "settings.applyToWindows": "应用到 Windows",
  "settings.saving": "应用中…",

  "theme.system": "跟随系统",
  "theme.light": "日间模式",
  "theme.dark": "夜间模式",
  "theme.system.desc": "根据系统设置自动切换",
  "theme.light.desc": "始终使用浅色主题",
  "theme.dark.desc": "始终使用深色主题",

  "appearance.accentColor": "强调色",
  "appearance.backgroundColor": "背景颜色",
  "appearance.theme": "主题",

  "calendar.startWeekOn": "星期开始于",
  "calendar.showLunar": "显示农历",
  "calendar.showHolidays": "显示中国法定假日",
  "calendar.showEvents": "显示日历事件",
  "calendar.showWeekNumbers": "显示周数",
  "calendar.keyboardShortcut": "键盘快捷键",

  "language.system": "跟随系统",
  "language.zh_CN": "简体中文",
  "language.en_US": "English",

  "menubarStyle.calendar": "日历图标",
  "menubarStyle.calendar.desc": "默认图标",
  "menubarStyle.date": "显示当天日期",
  "menubarStyle.date.desc": "菜单栏显示今日日期",
  "menubarStyle.weekdayDate": "周几 + 日期",
  "menubarStyle.weekdayDate.desc": "上面显示周几，下面显示日期",

  "update.auto": "自动检查更新",
  "update.beta": "包含测试版",
  "update.checkNow": "检查更新",
  "update.recheck": "重新检查",
  "update.current": "已是最新版本。",
  "update.unreleased": "仓库目前没有公开发布的版本。",
  "update.checking": "正在检查 GitHub 最新发布版本…",
  "update.available": "发现新版本",
  "update.available.desc": "可前往 GitHub Release 下载并安装更新。",
  "update.goUpdate": "前往更新",
  "update.ignore": "忽略此版本",
  "update.currentVersion": "当前版本",
  "update.idle": "点击检查更新以获取最新版本。",

  "about.tagline": "轻量桌面日历，提供农历、天气与世界时钟。",
  "about.repo": "GitHub 仓库",

  "weekday.mon": "一",
  "weekday.tue": "二",
  "weekday.wed": "三",
  "weekday.thu": "四",
  "weekday.fri": "五",
  "weekday.sat": "六",
  "weekday.sun": "日",

  "weekday.full.sun": "星期日",
  "weekday.full.mon": "星期一",
  "weekday.full.tue": "星期二",
  "weekday.full.wed": "星期三",
  "weekday.full.thu": "星期四",
  "weekday.full.fri": "星期五",
  "weekday.full.sat": "星期六",

  "menu.openCalendar": "打开日历",
  "menu.settings": "设置",
  "menu.menubarSettings": "标题栏设置",
  "menu.onlineUpdate": "在线更新",
  "menu.about": "关于",
  "menu.quit": "退出",
  "menu.worldClock": "世界时钟",

  "today": "今天",
  "lunar": "农历",
  "dateDetail": "日期详情",
  "worldTime": "世界时间",
  "week": "周",
  "weekShort": "第",
};

const en: Dict = {
  "settings.title": "Settings",
  "settings.appearance": "Appearance",
  "settings.calendar": "Calendar",
  "settings.language": "Language",
  "settings.menubarStyle": "Menubar Style",
  "settings.launchAtLogin": "Launch at login",
  "settings.update": "Update",
  "settings.about": "About",
  "settings.locationWeather": "Location & Weather",
  "settings.taskbarDate": "Windows taskbar date",
  "settings.close": "Close",
  "settings.apply": "Apply",
  "settings.applyToWindows": "Apply to Windows",
  "settings.saving": "Saving…",

  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system.desc": "Follow system setting",
  "theme.light.desc": "Always use light theme",
  "theme.dark.desc": "Always use dark theme",

  "appearance.accentColor": "Accent color",
  "appearance.backgroundColor": "Background color",
  "appearance.theme": "Theme",

  "calendar.startWeekOn": "Start week on",
  "calendar.showLunar": "Show lunar calendar",
  "calendar.showHolidays": "Show Chinese statutory holidays",
  "calendar.showEvents": "Show calendar events",
  "calendar.showWeekNumbers": "Show week numbers",
  "calendar.keyboardShortcut": "Keyboard shortcut",

  "language.system": "System",
  "language.zh_CN": "简体中文",
  "language.en_US": "English",

  "menubarStyle.calendar": "Calendar icon",
  "menubarStyle.calendar.desc": "Default icon",
  "menubarStyle.date": "Show today's date",
  "menubarStyle.date.desc": "Show today's date in menubar",
  "menubarStyle.weekdayDate": "Weekday + date",
  "menubarStyle.weekdayDate.desc": "Weekday on top, date below",

  "update.auto": "Automatically check for updates",
  "update.beta": "Include beta channel",
  "update.checkNow": "Check for updates",
  "update.recheck": "Recheck",
  "update.current": "You are on the latest version.",
  "update.unreleased": "No public release available.",
  "update.checking": "Checking GitHub latest release…",
  "update.available": "New version available",
  "update.available.desc": "Download the update from GitHub Releases.",
  "update.goUpdate": "Get update",
  "update.ignore": "Ignore this version",
  "update.currentVersion": "Current version",
  "update.idle": "Click check for updates to get the latest version.",

  "about.tagline": "A lightweight desktop calendar with lunar dates, weather and world clocks.",
  "about.repo": "GitHub repository",

  "weekday.mon": "Mon",
  "weekday.tue": "Tue",
  "weekday.wed": "Wed",
  "weekday.thu": "Thu",
  "weekday.fri": "Fri",
  "weekday.sat": "Sat",
  "weekday.sun": "Sun",

  "weekday.full.sun": "Sunday",
  "weekday.full.mon": "Monday",
  "weekday.full.tue": "Tuesday",
  "weekday.full.wed": "Wednesday",
  "weekday.full.thu": "Thursday",
  "weekday.full.fri": "Friday",
  "weekday.full.sat": "Saturday",

  "menu.openCalendar": "Open calendar",
  "menu.settings": "Settings",
  "menu.menubarSettings": "Menubar settings",
  "menu.onlineUpdate": "Online update",
  "menu.about": "About",
  "menu.quit": "Quit",
  "menu.worldClock": "World clock",

  "today": "Today",
  "lunar": "Lunar",
  "dateDetail": "Date details",
  "worldTime": "World time",
  "week": "W",
  "weekShort": "Wk",
};

const dictionaries: Record<Exclude<Language, "system">, Dict> = { zh_CN: zh, en_US: en };

export function resolveLanguage(language: Language): Exclude<Language, "system"> {
  if (language !== "system") return language;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh_CN" : "en_US";
}

export function translator(language: Language) {
  const dict = dictionaries[resolveLanguage(language)];
  const inChinese = resolveLanguage(language) === "zh_CN";
  return {
    t: (key: string) => dict[key] ?? key,
    inChinese,
  };
}
