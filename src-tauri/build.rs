fn main() {
	tauri_build::build();
	#[cfg(windows)]
	if let Ok(out_dir) = std::env::var("OUT_DIR") {
		let resource_lib = std::path::PathBuf::from(&out_dir).join("resource.lib");
		if resource_lib.exists() {
			println!("cargo:rustc-link-search=native={out_dir}");
		}
	}
}