# XP-008: Primera vertical slice de extremo a extremo

- Estado: `pending`
- Milestone: M2
- Dependencias: XP-003, XP-004, XP-005, XP-006 y XP-007

## Objetivo

Demostrar la arquitectura completa con el flujo mínimo que aporta evidencia:
iniciar un run, delegar Discovery y avanzar a Define.

## Alcance

- Iniciar o reanudar un run desde una sesión Pi con `xper` activo.
- Crear un assignment `discovery.explorer`.
- Resolver y lanzar un subagente mediante el camino decidido en XP-001.
- Correlacionar lifecycle nativo con un Attempt de xper.
- Registrar un artefacto Discovery Brief mínimo.
- Evaluar el gate de Discovery y solicitar transición a Define.
- Mostrar estado desde `/xper status` y `xper status`.
- Persistir la secuencia completa en SQLite.

## Criterios de aceptación

- Existe un test end-to-end reproducible y una demo manual documentada.
- Éxito, fallo, cancelación y timeout terminan en estados distintos.
- Reiniciar el bridge permite recuperar el run.
- El core no contiene imports ni tipos de Pi.
- La transición no ocurre si falta la evidencia requerida.
- La timeline puede reconstruirse sólo desde eventos persistidos.

## Fuera de alcance

- Resto de fases, ejecución paralela y TUI avanzada.
- Routing adaptativo o comparación de perfiles.
