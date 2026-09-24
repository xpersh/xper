# XP-003: Kernel de dominio mínimo

- Estado: `done`
- Milestone: M1
- Dependencias: XP-002

## Objetivo

Implementar el núcleo puro necesario para representar un run y demostrar
transiciones deterministas sin depender de ningún harness.

## Alcance

- Tipos para Run, Phase Visit, Assignment, Attempt, Gate y Artifact Reference.
- Estados y resultados explícitos, incluidos cancelación y timeout.
- Transiciones mínimas `Intake -> Discovery -> Define`.
- Rechazo de transiciones inválidas con errores estables.
- Eventos de dominio producidos por cada cambio aceptado.
- Reloj e identificadores inyectables para tests deterministas.

## Criterios de aceptación

- Los tests cubren caminos válidos, inválidos, revisitas e idempotencia.
- El mismo input produce el mismo estado y los mismos eventos.
- Ningún tipo contiene IDs, eventos o modelos propios de Pi.
- No hay acceso a filesystem, red, procesos o base de datos.

## Fuera de alcance

- El workflow completo.
- Persistencia y serialización del protocolo.
- Ejecución real de agentes.

## Resultado

- Modelo de dominio neutral para runs, visitas de fase, assignments, attempts,
  gates y referencias versionadas de artefactos.
- Resultados terminales explícitos para éxito, fallo, cancelación y timeout.
- Transiciones deterministas `Intake -> Discovery -> Define` y revisita
  `Define -> Discovery`, con gates obligatorios y errores de código estable.
- Eventos identificados para cada cambio aceptado e idempotencia por request:
  un replay devuelve el mismo receipt sin consumir reloj ni IDs adicionales.
- Reloj e identificadores inyectables, sin dependencias externas ni acceso a
  filesystem, red, procesos o base de datos.
- Tests de aceptación para caminos válidos, rechazos sin efectos laterales,
  revisitas, conflictos idempotentes y reproducción exacta de estado/eventos.
