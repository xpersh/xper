# XP-009: Contexts, profiles y routing multimodelo

- Estado: `pending`
- Milestone: M3
- Dependencias: XP-006 y XP-008

## Objetivo

Resolver de forma determinista el modelo de cada rol sin mezclar identidades,
credenciales o fallbacks entre contexts.

## Alcance

- Implementar contexts, model presets, strategies, lanes y execution profiles.
- Resolver `profile + fase + rol -> provider/model/thinking`.
- Validar modelos y capabilities disponibles mediante el adapter.
- Persistir el snapshot efectivo del run y de cada attempt.
- Crear un nuevo attempt cuando se aplica un fallback.
- Añadir comandos de activación e inspección de profiles.

## Criterios de aceptación

- Configuraciones `work`, `personal` y `local-first` tienen tests aislados.
- Un fallback nunca cruza de context implícitamente.
- La resolución es explicable mediante `xper profile inspect --resolved`.
- El adapter recibe una selección neutral y la traduce al harness.
- Los runs históricos conservan provider, modelo y thinking exactos.

## Fuera de alcance

- Routing adaptativo aprendido automáticamente.
- Gestión o sincronización de API keys.
