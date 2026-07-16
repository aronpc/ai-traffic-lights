<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# docs/

## Purpose
Documentação de arquitetura / design do produto. Complementa os `AGENTS.md` (que são orientados a "onde mexer") com a visão de sistema.

## Key Files
| File | Description |
|------|-------------|
| `ARCHITECTURE.md` | Visão de arquitetura do ai-traffic-lights — camadas (hooks/adapters → state files → main → renderer), fluxo de eventos, modelo de estados do semáforo. **Ler antes de mudanças estruturais.** |

## For AI Agents
- Para "onde mexer e por quê", use os `AGENTS.md` hierárquicos. Para o *big picture* e rationale de design, leia `ARCHITECTURE.md`.
- Mantenha `ARCHITECTURE.md` alinhado ao mudar a separação de camadas ou o contrato de state file.

<!-- MANUAL: -->
