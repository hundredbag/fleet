## Variant: Capability Map

> **Disposition: retained design reference.** Its light Capability Map direction
> and cross-agent overview were adopted for Fleet's default Overview. This
> sketch is not production code, is not imported at runtime, and is excluded
> from the npm package.

### Design stance

제품명 fleet에 맞춰 capability가 에이전트들에 어떻게 배포됐는지 시각적으로 보여준다.

### Key choices

- Layout: capability × agent deployment map
- Typography: 밝고 중립적인 관리 도구
- Color: white/soft gray + teal
- Interaction: 종류 필터, sync preview modal, toast

### Trade-offs

- Strong at: 에이전트 간 차이, 누락, 정렬 상태를 즉시 이해
- Weak at: 에이전트 수가 많아지면 가로 확장 문제가 생김

### Best for

- cross-agent sync가 제품의 중심 가치일 때
