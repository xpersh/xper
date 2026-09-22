# XP-014: Packaging, compatibilidad y release inicial

- Estado: `pending`
- Milestone: M4
- Dependencias: XP-006, XP-012 y XP-013

## Objetivo

Distribuir xper de forma reproducible en macOS, Linux y Windows, incluyendo el
binario Rust y el adaptador TypeScript de Pi.

## Alcance

- Definir packaging conjunto o coordinado de CLI, bridge y adapter.
- Producir binarios para arquitecturas soportadas.
- Fijar matriz de Pi y `pi-open-agents` probada.
- Validar instalación global y de proyecto.
- Implementar upgrades, rollback y diagnóstico de versiones incompatibles.
- Ejecutar smoke tests multiplataforma.
- Publicar checksums, changelog y notas de seguridad.

## Criterios de aceptación

- Una instalación limpia completa `xper doctor` en cada plataforma soportada.
- El adapter localiza el binario sin rutas específicas de una máquina.
- Una incompatibilidad falla antes de iniciar un run.
- Desinstalar xper no elimina configuración, métricas o credenciales de Pi.
- Los artefactos de release son reproducibles y están identificados por versión.

## Fuera de alcance

- Adaptadores de OpenCode, Claude Code o Codex.
- Autoactualización sin consentimiento.
