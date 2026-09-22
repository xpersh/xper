# XP-001: Spike de integración con Pi y pi-open-agents

- Estado: `done`
- Milestone: M0
- Dependencias: ninguna

## Objetivo

Eliminar los riesgos desconocidos de la integración antes de diseñar código de
producción alrededor de APIs que pueden no existir o no ser estables.

## Alcance

- Crear una extensión mínima y desechable de Pi.
- Confirmar registro de comandos, tools, hooks y elementos de TUI.
- Confirmar que una extensión puede iniciar y cerrar un proceso hijo por
  `stdio` en macOS, Linux y Windows.
- Verificar qué eventos reciben las tools registradas por otras extensiones.
- Inspeccionar la API real de `pi-open-agents` y su estrategia de versiones.
- Probar activación de `xper` como agente `primary`.
- Probar una delegación y correlacionar inicio, resultado, error y cancelación.
- Determinar cómo detectar paquete, versión y scope efectivos.

## Entregables

- Informe corto con evidencia y versiones probadas.
- Matriz de capacidades disponibles y ausentes.
- Decisión sobre la integración con subagentes:
  API directa, mediación mediante tools/hooks o implementación alternativa.
- Lista de riesgos que pasan a XP-004, XP-005 y XP-006.

Resultado: [informe y decisión de XP-001](../spikes/001-integracion-pi.md).

## Criterios de aceptación

- Existe una prueba reproducible del lifecycle extensión–proceso hijo.
- Se conoce si `pi-open-agents` ofrece un contrato consumible por extensiones.
- Se sabe cómo observar o controlar una delegación sin parsear texto de UI.
- Se documenta un camino viable o un `NO-GO` con alternativa concreta.
- El código del spike está separado y puede eliminarse sin afectar al producto.

## Fuera de alcance

- Implementar workflow, persistencia o configuración definitiva.
- Elegir todas las crates o publicar paquetes.
