# Modium

Rust와 Tauri 2 기반으로 제작한 **Minecraft Fabric 모딩 전용 경량 데스크톱 IDE**입니다.
별도의 범용 IDE 없이 Fabric 모드 프로젝트 생성부터 코드 편집, Gradle 빌드·실행, 디버깅, Mixin·리소스 검사까지 하나의 앱에서 처리할 수 있습니다.

## 주요 기능

- **Fabric 프로젝트 생성 및 마이그레이션**
  - Fabric Meta / Maven API를 통한 최신 버전 자동 조회
  - Minecraft `26.1+` 비난독화(`net.fabricmc.fabric-loom`, Java 25) 및 `1.21.x` 레거시 리맵(`net.fabricmc.fabric-loom-remap`, Java 21) 템플릿 지원
  - 대상 Minecraft 버전에 맞춘 `gradle.properties`, `build.gradle.kts`, `fabric.mod.json`, Mixin 설정 자동 마이그레이션 및 미리보기
- **코드 편집 및 Java 언어 지원**
  - Monaco Editor 기반 다중 탭 편집, 구문 강조(Java, JSON, Kotlin DSL, XML, YAML, TOML, Markdown), 빠른 파일 열기(`Ctrl+P`), 워크스페이스 전체 검색(`Ctrl+Shift+F`)
  - Eclipse JDT LS 자동 설치 및 연동(자동 완성, Hover, 정의 이동, 참조 검색, 심볼 이름 변경, 코드 액션, import 정리, 포맷팅, 실시간 진단)
- **Gradle 빌드·실행 및 Java 디버깅**
  - `build`, `runClient`, `runServer`, `genSources`, `clean`, `--refresh-dependencies` 실행 및 실시간 로그 스트리밍
  - 컴파일 오류 파싱 및 에디터 줄 이동, Windows 자식 프로세스 트리 안전 종료
  - Microsoft Java Debug Server(DAP) 연동: 중단점, Step Over/Into/Out, 호출 스택, 지역 변수 조회, 식 평가
- **Fabric 전용 개발 도구**
  - **Mixin 탐색기**: `fabric.mod.json` 및 `*.mixins.json` 기반 `@Mixin`/`@Inject`/`@Redirect`/`@Shadow` 분석 및 누락 검증
  - **Minecraft 소스 탐색기**: Loom 소스 JAR 및 `jdt://` 클래스 소스 읽기 전용 열람
  - **메타데이터 편집기**: `fabric.mod.json` 폼 편집 및 원본 JSON 전환
  - **리소스 미리보기**: PNG 텍스처 픽셀 확대 미리보기 및 JSON 검증
  - **Git 통합 & 내장 터미널**: 변경 내역 확인, 스테이지/언스테이지, Diff, 커밋 및 워크스페이스 터미널
- **다국어 & 테마**
  - 한국어(`ko`), English(`en`), 中文(`zh`), 日本語(`ja`) 지원
  - 시스템 / 라이트 / 다크 테마 및 Monaco Editor 테마 실시간 동기화

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| 데스크톱 셸 | Tauri 2 |
| 백엔드 | Rust, Tokio, reqwest, notify, serde, zip/tar/flate2 |
| 프론트엔드 | React 19, TypeScript, Vite |
| 코드 편집기 | Monaco Editor |
| Java LSP / DAP | Eclipse JDT LS, Microsoft Java Debug Server |

## 사전 요구 사항

- [Rust](https://www.rust-lang.org/) (MSVC 툴체인, Windows 10/11 WebView2)
- [Node.js](https://nodejs.org/) 및 [pnpm](https://pnpm.io/)
- JDK 21 이상 (Minecraft `26.x` 모드 개발 시 JDK 25 권장)
- Git (선택, 소스 제어 기능 사용 시)

## 개발 및 빌드

```powershell
# 의존성 설치
pnpm install

# 개발 모드 실행 (Vite + Tauri)
pnpm tauri dev

# 프론트엔드 단위 테스트 및 빌드 확인
pnpm test
pnpm build

# Rust 정적 분석 및 단위 테스트
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test
```

### 배포 빌드

```powershell
# 설치 프로그램 포함 정식 빌드 (NSIS / MSI)
pnpm tauri build

# 단일 실행 파일(.exe)만 빌드
pnpm tauri build --no-bundle
```

빌드 산출물 위치:
- 실행 파일: `src-tauri/target/release/modium.exe`
- 설치 파일: `src-tauri/target/release/bundle/nsis/`, `src-tauri/target/release/bundle/msi/`

## 프로젝트 구조

```text
├── src/
│   ├── components/         # 타이틀바, 탐색기, 에디터, 하단 패널, 모달, Fabric 전용 패널
│   ├── i18n/               # ko, en, zh, ja 다국어 사전
│   ├── services/           # Tauri IPC, Monaco 설정, LSP 브리지
│   ├── state/              # 전역 워크스페이스·에디터·디버그 상태 관리
│   └── styles/             # 라이트/다크 디자인 토큰 및 레이아웃 스타일
├── src-tauri/
│   └── src/                # Rust 백엔드 (fabric, gradle, lsp, debug, filesystem, git, jdk 등)
└── tests/                  # 프론트엔드 테스트
```

## 라이선스

[MIT License](LICENSE)