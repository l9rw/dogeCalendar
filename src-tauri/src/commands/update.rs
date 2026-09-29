use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::{Command, Stdio}, time::{SystemTime, UNIX_EPOCH}};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;

const RELEASES_API: &str = "https://api.github.com/repos/l9rw/dogeCalendar/releases";
const RELEASES_LATEST_API: &str = "https://api.github.com/repos/l9rw/dogeCalendar/releases/latest";
const RELEASES_URL: &str = "https://github.com/l9rw/dogeCalendar/releases/tag/";

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current_version: String,
    has_release: bool,
    release: Option<AvailableRelease>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableRelease {
    version: String,
    url: String,
}

fn available_release(release: GithubRelease, current: &str) -> Option<AvailableRelease> {
    if release.draft {
        return None;
    }
    let tag_version = release.tag_name.strip_prefix('v').unwrap_or(&release.tag_name);
    let normalized = if tag_version.matches('.').count() == 1 {
        format!("{tag_version}.0")
    } else {
        tag_version.to_string()
    };
    let latest = semver::Version::parse(&normalized).ok()?;
    let installed = semver::Version::parse(current.strip_prefix('v').unwrap_or(current)).ok()?;
    if latest <= installed {
        return None;
    }
    Some(AvailableRelease {
        version: latest.to_string(),
        url: format!("{RELEASES_URL}{}", release.tag_name),
    })
}

async fn fetch_releases(
    state: &State<'_, AppState>,
    include_beta: bool,
) -> Result<Vec<GithubRelease>, String> {
    let request = if include_beta {
        state.http.get(RELEASES_API)
    } else {
        state.http.get(RELEASES_LATEST_API)
    };
    let response = request
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("无法连接 GitHub：{error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    let response = response
        .error_for_status()
        .map_err(|error| format!("获取发布版本失败：{error}"))?;
    if include_beta {
        response
            .json::<Vec<GithubRelease>>()
            .await
            .map_err(|error| format!("解析发布版本失败：{error}"))
    } else {
        response
            .json::<GithubRelease>()
            .await
            .map(|release| vec![release])
            .map_err(|error| format!("解析发布版本失败：{error}"))
    }
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    state: State<'_, AppState>,
    include_beta: Option<bool>,
) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let releases = fetch_releases(&state, include_beta.unwrap_or(false)).await?;
    if releases.is_empty() {
        return Ok(UpdateCheck {
            current_version,
            has_release: false,
            release: None,
        });
    }
    // Drafts are always skipped; prereleases are only considered in beta mode.
    let include_prereleases = include_beta.unwrap_or(false);
    let candidate = releases
        .into_iter()
        .filter(|release| !release.draft && (include_prereleases || !release.prerelease))
        .filter_map(|release| available_release(release, &current_version))
        .max_by(|a, b| {
            semver::Version::parse(&a.version)
                .ok()
                .cmp(&semver::Version::parse(&b.version).ok())
        });
    Ok(UpdateCheck {
        release: candidate,
        current_version,
        has_release: true,
    })
}

