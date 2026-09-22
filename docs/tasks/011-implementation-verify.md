# XP-011: Loop Implementation–Verify

- Estado: `pending`
- Milestone: M3
- Dependencias: XP-010

## Objetivo

Implementar incrementos pequeños mediante Driver/Navigator y obtener evidencia
independiente antes de presentarlos a Judgment Day.

## Alcance

- Materializar Driver y Navigator con responsabilidades separadas.
- Gestionar incrementos, attempts y rotación configurable de roles.
- Crear workspaces aislados para trabajo concurrente.
- Registrar tests, commits, decisiones locales y evidencia de integración.
- Ejecutar Verify con un agente distinto del implementador.
- Volver a Implementation, Design o Define según la causa del fallo.
- Limitar rework y escalada humana.

## Criterios de aceptación

- Un incremento sólo avanza con tests locales y criterios evidenciados.
- Verifier no modifica el código que evalúa.
- Dos agentes no escriben simultáneamente sobre el mismo workspace.
- Cancelar o agotar un budget deja estado recuperable.
- El motivo de cada loop de rework queda estructurado y medible.

## Fuera de alcance

- Publicar cambios o aceptar deuda automáticamente.
- Optimización avanzada de scheduling.
