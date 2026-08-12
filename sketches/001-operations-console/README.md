## Variant: Operations Console

> **Disposition: retained design reference.** Its dark, dense operations-console
> tone was adopted for Fleet's dark theme. This sketch is not production code,
> is not imported at runtime, and is excluded from the npm package.

### Design stance

Power-user 운영 화면처럼 상태, drift, 배포 여부를 최대한 빠르게 스캔한다.

### Key choices

- Layout: 고정 사이드바 + 밀도 높은 표 + 우측 상태 패널
- Typography: 시스템 산세리프, 작은 운영 정보
- Color: 다크 네이비 + teal 안전 상태
- Interaction: 검색, 종류 필터, 상세 drawer, toast

### Trade-offs

- Strong at: 많은 capability 관리, 운영 상태 확인, 반복 업무
- Weak at: 처음 접하는 사용자에게 다소 복잡하고 차가움

### Best for

- 매일 fleet을 운영하는 파워 유저
