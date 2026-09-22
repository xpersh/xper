# XP-013: Métricas, comparación e inspección

- Estado: `pending`
- Milestone: M4
- Dependencias: XP-007 y XP-012

## Objetivo

Convertir los eventos persistidos en información útil para comprender y
comparar runs sin exponer contenido sensible.

## Alcance

- Implementar las métricas de portada del RFC 0003.
- Añadir `xper status`, `xper metrics` y exportación estructurada.
- Mostrar timeline, attempts, fallos, rework, costes y camino crítico.
- Diferenciar wall-clock, active duration y agent time.
- Comparar únicamente runs marcados como equivalentes.
- Crear una primera vista Ratatui si mejora materialmente la inspección.

## Criterios de aceptación

- Las fórmulas están versionadas y probadas con fixtures.
- La ejecución paralela no infla el wall-clock.
- La falta de coste o tokens se representa como desconocida, no como cero.
- La salida evita prompts, código, secrets y contenido de tools por defecto.
- Fallar al proyectar métricas no altera el resultado del run.

## Fuera de alcance

- Dashboard web o servicio de telemetría remoto.
- Ranking universal de modelos con tareas no comparables.
