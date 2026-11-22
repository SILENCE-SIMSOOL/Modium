use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path};
use std::process::Output;

use tokio::process::Command;

use crate::models::{GitCommitEntry, GitFileChange, GitStatusInfo};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

async fn run_git(root: &Path, args: &[&str]) -> Result<Output, String> {
	let mut cmd = Command::new("git");
	cmd.current_dir(root)
		.arg("-c")
		.arg("core.quotepath=false")
		.args(args);
	#[cfg(windows)]
	cmd.creation_flags(CREATE_NO_WINDOW);

	cmd.output().await.map_err(|e| {
		if e.kind() == ErrorKind::NotFound {
			"git executable not found in PATH".to_string()
		} else {
			format!("Failed to execute git: {e}")
		}
	})
}

fn command_error(action: &str, output: &Output) -> String {
	let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
	let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
	let detail = if !stderr.is_empty() { stderr } else { stdout };
	if detail.is_empty() {
		format!(
			"git {action} failed with exit code {:?}",
			output.status.code()
		)
	} else {
		format!("git {action} failed: {detail}")
	}
}

fn sanitize_rel_path(rel_path: &str) -> Result<String, String> {
	let trimmed = rel_path.trim();
	if trimmed.is_empty() || trimmed.contains('\0') {
		return Err("Invalid git relative path".to_string());
	}
	if trimmed.starts_with('/') || trimmed.starts_with('\\') {
		return Err("Absolute path is not allowed for git operations".to_string());
	}
	let bytes = trimmed.as_bytes();
	if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
		return Err("Drive-prefixed path is not allowed for git operations".to_string());
	}
	let mut parts = Vec::new();
	for comp in Path::new(trimmed).components() {
		match comp {
			Component::Normal(seg) => parts.push(seg.to_string_lossy().to_string()),
			Component::CurDir => {}
			Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
				return Err("Path traversal is not allowed for git operations".to_string());
			}
		}
	}
	if parts.is_empty() {
		return Err("Invalid git relative path".to_string());
	}
	Ok(parts.join("/"))
}

fn parse_branch_header(header: &str) -> (Option<String>, u32, u32) {
	if header.starts_with("HEAD (no branch)") {
		return (None, 0, 0);
	}
	if let Some(rest) = header.strip_prefix("No commits yet on ") {
		return (Some(rest.trim().to_string()), 0, 0);
	}
	if let Some(rest) = header.strip_prefix("Initial commit on ") {
		return (Some(rest.trim().to_string()), 0, 0);
	}

	let mut ahead = 0u32;
	let mut behind = 0u32;
	let branch_part = if header.ends_with(']') {
		if let Some(idx) = header.rfind(" [") {
			let stats = &header[idx + 2..header.len() - 1];
			for item in stats.split(',') {
				let item = item.trim();
				if let Some(n) = item.strip_prefix("ahead ") {
					ahead = n.trim().parse().unwrap_or(0);
				} else if let Some(n) = item.strip_prefix("behind ") {
					behind = n.trim().parse().unwrap_or(0);
				}
			}
			&header[..idx]
		} else {
			header
		}
	} else {
		header
	};

	let local = branch_part
		.split("...")
		.next()
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.map(ToString::to_string);
	(local, ahead, behind)
}

pub fn parse_git_status_output(stdout: &str) -> GitStatusInfo {
	let mut branch = None;
	let mut ahead = 0u32;
	let mut behind = 0u32;
	let mut changes = Vec::new();

	for raw_line in stdout.lines() {
		let line = raw_line.trim_end_matches('\r');
		if let Some(header) = line.strip_prefix("## ") {
			let (b, a, bh) = parse_branch_header(header);
			branch = b;
			ahead = a;
			behind = bh;
			continue;
		}
		if line.len() < 4 {
			continue;
		}
		let bytes = line.as_bytes();
		let x = bytes[0] as char;
		let y = bytes[1] as char;
		let path_part = &line[3..];
		let resolved_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
			path_part
				.split_once(" -> ")
				.map(|(_, new_p)| new_p)
				.unwrap_or(path_part)
		} else {
			path_part
		};
		let rel_path = resolved_path
			.strip_prefix('"')
			.and_then(|s| s.strip_suffix('"'))
			.unwrap_or(resolved_path)
			.to_string();
		if x == '?' && y == '?' {
			changes.push(GitFileChange {
				rel_path,
				index_status: "?".to_string(),
				worktree_status: "?".to_string(),
				staged: false,
			});
		} else {
			changes.push(GitFileChange {
				rel_path,
				index_status: if x == ' ' {
					String::new()
				} else {
					x.to_string()
				},
				worktree_status: if y == ' ' {
					String::new()
				} else {
					y.to_string()
				},
				staged: !matches!(x, ' ' | '?' | '!'),
			});
		}
	}

	GitStatusInfo {
		is_repo: true,
		branch,
		ahead,
		behind,
		changes,
	}
}

