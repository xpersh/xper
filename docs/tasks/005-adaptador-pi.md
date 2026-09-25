# XP-005: Adaptador mínimo de Pi

- Estado: `done`
- Milestone: M1
- Dependencias: XP-001 y XP-004

## Objetivo

Conectar una sesión real de Pi al bridge sin introducir reglas de workflow en
la extensión TypeScript.

## Alcance

- Empaquetar la definición `xper` como agente `primary`.
- Iniciar y supervisar `xper bridge --stdio` durante la sesión.
- Implementar handshake y manifiesto de capacidades de Pi.
- Registrar `/xper status` y un indicador mínimo no intrusivo.
- Reenviar inicio, cierre y errores básicos de sesión.
- Cerrar el bridge al descargar la extensión o terminar Pi.
- Mostrar un error accionable si el binario no existe o es incompatible.

## Criterios de aceptación

- `pi --agent xper` inicia una sesión con el adaptador conectado.
- `/xper status` muestra versiones, adapter y estado del bridge.
- Una caída del bridge no bloquea ni corrompe la sesión de Pi.
- Reiniciar o recargar la extensión no duplica procesos huérfanos.
- La extensión no contiene decisiones de fases o gates.

## Fuera de alcance

- Delegar subagentes.
- Persistir runs.
- Construir la UI completa de xper.

## Resultado

- `.pi/agents/xper.md` declara el agente `primary` y la configuración de
  proyecto fija `pi-open-agents@0.1.22`.
- La extensión inicia el bridge en `session_start`, negocia capacidades y
  envía `session.attach`; en `session_shutdown` envía `session.detach` y espera
  el cierre del proceso. `/xper status` muestra versiones, PID y conexión; el
  indicador TUI es mínimo.
- Los errores de tools y compactación se envían como observaciones sin guardar
  resultados, prompts ni código. Si falta el binario o el bridge es
  incompatible, Pi sigue funcionando y muestra una acción concreta.
- Tests de proceso cubren handshake, lifecycle, reinicio, caída y errores de
  arranque. Un probe real en Pi `0.85.1` con `pi-open-agents@0.1.22` validó
  `pi --approve --agent xper`, `/xper status`, el handshake y el cierre sin proceso
  huérfano.
