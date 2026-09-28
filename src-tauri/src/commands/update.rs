use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::state::AppState;

const RELEASES_API: &str = "https://api.github.com/repos/l9rw/dogeCalendar/releases";
const RELEASES_LATEST_API: &str = "https://api.github.com/repos/l9rw/dogeCalendar/releases/latest";
const RELEASES_URL: &str = "https://github.com/l9rw/dogeCalendar/releases/tag/";

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> GithubRelease {
        GithubRelease { tag_name: tag.into(), draft: false, prerelease: false }
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
}
