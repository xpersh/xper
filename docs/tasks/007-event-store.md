# XP-007: Event store y proyecciones mínimas en SQLite

- Estado: `done`
- Milestone: M1
- Dependencias: XP-003

## Objetivo

Persistir el estado neutral de xper y reconstruir runs sin depender de la
transcripción ni de IDs nativos del harness.

## Alcance

- Crear migraciones versionadas para `events`, `runs`, `phase_visits`,
  `assignments` y `attempts`.
- Implementar append idempotente y transacciones por boundary.
- Proyectar estado actual de un run.
- Registrar adapter, versión y capabilities como metadata.
- Recuperar attempts iniciados sin evento final como `interrupted`.
- Definir comportamiento degradado si SQLite no está disponible.

## Criterios de aceptación

- Reproducir eventos reconstruye el mismo estado de dominio.
- Reinsertar un `event_id` no duplica efectos.
- Un crash simulado no produce un attempt falsamente exitoso.
- No se almacenan prompts, código ni argumentos de tools por defecto.
- El esquema no contiene tablas acopladas a Pi.

## Fuera de alcance

- Todas las proyecciones de la GUI.
- Retención, compactación u OpenTelemetry.

## Implementación

- `xper-application::events` define el port, el vocabulario cerrado de eventos
  y una proyección determinista. La conversión de eventos del dominio omite el
  texto del objetivo, evidencia y razones libres para no persistir prompts.
- `xper-store-sqlite` guarda el log y reconstruye las cinco tablas mediante una
  migración versionada. `append_boundary` inserta eventos y actualiza las
  proyecciones en una sola transacción; un `event_id` repetido con contenido
  distinto produce conflicto.
- `open` reconstruye las proyecciones y añade eventos `attempt.interrupted`
  para intentos sin cierre. Se asume un único coordinador escritor por base.
  `open_or_volatile` usa SQLite en memoria y expone el motivo de degradación
  cuando falla la base persistente.
