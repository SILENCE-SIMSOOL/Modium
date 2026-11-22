export const ko = {
	common: {
		save: "저장",
		cancel: "취소",
		close: "닫기",
		confirm: "확인",
		delete: "삭제",
		rename: "이름 변경",
		refresh: "새로고침",
		create: "만들기",
		open: "열기",
		loading: "불러오는 중...",
		noProject: "열린 프로젝트가 없어요",
		readOnly: "읽기 전용",
		error: "오류",
		warning: "경고",
		info: "정보",
		clear: "지우기"
	},
	titlebar: {
		appName: "Modium",
		noProject: "프로젝트 선택",
		runClient: "클라이언트 실행",
		debugClient: "디버그",
		buildMod: "빌드",
		stop: "중지",
		syncGradle: "Gradle 동기화",
		toggleSidebar: "사이드바 전환 (Ctrl+B)",
		toggleBottom: "하단 패널 전환 (Ctrl+J)",
		settings: "설정",
		minimize: "최소화",
		maximize: "최대화/복원",
		close: "닫기",
		closeProject: "프로젝트 닫기"
	},
	welcome: {
		title: "Modium",
		subtitle: "마인크래프트 Fabric 모드 개발을 한 화면에서 깔끔하게 시작하세요.",
		newMod: "새 Fabric 모드",
		newModDesc: "26.3 또는 1.21.x 템플릿 생성",
		openProject: "프로젝트 열기",
		openProjectDesc: "로컬 모드 폴더 불러오기",
		toolSetup: "도구 설치",
		toolSetupDesc: "JDT LS · Java Debug 준비",
		jdkCheck: "JDK 확인",
		jdkCheckDesc: "설치된 Java 25/21 탐색",
		migration: "버전 마이그레이션",
		migrationDesc: "MC · Loom 버전 업그레이드",
		settings: "환경설정",
		settingsDesc: "언어 · 폰트 · JDK 설정",
		recentProjects: "최근 프로젝트",
		recentEmpty: "아직 최근에 연 프로젝트가 없어요. 새 모드를 만들거나 기존 폴더를 열어보세요.",
		jdkDetected: "감지된 JDK",
		jdkNone: "설치된 JDK를 찾지 못했어요. 설정에서 경로를 확인해 주세요.",
		openProjectFirst: "먼저 마이그레이션할 Fabric 프로젝트 폴더를 선택해 주세요."
	},
	explorer: {
		title: "탐색기",
		newFile: "새 파일",
		newFolder: "새 폴더",
		collapseAll: "모두 접기",
		revealInExplorer: "파일 탐색기에서 열기",
		fileNamePlaceholder: "파일 이름 (예: MyBlock.java)",
		folderNamePlaceholder: "폴더 이름",
		confirmDeleteTitle: "삭제 확인",
		confirmDeleteBody: "선택한 항목을 영구적으로 삭제할까요?",
		emptyDir: "빈 폴더"
	},
	search: {
		title: "전체 검색",
		placeholder: "워크스페이스에서 검색...",
		caseSensitive: "대소문자 구분",
		useRegex: "정규표현식"
	},
	mixins: {
		title: "Mixin 탐색기",
		empty: "등록된 Mixin이 없어요."
	},
	sources: {
		title: "마인크래프트 소스",
		placeholder: "클래스 또는 패키지 검색..."
	},
	metadata: {
		title: "메타데이터 편집기",
		visualMode: "시각적 편집",
		rawMode: "원본 JSON"
	},
	resources: {
		title: "리소스 미리보기",
		empty: "리소스 파일이 없어요."
	},
	debug: {
		title: "디버그",
		start: "디버그 시작",
		stop: "디버그 중지"
	},
	git: {
		title: "소스 제어",
		init: "Git 저장소 초기화"
	},
	wizard: {
		title: "새 Fabric 모드 만들기"
	},
	migration: {
		title: "Fabric 버전 마이그레이션"
	},
	settings: {
		title: "환경설정"
	},
	quickOpen: {
		title: "파일 빠른 열기"
	},
	bottom: {
		terminal: "터미널",
		build: "빌드 출력",
		problems: "문제",
		debugConsole: "디버그 콘솔",
		autoScroll: "자동 스크롤",
		restartTerminal: "터미널 재시작",
		terminalPlaceholder: "명령어를 입력하고 Enter...",
		debugEvalPlaceholder: "디버그 일시 중지 상태에서 식 평가...",
		noProblems: "표시할 빌드 또는 코드 문제가 없어요.",
		noBuildOutput: "Gradle 빌드 또는 실행 로그가 여기에 표시돼요.",
		noDebugLogs: "디버그 출력과 식 평가 결과가 여기에 표시돼요."
	},
	status: {
		noWorkspace: "워크스페이스 없음",
		lspIdle: "LSP 대기",
		lspStarting: "LSP 시작 중",
		lspReady: "JDT LS 준비됨",
		lspError: "LSP 오류",
		encoding: "UTF-8",
		tabSize: "공백",
		lineCol: "줄 {line}, 열 {col}"
	},
	editor: {
		emptyHint: "탐색기에서 파일을 선택하거나 빠른 열기를 사용하세요.",
		quickOpenShortcut: "파일 빠른 열기",
		toggleSidebarShortcut: "사이드바 전환",
		toggleBottomShortcut: "하단 패널 전환",
		saveShortcut: "현재 파일 저장",
		unsavedChanges: "저장되지 않은 변경사항",
		visualEditorBtn: "Mod 설정 UI",
		rawJsonBtn: "JSON 코드"
	}
};

export type TranslationDict = typeof ko;