# XP-006: Configuración, init y doctor

- Estado: `done`
- Milestone: M1
- Dependencias: XP-002 y XP-005

## Objetivo

Preparar y diagnosticar una instalación reproducible sin arrancar un workflow.

## Alcance

- Implementar scopes global, proyecto y local del proyecto.
- Definir merge, precedencia y validación de configuración.
- Implementar `xper init` y `xper init --global`.
- Implementar `xper doctor` y `xper doctor --json`.
- Detectar Pi, `pi-open-agents`, adapter, versiones y conflictos.
- Crear o reparar la definición del agente principal con confirmación.
- Mostrar el comando de instalación cuando falte una dependencia.
- Evitar instalación silenciosa en modo no interactivo.

## Criterios de aceptación

- `doctor` no modifica archivos ni paquetes.
- Los códigos `PASS`, `WARN` y `FAIL` tienen IDs estables.
- Falta de Pi o `pi-open-agents` produce una acción concreta.
- Ejecutar `init` dos veces es idempotente y preserva cambios del usuario.
- Ningún secret se escribe en configuración o logs.
- Existen fixtures para instalaciones válidas, parciales e incompatibles.

## Fuera de alcance

- Autenticar proveedores automáticamente.
- Ejecutar un run o elegir modelos adaptativamente.

## Resultado

- `xper-config` resuelve global, proyecto y local con merge de mapas, precedencia
  definida y validación de estructura y campos de credenciales.
- `xper init` y `xper init --global` crean configuración, fijan la dependencia
  probada en Pi y crean o reparan el agente principal con confirmación. Conservan
  archivos válidos y respaldan una definición reparada.
- `xper doctor` y `--json` emiten checks con IDs estables para Pi, dependencia,
  adapter, conflictos, agente y configuración sin escribir archivos.
- Fixtures y tests cubren instalaciones válidas, parciales e incompatibles,
  idempotencia, ausencia de escrituras en doctor y rechazo de credenciales.
