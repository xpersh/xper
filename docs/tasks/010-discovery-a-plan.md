# XP-010: Workflow desde Discovery hasta Plan

- Estado: `pending`
- Milestone: M3
- Dependencias: XP-008 y XP-009

## Objetivo

Extender la vertical slice con las fases de conocimiento previas a la
implementación sin convertirlas en un pipeline rígido.

## Alcance

- Discovery, Define, Design, Breakdown y Plan.
- Contratos de entrada, salida y artefactos mínimos por fase.
- Revisitas hacia la fase que originó la incertidumbre.
- Gates automáticos y solicitudes humanas configurables.
- Construcción de un DAG de assignments e incrementos.
- Presupuestos de intentos, tiempo, coste y concurrencia.

## Criterios de aceptación

- Cada fase puede probarse con adapters falsos.
- Un criterio ambiguo vuelve a Define y un diseño inviable vuelve a Design.
- Breakdown rechaza historias no verificables de forma independiente.
- Plan detecta dependencias y conflictos de workspace.
- Los artefactos, no la transcripción, forman el contrato entre fases.

## Fuera de alcance

- Escribir código, integrar worktrees o emitir el veredicto final.
