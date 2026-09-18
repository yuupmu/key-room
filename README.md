# Keyroom · 밴드 키보드 연습실

MP3/WAV 원곡과 MIDI를 함께 재생하고 편집하는 해커톤 웹 앱입니다. 현재 기능은 브라우저에서 동작하며, 불러온 음악 파일은 서버에 업로드되지 않습니다.

## 요구 사항

- Node.js 20 이상
- npm

외부 패키지 의존성은 없습니다.

## VS Code에서 실행

1. 이 폴더를 VS Code로 엽니다.
2. 터미널에서 `npm run dev`를 실행합니다.
3. `http://127.0.0.1:3000`을 엽니다.

VS Code의 **실행 및 디버그 → Keyroom 개발 서버 → F5**로도 실행할 수 있습니다. `src/client`의 HTML, CSS, JavaScript를 수정한 뒤 브라우저를 새로고침하면 반영됩니다.

```bash
npm run dev      # 원본 프런트엔드를 제공하는 개발 서버
npm run check    # JavaScript 문법 확인
npm run build    # src/client → dist 복사
npm start        # 빌드된 dist를 제공하는 서버
```

`PORT`와 `HOST` 환경 변수로 로컬 서버 주소를 변경할 수 있습니다. `GET /health`는 서버 상태를 JSON으로 반환합니다.

## 프로젝트 구조

```text
src/client/
  index.html      화면 구조
  styles.css      화면 스타일
  app.js          업로드, 재생, MIDI 파싱·편집, 시각화
server/
  index.js        개발/배포용 정적 파일 서버
scripts/
  build.mjs       배포 파일 생성
dist/             npm run build로 생성, Git에서는 제외
.vscode/
  launch.json     VS Code F5 실행 설정
.openai/
  hosting.example.json  선택적 호스팅 설정 예시
package.json      실행 명령과 Node 버전
```

실제 배포용 `.openai/hosting.json`은 Git에서 제외하고, 공개 저장소에는 `hosting.example.json`만 포함합니다.

## 현재 기능

- MP3/WAV와 MIDI(.mid/.midi) 파일 클릭·드래그 추가 및 동시 재생
- 재생 위치, 속도, 트랙별 음소거
- 오디오 시작 부분 건너뛰기로 MIDI와 싱크 맞추기
- MIDI 음표 추가·수정·삭제, 실행 취소, 전체 반음 조옮김, MIDI 다운로드
- 팝업의 낙하 노트·음명 피아노롤

오디오 자르기는 앱의 재생 시작점에만 적용됩니다. 원본 오디오 파일은 바뀌지 않습니다. MIDI 소리는 브라우저의 간단한 신시사이저로 재생합니다. 자료 검색, 악보 변환·표시, 전자피아노 입력은 아직 구현되지 않았습니다.

MIDI 형식 0/1을 지원합니다. SMPTE 시간 형식과 형식 2는 지원하지 않습니다. 왼손/오른손은 MIDI 트랙의 평균 음역으로 추정합니다.