pub async fn git_status(root: &Path) -> Result<GitStatusInfo, String> {
	let output = run_git(root, &["status", "--porcelain=v1", "-b"]).await?;
	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
		if stderr.contains("not a git repository") {
			return Ok(GitStatusInfo {
				is_repo: false,
				branch: None,
				ahead: 0,
				behind: 0,
				changes: Vec::new(),
			});
		}
		return Err(command_error("status", &output));
	}
	let stdout = String::from_utf8_lossy(&output.stdout);
	Ok(parse_git_status_output(&stdout))
}

fn format_untracked_diff(rel_path: &str, full_path: &Path) -> Result<String, String> {
	let bytes = fs::read(full_path).map_err(|e| format!("Failed to read untracked file: {e}"))?;
	let sample_len = bytes.len().min(8192);
	if bytes[..sample_len].contains(&0) {
		return Ok(format!("Binary untracked file: {rel_path}"));
	}
	let Ok(content) = std::str::from_utf8(&bytes) else {
		return Ok(format!("Binary untracked file: {rel_path}"));
	};
	let lines: Vec<&str> = content.lines().collect();
	if lines.is_empty() {
		return Ok(format!("--- /dev/null\n+++ b/{rel_path}\n"));
	}
	let mut out = format!(
		"--- /dev/null\n+++ b/{rel_path}\n@@ -0,0 +1,{} @@\n",
		lines.len()
	);
	for line in lines {
		out.push('+');
		out.push_str(line);
		out.push('\n');
	}
	Ok(out)
}

