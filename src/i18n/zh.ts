import type { TranslationDict } from "./ko";

export const zh: TranslationDict = {
	common: {
		save: "保存",
		cancel: "取消",
		close: "关闭",
		confirm: "确认",
		delete: "删除",
		rename: "重命名",
		refresh: "刷新",
		create: "创建",
		open: "打开",
		loading: "加载中...",
		noProject: "未打开项目",
		readOnly: "只读",
		error: "错误",
		warning: "警告",
		info: "信息",
		clear: "清除"
	},
	titlebar: {
		appName: "Modium",
		noProject: "打开项目",
		runClient: "运行客户端",
		debugClient: "调试",
		buildMod: "构建",
		stop: "停止",
		syncGradle: "同步 Gradle",
		toggleSidebar: "切换侧边栏 (Ctrl+B)",
		toggleBottom: "切换底部面板 (Ctrl+J)",
		settings: "设置",
		minimize: "最小化",
		maximize: "最大化 / 还原",
		close: "关闭",
		closeProject: "关闭项目"
	},
	welcome: {
		title: "Modium",
		subtitle: "在一个简洁的工作区中构建、检查和调试 Minecraft Fabric 模组。",
		newMod: "新建 Fabric 模组",
		newModDesc: "创建 26.3 或 1.21.x 模板",
		openProject: "打开项目",
		openProjectDesc: "加载本地模组文件夹",
		toolSetup: "安装工具",
		toolSetupDesc: "准备 JDT LS 与 Java Debug",
		jdkCheck: "检查 JDK",
		jdkCheckDesc: "检测已安装的 Java 25/21",
		migration: "版本迁移",
		migrationDesc: "升级 MC 与 Loom 版本",
		settings: "设置",
		settingsDesc: "语言、主题、字体与 JDK",
		recentProjects: "最近的项目",
		recentEmpty: "暂无最近打开的项目。请新建 Fabric 模组或打开现有文件夹。",
		jdkDetected: "已检测到 JDK",
		jdkNone: "未找到已安装的 JDK。请在设置中检查路径。",
		openProjectFirst: "请先选择要迁移的 Fabric 项目文件夹。"
	},
	explorer: {
		title: "资源管理器",
		newFile: "新建文件",
		newFolder: "新建文件夹",
		collapseAll: "全部折叠",
		revealInExplorer: "在文件资源管理器中显示",
		fileNamePlaceholder: "文件名 (例如: MyBlock.java)",
		folderNamePlaceholder: "文件夹名称",
		confirmDeleteTitle: "确认删除",
		confirmDeleteBody: "确定要永久删除所选项目吗？",
		emptyDir: "空文件夹"
	},
	search: {
		title: "全局搜索",
		placeholder: "在工作区中搜索...",
		caseSensitive: "区分大小写",
		useRegex: "正则表达式"
	},
	mixins: {
		title: "Mixin 浏览器",
		empty: "未找到 Mixin 类。"
	},
	sources: {
		title: "Minecraft 源码",
		placeholder: "搜索类或包..."
	},
	metadata: {
		title: "元数据编辑器",
		visualMode: "可视化编辑",
		rawMode: "原始 JSON"
	},
	resources: {
		title: "资源预览",
		empty: "未找到资源文件。"
	},
	debug: {
		title: "调试",
		start: "开始调试",
		stop: "停止调试"
	},
	git: {
		title: "源代码管理",
		init: "初始化 Git 仓库"
	},
	wizard: {
		title: "创建新的 Fabric 模组"
	},
	migration: {
		title: "Fabric 版本迁移"
	},
	settings: {
		title: "设置"
	},
	quickOpen: {
		title: "快速打开"
	},
	bottom: {
		terminal: "终端",
		build: "构建输出",
		problems: "问题",
		debugConsole: "调试控制台",
		autoScroll: "自动滚动",
		restartTerminal: "重启终端",
		terminalPlaceholder: "输入命令并按 Enter...",
		debugEvalPlaceholder: "在暂停时计算表达式...",
		noProblems: "没有构建或代码问题。",
		noBuildOutput: "Gradle 构建和运行输出将显示在此处。",
		noDebugLogs: "调试控制台输出和求值结果将显示在此处。"
	},
	status: {
		noWorkspace: "无工作区",
		lspIdle: "LSP 空闲",
		lspStarting: "LSP 启动中",
		lspReady: "JDT LS 已就绪",
		lspError: "LSP 错误",
		encoding: "UTF-8",
		tabSize: "制表符",
		lineCol: "行 {line}, 列 {col}"
	},
	editor: {
		emptyHint: "请从资源管理器选择文件或使用快速打开。",
		quickOpenShortcut: "快速打开",
		toggleSidebarShortcut: "切换侧边栏",
		toggleBottomShortcut: "切换底部面板",
		saveShortcut: "保存文件",
		unsavedChanges: "未保存的更改",
		visualEditorBtn: "Mod 元数据 UI",
		rawJsonBtn: "原始 JSON"
	}
};