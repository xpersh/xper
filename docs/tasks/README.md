# Roadmap de implementación de xper

Este directorio convierte los RFC en un backlog ordenado. Las tareas describen
trabajo futuro; su existencia no implica que haya comenzado la implementación.

## Objetivo del primer hito

Validar una vertical slice completa:

```text
xper init
    -> pi --agent xper
    -> adapter Pi <-> xper bridge
    -> run iniciado
    -> assignment Discovery
    -> subagente ejecutado
    -> attempt settled
    -> transición a Define
    -> eventos en SQLite
    -> xper status
```

Hasta completar esta slice no se ampliará el workflow ni se construirá una TUI
de métricas completa.

## Orden y dependencias

| ID | Tarea | Depende de | Resultado principal |
| --- | --- | --- | --- |
| XP-001 | [Spike de integración con Pi](001-spike-integracion-pi.md) | — | Viabilidad y límites confirmados |
| XP-002 | [Scaffolding y quality gates](002-scaffolding-workspace.md) | XP-001 | Workspace Rust/TypeScript verificable |
| XP-003 | [Kernel de dominio mínimo](003-kernel-dominio.md) | XP-002 | Máquina de estados pura |
| XP-004 | [Protocolo y bridge](004-protocolo-bridge.md) | XP-002 | Handshake Rust/TypeScript |
| XP-005 | [Adaptador mínimo de Pi](005-adaptador-pi.md) | XP-001, XP-004 | Sesión Pi conectada al core |
| XP-006 | [Configuración, init y doctor](006-init-doctor.md) | XP-002, XP-005 | Preflight y configuración reproducible |
| XP-007 | [Event store SQLite](007-event-store.md) | XP-003 | Runs y attempts persistidos |
| XP-008 | [Primera vertical slice](008-vertical-slice.md) | XP-003–XP-007 | Discovery delegado de extremo a extremo |
| XP-009 | [Routing multimodelo](009-routing-multimodelo.md) | XP-006, XP-008 | Profiles y contexts efectivos |
| XP-010 | [Discovery a Plan](010-discovery-a-plan.md) | XP-008, XP-009 | Primera mitad del workflow XP |
| XP-011 | [Implementation y Verify](011-implementation-verify.md) | XP-010 | Loop de entrega y verificación |
| XP-012 | [Judgment Day y cierre](012-judgment-day.md) | XP-011 | Veredicto, rework y aprendizaje |
| XP-013 | [Métricas e inspección](013-metricas-inspeccion.md) | XP-007, XP-012 | Comparación de runs desde CLI/TUI |
| XP-014 | [Packaging y compatibilidad](014-packaging-compatibilidad.md) | XP-006, XP-012, XP-013 | Distribución multiplataforma |

XP-003 y XP-004 pueden avanzar en paralelo después de XP-002. XP-006 y XP-007
también pueden solaparse una vez estabilizados sus contratos.

## Milestones

### M0 — Riesgos despejados

- XP-001

### M1 — Fundaciones ejecutables

- XP-002 a XP-007

### M2 — Vertical slice validada

- XP-008

### M3 — Workflow y routing completos

- XP-009 a XP-012

### M4 — Producto distribuible

- XP-013 y XP-014

## Reglas para ejecutar una tarea

Una tarea está `ready` cuando:

- Sus dependencias están aceptadas.
- No contiene una decisión de producto sin resolver.
- Tiene un criterio observable de finalización.
- Puede completarse sin introducir una segunda arquitectura paralela.

Una tarea está `done` cuando:

- Cumple todos sus criterios de aceptación.
- Sus tests se escribieron junto con el comportamiento.
- Los contratos, schemas y decisiones modificados están documentados.
- No introduce dependencias de un harness en `xper-domain` o
  `xper-application`.
- Los errores tienen diagnóstico accionable.
- No almacena credenciales, prompts o código de usuario por defecto.

## Estados

Cada tarea comienza como `pending` y puede pasar por:

```text
pending -> ready -> in_progress -> review -> done
                    \-> blocked
```

El estado se actualizará en el archivo de la tarea cuando se empiece a
trabajar. No se marcará `done` sólo porque exista scaffolding o una demo manual.
