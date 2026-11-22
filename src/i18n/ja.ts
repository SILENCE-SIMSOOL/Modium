import type { TranslationDict } from "./ko";

export const ja: TranslationDict = {
	common: {
		save: "保存",
		cancel: "キャンセル",
		close: "閉じる",
		confirm: "確認",
		delete: "削除",
		rename: "名前変更",
		refresh: "更新",
		create: "作成",
		open: "開く",
		loading: "読み込み中...",
		noProject: "プロジェクトが開かれていません",
		readOnly: "読み取り専用",
		error: "エラー",
		warning: "警告",
		info: "情報",
		clear: "クリア"
	},
	titlebar: {
		appName: "Modium",
		noProject: "プロジェクトを開く",
		runClient: "クライアント実行",
		debugClient: "デバッグ",
		buildMod: "ビルド",
		stop: "停止",
		syncGradle: "Gradle 同期",
		toggleSidebar: "サイドバー切替 (Ctrl+B)",
		toggleBottom: "下部パネル切替 (Ctrl+J)",
		settings: "設定",
		minimize: "最小化",
		maximize: "最大化 / 元に戻す",
		close: "閉じる",
		closeProject: "プロジェクトを閉じる"
	},
	welcome: {
		title: "Modium",
		subtitle: "Minecraft Fabric Mod の開発・解析・デバッグをひとつのワークスペースで。",
		newMod: "新規 Fabric Mod",
		newModDesc: "26.3 または 1.21.x テンプレート作成",
		openProject: "プロジェクトを開く",
		openProjectDesc: "ローカルの Mod フォルダを読み込む",
		toolSetup: "ツール設定",
		toolSetupDesc: "JDT LS・Java Debug を準備",
		jdkCheck: "JDK 確認",
		jdkCheckDesc: "インストール済み Java 25/21 を検出",
		migration: "バージョン移行",
		migrationDesc: "MC・Loom バージョンをアップグレード",
		settings: "環境設定",
		settingsDesc: "言語・テーマ・フォント・JDK",
		recentProjects: "最近のプロジェクト",
		recentEmpty: "最近開いたプロジェクトはありません。新規 Mod を作成するかフォルダを開いてください。",
		jdkDetected: "検出された JDK",
		jdkNone: "インストール済みの JDK が見つかりませんでした。設定でパスを確認してください。",
		openProjectFirst: "移行する Fabric プロジェクトフォルダを先に選択してください。"
	},
	explorer: {
		title: "エクスプローラー",
		newFile: "新しいファイル",
		newFolder: "新しいフォルダ",
		collapseAll: "すべて折りたたむ",
		revealInExplorer: "エクスプローラーで表示",
		fileNamePlaceholder: "ファイル名 (例: MyBlock.java)",
		folderNamePlaceholder: "フォルダ名",
		confirmDeleteTitle: "削除の確認",
		confirmDeleteBody: "選択した項目を完全に削除しますか？",
		emptyDir: "空のフォルダ"
	},
	search: {
		title: "全体検索",
		placeholder: "ワークスペース内を検索...",
		caseSensitive: "大文字・小文字を区別",
		useRegex: "正規表現"
	},
	mixins: {
		title: "Mixin エクスプローラー",
		empty: "Mixin クラスが見つかりません。"
	},
	sources: {
		title: "Minecraft ソース",
		placeholder: "クラスまたはパッケージを検索..."
	},
	metadata: {
		title: "メタデータエディタ",
		visualMode: "ビジュアル編集",
		rawMode: "生 JSON"
	},
	resources: {
		title: "リソースプレビュー",
		empty: "リソースファイルが見つかりません。"
	},
	debug: {
		title: "デバッグ",
		start: "デバッグ開始",
		stop: "デバッグ停止"
	},
	git: {
		title: "ソース管理",
		init: "Git リポジトリを初期化"
	},
	wizard: {
		title: "新規 Fabric Mod を作成"
	},
	migration: {
		title: "Fabric バージョン移行"
	},
	settings: {
		title: "環境設定"
	},
	quickOpen: {
		title: "クイックオープン"
	},
	bottom: {
		terminal: "ターミナル",
		build: "ビルド出力",
		problems: "問題",
		debugConsole: "デバッグコンソール",
		autoScroll: "自動スクロール",
		restartTerminal: "ターミナル再起動",
		terminalPlaceholder: "コマンドを入力して Enter...",
		debugEvalPlaceholder: "一時停止中に式を評価...",
		noProblems: "ビルドやコードの問題はありません。",
		noBuildOutput: "Gradle のビルド・実行ログがここに表示されます。",
		noDebugLogs: "デバッグ出力と式の評価結果がここに表示されます。"
	},
	status: {
		noWorkspace: "ワークスペースなし",
		lspIdle: "LSP 待機中",
		lspStarting: "LSP 起動中",
		lspReady: "JDT LS 準備完了",
		lspError: "LSP エラー",
		encoding: "UTF-8",
		tabSize: "タブ",
		lineCol: "行 {line}, 列 {col}"
	},
	editor: {
		emptyHint: "エクスプローラーからファイルを選ぶかクイックオープンを使ってください。",
		quickOpenShortcut: "クイックオープン",
		toggleSidebarShortcut: "サイドバー切替",
		toggleBottomShortcut: "下部パネル切替",
		saveShortcut: "ファイルを保存",
		unsavedChanges: "未保存の変更",
		visualEditorBtn: "Mod メタデータ UI",
		rawJsonBtn: "生 JSON"
	}
};