pub async fn git_diff(root: &Path, rel_path: &str, staged: bool) -> Result<String, String> {
	let clean_rel = sanitize_rel_path(rel_path)?;
	if staged {
		let output = run_git(root, &["diff", "--cached", "--", &clean_rel]).await?;
		if !output.status.success() {
			return Err(command_error("diff --cached", &output));
		}
		return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
	}

	let status_out = run_git(
		root,
		&["status", "--porcelain=v1", "-uall", "--", &clean_rel],
	)
	.await?;
	if status_out.status.success() {
		let status_str = String::from_utf8_lossy(&status_out.stdout);
		if status_str.lines().any(|l| l.starts_with("?? ")) {
			let full_path = root.join(&clean_rel);
			if full_path.is_file() {
				return format_untracked_diff(&clean_rel, &full_path);
			}
		}
	}

	let output = run_git(root, &["diff", "--", &clean_rel]).await?;
	if !output.status.success() {
		return Err(command_error("diff", &output));
	}
	Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn git_stage(root: &Path, rel_paths: &[String]) -> Result<(), String> {
	if rel_paths.is_empty() {
		return Ok(());
	}
	let clean: Vec<String> = rel_paths
		.iter()
		.map(|p| sanitize_rel_path(p))
		.collect::<Result<_, _>>()?;
	let mut args: Vec<&str> = Vec::with_capacity(clean.len() + 2);
	args.push("add");
	args.push("--");
	for path in &clean {
		args.push(path.as_str());
	}
	let output = run_git(root, &args).await?;
	if !output.status.success() {
		return Err(command_error("add", &output));
	}
	Ok(())
}

pub async fn git_unstage(root: &Path, rel_paths: &[String]) -> Result<(), String> {
	if rel_paths.is_empty() {
		return Ok(());
	}
	let clean: Vec<String> = rel_paths
		.iter()
		.map(|p| sanitize_rel_path(p))
		.collect::<Result<_, _>>()?;
	let head_check = run_git(root, &["rev-parse", "--verify", "HEAD"]).await?;
	let mut args: Vec<&str> = Vec::new();
	if head_check.status.success() {
		args.extend(["reset", "HEAD", "--"]);
	} else {
		args.extend(["rm", "--cached", "-r", "--ignore-unmatch", "--"]);
	}
	for path in &clean {
		args.push(path.as_str());
	}
	let output = run_git(root, &args).await?;
	if !output.status.success() {
		return Err(command_error("unstage", &output));
	}
	Ok(())
}

pub async fn git_commit(root: &Path, message: &str) -> Result<String, String> {
	let trimmed = message.trim();
	if trimmed.is_empty() {
		return Err("Commit message cannot be empty".to_string());
	}
	let output = run_git(root, &["commit", "-m", trimmed]).await?;
	if !output.status.success() {
		return Err(command_error("commit", &output));
	}
	let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
	if !stdout.is_empty() {
		return Ok(stdout);
	}
	let hash_out = run_git(root, &["rev-parse", "--short", "HEAD"]).await?;
	Ok(String::from_utf8_lossy(&hash_out.stdout).trim().to_string())
}

pub async fn git_init(root: &Path) -> Result<(), String> {
	let output = run_git(root, &["init"]).await?;
	if !output.status.success() {
		return Err(command_error("init", &output));
	}
	Ok(())
}

pub async fn git_log(root: &Path, limit: u32) -> Result<Vec<GitCommitEntry>, String> {
	if limit == 0 {
		return Ok(Vec::new());
	}
	let head_check = run_git(root, &["rev-parse", "--verify", "HEAD"]).await?;
	if !head_check.status.success() {
		return Ok(Vec::new());
	}
	let limit_str = limit.to_string();
	let output = run_git(
		root,
		&[
			"log",
			"-n",
			&limit_str,
			"--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
		],
	)
	.await?;
	if !output.status.success() {
		return Err(command_error("log", &output));
	}
	let stdout = String::from_utf8_lossy(&output.stdout);
	let mut entries = Vec::new();
	for record in stdout.split('\x1e') {
		let trimmed = record.trim();
		if trimmed.is_empty() {
			continue;
		}
		let fields: Vec<&str> = trimmed.split('\x1f').collect();
		if fields.len() < 5 {
			continue;
		}
		entries.push(GitCommitEntry {
			hash: fields[0].to_string(),
			short_hash: fields[1].to_string(),
			author: fields[2].to_string(),
			date: fields[3].to_string(),
			message: fields[4].to_string(),
		});
	}
	Ok(entries)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::path::PathBuf;
	use uuid::Uuid;

	fn temp_repo(name: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("fabric_studio_git_{name}_{}", Uuid::new_v4()));
		fs::create_dir_all(&dir).unwrap();
		dir
	}

	#[test]
	fn parses_porcelain_v1_status() {
		let sample = concat!(
			"## main...origin/main [ahead 2, behind 1]\n",
			"M  src/Staged.java\n",
			" M src/Unstaged.java\n",
			"MM src/Both.java\n",
			"R  old/Foo.java -> new/Bar.java\n",
			"?? untracked.txt\n"
		);
		let info = parse_git_status_output(sample);
		assert!(info.is_repo);
		assert_eq!(info.branch.as_deref(), Some("main"));
		assert_eq!(info.ahead, 2);
		assert_eq!(info.behind, 1);
		assert_eq!(info.changes.len(), 5);
		assert!(info.changes[0].staged);
		assert_eq!(info.changes[0].index_status, "M");
		assert!(!info.changes[1].staged);
		assert_eq!(info.changes[1].worktree_status, "M");
		assert!(info.changes[2].staged);
		assert_eq!(info.changes[2].worktree_status, "M");
		assert_eq!(info.changes[3].rel_path, "new/Bar.java");
		assert!(!info.changes[4].staged);
		assert_eq!(info.changes[4].index_status, "?");
	}

	#[tokio::test]
	async fn git_init_status_stage_unstage_commit_and_log() {
		let repo = temp_repo("workflow");

		// Non-repo reports is_repo = false cleanly
		let before = git_status(&repo).await.unwrap();
		assert!(!before.is_repo);

		git_init(&repo).await.unwrap();
		run_git(&repo, &["config", "user.name", "Fabric Tester"])
			.await
			.unwrap();
		run_git(&repo, &["config", "user.email", "tester@example.com"])
			.await
			.unwrap();

		// Empty repo has 0 commits
		assert!(git_log(&repo, 10).await.unwrap().is_empty());

		// Rejects path traversal in git operations
		assert!(git_stage(&repo, &["../escape.txt".to_string()])
			.await
			.is_err());
		assert!(git_diff(&repo, "../escape.txt", false).await.is_err());

		fs::create_dir_all(repo.join("src")).unwrap();
		fs::write(repo.join("src").join("README.md"), "# Fabric Mod\nHello\n").unwrap();
		let untracked = git_status(&repo).await.unwrap();
		assert!(untracked.is_repo);
		assert_eq!(untracked.changes.len(), 1);
		assert!(!untracked.changes[0].staged);

		// Untracked diff preview even inside untracked directory
		let diff_preview = git_diff(&repo, "src/README.md", false).await.unwrap();
		assert!(diff_preview.contains("+++ b/src/README.md"));
		assert!(diff_preview.contains("+# Fabric Mod"));

		// Stage and unstage on unborn HEAD
		git_stage(&repo, &["src/README.md".to_string()])
			.await
			.unwrap();
		let staged = git_status(&repo).await.unwrap();
		assert!(staged.changes[0].staged);

		let staged_diff = git_diff(&repo, "src/README.md", true).await.unwrap();
		assert!(staged_diff.contains("+# Fabric Mod"));

		git_unstage(&repo, &["src/README.md".to_string()])
			.await
			.unwrap();
		let unstaged = git_status(&repo).await.unwrap();
		assert!(!unstaged.changes[0].staged);

		// Stage, commit, and verify log
		git_stage(&repo, &["src/README.md".to_string()])
			.await
			.unwrap();
		git_commit(&repo, "Initial commit").await.unwrap();

		let commits = git_log(&repo, 5).await.unwrap();
		assert_eq!(commits.len(), 1);
		assert_eq!(commits[0].message, "Initial commit");
		assert_eq!(commits[0].author, "Fabric Tester");
		assert!(!commits[0].short_hash.is_empty());

		let _ = fs::remove_dir_all(&repo);
	}
}