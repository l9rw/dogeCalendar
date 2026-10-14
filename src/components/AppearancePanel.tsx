import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { translator } from "../data/i18n";
import { accentColors, lightBackgroundColors, darkBackgroundColors, colorName, colorThemes, type ColorInfo } from "../data/colors";

function ColorSection({ title, colors, selected, onSelect, inChinese }: {
  title: string;
  colors: ColorInfo[];
  selected: string;
  onSelect: (hex: string) => void;
  inChinese: boolean;
}) {
  return (
    <div className="settings-section">
      <span className="section-label">{title}</span>
      <div className="color-grid">
        {colors.map((color) => (
          <button
            key={color.hex}
            type="button"
            className={`color-swatch ${selected.toUpperCase() === color.hex.toUpperCase() ? "active" : ""}`}
            style={{ background: color.hex }}
            title={inChinese ? color.name_zh : color.name_en}
            onClick={() => onSelect(color.hex)}
            aria-label={inChinese ? color.name_zh : color.name_en}
            aria-pressed={selected.toUpperCase() === color.hex.toUpperCase()}
          />
        ))}
      </div>
      <p className="color-grid-name">{colorName(selected, colors, inChinese)}</p>
    </div>
  );
}

export function AppearancePanel({ dark, onClose }: { dark: boolean; onClose: () => void }) {
  const store = useSettingsStore();
  const { t, inChinese } = useMemo(() => translator(store.language), [store.language]);
  const isMac = document.documentElement.dataset.platform === "macos";
  const [glassAvailable, setGlassAvailable] = useState(() => document.documentElement.dataset.nativeGlass === "true");
  useEffect(() => {
    if (isMac && "__TAURI_INTERNALS__" in window) void invoke<boolean>("macos_glass_enabled").then(setGlassAvailable).catch(console.error);
  }, [isMac]);
  const selectedPalette = colorThemes.find((palette) => palette.id === store.appearance.colorTheme)!;
  const customized = (["lightAccent", "lightBackground", "darkAccent", "darkBackground"] as const)
    .some((key) => store.appearance[key].toUpperCase() !== selectedPalette[key].toUpperCase());

  return (
    <main className="aux-shell appearance-panel" aria-label={t("settings.appearance")}>
      <header className="settings-header">
        <h2><svg className="settings-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3 11 13l-3-3L18 3M11 13c1 4-2 8-8 8 2-2 0-5 3-7 2-1 3-1 5-1Z" /></svg>{t("settings.appearance")}</h2>
        <button type="button" className="settings-close" onClick={onClose} aria-label={t("settings.close")}>{"\u00d7"}</button>
      </header>
      <div className="appearance-content">
        <p className="settings-description appearance-preview-hint">{t("appearance.livePreview")}</p>
        <div className="settings-section">
          <span className="section-label" id="color-theme-label">{t("appearance.colorTheme")}</span>
          <div className="color-theme-options" role="group" aria-labelledby="color-theme-label">
            {colorThemes.map((palette) => (
              <button key={palette.id} type="button" className="color-theme-option" aria-pressed={store.appearance.colorTheme === palette.id} onClick={() => store.setColorTheme(palette.id)}>
                <span className="color-theme-preview" aria-hidden="true" style={{
                  background: dark ? palette.darkBackground : palette.lightBackground,
                  color: dark ? palette.darkAccent : palette.lightAccent,
                }}><i /><i /><i /></span>
                <span className="color-theme-copy">
                  <strong>{t(`colorTheme.${palette.id}`)}{palette.id === "classic" && <small>{t("appearance.default")}</small>}</strong>
                  <span>{t(`colorTheme.${palette.id}.desc`)}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="settings-description color-theme-hint">{t("appearance.colorTheme.desc")}</p>
          {customized && <button type="button" className="settings-back color-theme-reset" onClick={() => store.setColorTheme(store.appearance.colorTheme)}>{t("appearance.resetPalette")}</button>}
        </div>
        <div className="settings-section">
          <span className="section-label">{t("appearance.theme")}</span>
          <div className="theme-options">
            {(["light", "dark", "system"] as const).map((mode) => (
              <button key={mode} type="button" className={`theme-option ${store.theme === mode ? "active" : ""}`} aria-pressed={store.theme === mode} onClick={() => store.setTheme(mode)}>
                <span className={`theme-dot ${mode}`} aria-hidden="true" />
                <span className="theme-label">{t(`theme.${mode}`)}</span>
                <span className="theme-desc">{t(`theme.${mode}.desc`)}</span>
              </button>
            ))}
          </div>
        </div>
        <ColorSection title={t("appearance.accentColor")} colors={accentColors} selected={dark ? store.appearance.darkAccent : store.appearance.lightAccent} onSelect={(hex) => store.setAccent(hex, dark)} inChinese={inChinese} />
        <ColorSection title={t("appearance.backgroundColor")} colors={dark ? darkBackgroundColors : lightBackgroundColors} selected={dark ? store.appearance.darkBackground : store.appearance.lightBackground} onSelect={(hex) => store.setBackground(hex, dark)} inChinese={inChinese} />
        {glassAvailable && (
          <div className="settings-section glass-opacity-setting">
            <label className="section-label" htmlFor="glass-opacity">{t("appearance.glassOpacity")}</label>
            <div className="glass-opacity-control">
              <input id="glass-opacity" type="range" min="0" max="100" step="1" value={store.appearance.glassOpacity} onChange={(event) => store.setGlassOpacity(Number(event.target.value))} />
              <output htmlFor="glass-opacity">{Math.round(store.appearance.glassOpacity)}%</output>
            </div>
            <p className="settings-description">{t("appearance.glassOpacity.desc")}</p>
          </div>
        )}
      </div>
    </main>
  );
}