fn asset_for_platform(release: &GithubRelease) -> Option<&GithubAsset> {
    let version = release.tag_name.strip_prefix('v').unwrap_or(&release.tag_name);
    #[cfg(all(windows, target_arch = "x86_64"))]
    let name = format!("dogeCalendar_{version}_x64-setup.exe");
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let name = format!("dogeCalendar_{version}_aarch64.dmg");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let name = format!("dogeCalendar_{version}_x64.dmg");
    #[cfg(not(any(all(windows, target_arch = "x86_64"), all(target_os = "macos", target_arch = "aarch64"), all(target_os = "macos", target_arch = "x86_64"))))]
    return None;
    #[cfg(any(all(windows, target_arch = "x86_64"), all(target_os = "macos", target_arch = "aarch64"), all(target_os = "macos", target_arch = "x86_64")))]
    release.assets.iter().find(|asset| asset.name == name)
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    version: String,
    include_beta: bool,
) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let release = fetch_releases(&state, include_beta).await?
        .into_iter()
        .find(|release| {
            (include_beta || !release.prerelease)
                && available_release(GithubRelease {
                    tag_name: release.tag_name.clone(),
                    draft: release.draft,
                    prerelease: release.prerelease,
                    assets: Vec::new(),
                }, &current).is_some_and(|candidate| candidate.version == version)
        })
        .ok_or("发布版本已失效，请重新检查更新")?;
    let endpoint = format!("https://github.com/l9rw/dogeCalendar/releases/download/{}/latest.json", release.tag_name);
    #[cfg(windows)]
    let mut signed_installer = None;
    if let Ok(url) = reqwest::Url::parse(&endpoint) {
        // An older release may not have a signed updater artifact. In that case use its full installer.
        if let Ok(updater) = app.updater_builder().endpoints(vec![url]).and_then(|builder| builder.build()) {
            if let Ok(Some(update)) = updater.check().await {
                if update.version == version {
                    #[cfg(windows)]
                    { signed_installer = update.download(|_, _| {}, || {}).await.ok(); }
                    #[cfg(not(windows))]
                    if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                        app.restart();
                        return Ok(());
                    }
                }
            }
        }
    }
    let asset = asset_for_platform(&release).ok_or("此版本没有适用于当前系统的安装包")?;
    let digest = asset.digest.as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("发布版本缺少有效的 SHA-256 校验值")?;
    if asset.size == 0 || asset.size > 300_000_000 {
        return Err("安装包大小异常".into());
    }
    let url = reqwest::Url::parse(&asset.browser_download_url).map_err(|error| error.to_string())?;
    let expected_prefix = format!("/l9rw/dogeCalendar/releases/download/{}/", release.tag_name);
    if url.scheme() != "https" || url.host_str() != Some("github.com")
        || !url.path().starts_with(&expected_prefix) || !url.path().ends_with(&asset.name) {
        return Err("安装包下载地址不可信".into());
    }
    let response = state.http.get(url).send().await
        .map_err(|error| format!("下载安装包失败：{error}"))?
        .error_for_status().map_err(|error| format!("下载安装包失败：{error}"))?;
    if response.content_length().is_some_and(|size| size > 300_000_000) {
        return Err("安装包过大".into());
    }
    let bytes = response.bytes().await.map_err(|error| format!("读取安装包失败：{error}"))?;
    if bytes.len() as u64 != asset.size || format!("{:x}", Sha256::digest(&bytes)) != digest.to_ascii_lowercase() {
        return Err("安装包校验失败，请重新下载".into());
    }
    let directory = std::env::temp_dir().join(format!("dogeCalendar-update-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos()));
    fs::create_dir(&directory).map_err(|error| format!("创建更新目录失败：{error}"))?;
    let package = directory.join(&asset.name);
    if let Err(error) = fs::write(&package, &bytes) {
        let _ = fs::remove_dir_all(&directory);
        return Err(format!("保存安装包失败：{error}"));
    }
    #[cfg(windows)]
    let signed_package = if let Some(signed) = signed_installer {
        let path = directory.join("signed-setup.exe");
        if let Err(error) = fs::write(&path, signed) {
            let _ = fs::remove_dir_all(&directory);
            return Err(format!("保存热更新包失败：{error}"));
        }
        Some(path)
    } else { None };
    #[cfg(windows)]
    let result = launch_update(&app, &package, &directory, signed_package.as_deref());
    #[cfg(not(windows))]
    let result = launch_update(&app, &package, &directory);
    if result.is_err() { let _ = fs::remove_dir_all(&directory); }
    result?;
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
fn launch_update(_app: &AppHandle, package: &Path, directory: &Path, signed_package: Option<&Path>) -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let script = directory.join("install.ps1");
    fs::write(&script, r#"param($ParentPid, $Installer, $AppExe, $UpdateDir, $SignedInstaller)
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
try {
    $process = $null
    if ($SignedInstaller -and (Test-Path -LiteralPath $SignedInstaller)) {
        try { $process = Start-Process -FilePath $SignedInstaller -ArgumentList '/S' -Wait -PassThru } catch {}
    }
    if ($null -eq $process -or $process.ExitCode -ne 0) {
        $process = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
    }
    if ($process.ExitCode -eq 0) { Start-Process -FilePath $AppExe }
} finally { Remove-Item -LiteralPath $UpdateDir -Recurse -Force -ErrorAction SilentlyContinue }
"#).map_err(|error| error.to_string())?;
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script).arg(std::process::id().to_string())
        .arg(package).arg(current_exe).arg(directory).arg(signed_package.unwrap_or(Path::new("")))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|error| format!("启动更新安装程序失败：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_update(_app: &AppHandle, package: &Path, directory: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let bundle = exe.ancestors().find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .ok_or("请从已安装的 .app 中运行更新")?;
    let parent = bundle.parent().ok_or("无法定位应用安装目录")?;
    let staged = parent.join(format!(".dogeCalendar-update-{}.app", std::process::id()));
    let backup = parent.join(format!(".dogeCalendar-backup-{}.app", std::process::id()));
    if staged.exists() || backup.exists() { return Err("上次更新尚未清理，请重新启动后再试".into()); }
    let probe = parent.join(format!(".dogeCalendar-write-test-{}", std::process::id()));
    fs::write(&probe, b"").map_err(|_| "应用安装目录不可写，请将应用移到可写目录后更新")?;
    fs::remove_file(probe).map_err(|error| error.to_string())?;
    let mount = directory.join("mount");
    fs::create_dir(&mount).map_err(|error| error.to_string())?;
    let attached = Command::new("hdiutil").args(["attach", "-readonly", "-nobrowse", "-quiet", "-mountpoint"])
        .arg(&mount).arg(package).output().map_err(|error| error.to_string())?;
    if !attached.status.success() { return Err(format!("挂载安装包失败：{}", String::from_utf8_lossy(&attached.stderr))); }
    let source = mount.join(bundle.file_name().ok_or("无法定位应用名称")?);
    let copy = if source.is_dir() {
        Command::new("ditto").arg(&source).arg(&staged).status().map_err(|error| error.to_string())?
    } else {
        let _ = Command::new("hdiutil").arg("detach").arg(&mount).status();
        return Err("安装包中没有对应的应用程序".into());
    };
    let detached = Command::new("hdiutil").arg("detach").arg(&mount).status().map_err(|error| error.to_string())?;
    if !copy.success() || !detached.success() {
        let _ = fs::remove_dir_all(&staged);
        return Err("无法准备更新应用程序".into());
    }
    let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 1; done
if mv "$2" "$4"; then
  if mv "$3" "$2"; then
    open "$2"
    rm -rf "$4" "$5"
  else
    mv "$4" "$2"
    rm -rf "$3" "$5"
  fi
fi"#;
    let result = Command::new("/bin/sh").args(["-c", script, "update-helper"])
        .arg(std::process::id().to_string()).arg(bundle).arg(&staged).arg(&backup).arg(directory)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!("启动更新程序失败：{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> GithubRelease {
        GithubRelease { tag_name: tag.into(), draft: false, prerelease: false, assets: Vec::new() }
    }

    #[test]
    fn compares_semantic_versions() {
        assert_eq!(available_release(release("v0.10.0"), "0.9.9").unwrap().version, "0.10.0");
        assert_eq!(available_release(release("v0.10"), "0.9.9").unwrap().url, "https://github.com/l9rw/dogeCalendar/releases/tag/v0.10");
        assert!(available_release(release("v0.9.9"), "0.9.9").is_none());
        assert!(available_release(release("v0.9.8"), "0.9.9").is_none());
        assert!(available_release(release("unexpected/tag"), "0.9.9").is_none());
    }

    #[test]
    fn skips_draft_but_keeps_prereleases() {
        // Drafts are always rejected regardless of beta mode.
        let mut candidate = release("v1.0.0");
        candidate.draft = true;
        assert!(available_release(candidate, "0.9.9").is_none());

        // Prereleases pass `available_release`; the beta filter lives in the caller.
        let mut prerelease = release("v1.0.0");
        prerelease.prerelease = true;
        assert!(available_release(prerelease, "0.9.9").is_some());
    }

    #[test]
    fn matches_only_current_architecture_installer() {
        let mut candidate = release("v1.2.3");
        candidate.assets = vec![
            GithubAsset { name: "unrelated.exe".into(), browser_download_url: String::new(), digest: None, size: 1 },
            GithubAsset { name: "dogeCalendar_1.2.3_x64-setup.exe".into(), browser_download_url: String::new(), digest: None, size: 1 },
            GithubAsset { name: "dogeCalendar_1.2.3_aarch64.dmg".into(), browser_download_url: String::new(), digest: None, size: 1 },
        ];
        #[cfg(all(windows, target_arch = "x86_64"))]
        assert_eq!(asset_for_platform(&candidate).unwrap().name, "dogeCalendar_1.2.3_x64-setup.exe");
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(asset_for_platform(&candidate).unwrap().name, "dogeCalendar_1.2.3_aarch64.dmg");
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        assert!(asset_for_platform(&candidate).is_none());
    }
}
