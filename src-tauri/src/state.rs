use std::any::Any;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::Instant;

use crate::models::{AppSettings, FabricVersionCatalog};

pub struct AppState {
	pub workspace_root: RwLock<Option<PathBuf>>,
	pub settings: RwLock<AppSettings>,
	pub fabric_cache: Mutex<Option<(Instant, FabricVersionCatalog)>>,
	pub watcher_handle: Mutex<Option<Box<dyn Any + Send>>>,
}

impl AppState {
	pub fn new(settings: AppSettings) -> Self {
		Self {
			workspace_root: RwLock::new(None),
			settings: RwLock::new(settings),
			fabric_cache: Mutex::new(None),
			watcher_handle: Mutex::new(None),
		}
	}
}

impl Default for AppState {
	fn default() -> Self {
		Self::new(AppSettings::default())
	}
}